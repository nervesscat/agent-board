import { execFile, execFileSync, spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { db, schema } from '#/db'
import { LEASE_TTL_MINUTES } from '#/lib/constants'
import { RESUME_PRESETS, resumeCommandName } from '#/lib/resume'
import {
  assemble,
  chooseModelEffort,
  commandLine,
  isTemplateId,
  templateList,
  type TemplateId,
} from '#/lib/resumeTemplates'
import { isBoardRecord } from '#/lib/roles'
import { listActors } from './actors'
import { postNotice } from './agentCards'
import { logActivity } from './activity'
import { WAIT_NOTE, hasWaiter, ticketHasWaiter } from './answerWait'
import { config, logsDir } from './config'
import { resolveTool } from './hostTools'
import { HttpError, notFound } from './http'
import { ticketRepo } from './repos'
import { worktreeEnv } from './runs'
import { firstOfKind, kindOf, listStages, movePatch, projectWorkStage, reopenPatch } from './stages'
import { noteStageMove } from './workTimeline'

/**
 * Resume: the board continues a ticket's work itself. An agent that asked a question has ended its turn,
 * so once the human answers the decision card on the board, or moves the ticket from a blocked or review
 * stage back to an active one, the board runs the project's resume command (the human's setting) on its
 * own machine, in the ticket's worktree, with a prompt it builds itself.
 *
 * The prompt reaches the command on its standard input and in a file (`BOARD_RESUME_PROMPT_FILE`), and the
 * command's environment carries the ids; neither is ever put into the command line. The free-text command is
 * what the human wrote, run through the machine's shell. A template is the board's own program and arguments
 * (src/lib/resumeTemplates.ts), where only the model and the effort vary per run, from enums. Nothing else
 * (not an agent, not a card's text) writes any part of either.
 *
 * One row per attempt (`ticket_resumes`), so the ticket page and a restarted board know what happened:
 * a ticket has at most one running resume; a trigger that starts nothing leaves a skipped row saying why
 * (resuming off, a resume already running, a live agent, an agent waiting for that very answer).
 * The process is detached and is not killed when the board stops; a board that starts again closes the
 * rows whose process is gone and goes on watching, and timing out, the ones still running.
 *
 * Failure (the command did not start, exited non-zero, or ran past the timeout) shows on the ticket and
 * in the notification center, a reply under the card says so, and the ticket goes back to blocked. Retry
 * starts one new run.
 */

export type ResumeTrigger = schema.TicketResume['trigger']
export type ResumeState = schema.TicketResume['state']

const WIN = process.platform === 'win32'
/** The board's name in replies and notices. */
const BOARD = 'board'
/** Signals within this long of the question are the agent finishing its turn, not an agent still working. */
const WIND_DOWN_MS = 30_000
const POLL_MS = 5_000
const TAIL_LINES = 30
const WORDS_MAX = 4_000

// --- the process: real by default, a test's own in the tests ---

export interface ResumeProc {
  pid: number | undefined
  /** Resolves with the exit code (null when it was killed or could not start). */
  exited: Promise<number | null>
}

export interface ResumeRunner {
  /** Starts `command` through the shell, its output appended to `log` and `stdin` written to it. */
  spawn(opts: {
    /** The command line: run through the shell (a free-text command, or a template's line on Windows). */
    command: string
    /** A template's program and arguments, run without a shell where the OS allows (POSIX). */
    argv?: { binary: string; args: string[] }
    cwd: string
    env: NodeJS.ProcessEnv
    log: string
    stdin: string
  }): ResumeProc
  /** Kills a process and everything it started. */
  killTree(pid: number): Promise<void>
  alive(pid: number): boolean
  /**
   * The process's start time as the OS reports it, to tell it from a later process that got the same
   * pid; null where the OS gives none (or the process is gone).
   */
  identity(pid: number): string | null
}

/** Field 22 of `/proc/<pid>/stat` (Linux); the name in field 2 may hold spaces and brackets, so count after its `)`. */
export function procStartTime(stat: string): string | null {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return rest[19] || null
}

/** The start time of a process as the OS reports it; null where it cannot be read (Windows, a gone process). */
export function processIdentity(pid: number): string | null {
  try {
    if (process.platform === 'linux') return procStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (WIN) return null
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

const realRunner: ResumeRunner = {
  spawn({ command, argv, cwd, env, log, stdin }) {
    const fd = fs.openSync(log, 'a')
    // Its own process group off Windows, so the whole tree can be killed; the board stopping leaves it be.
    const options = {
      cwd,
      env,
      stdio: ['pipe', fd, fd] as ['pipe', number, number],
      windowsHide: true,
      detached: !WIN,
    }
    const child =
      argv && !WIN
        ? nodeSpawn(argv.binary, argv.args, { ...options, shell: false })
        : nodeSpawn(command, { ...options, shell: true })
    fs.closeSync(fd)
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
    child.unref()
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
      child.once('error', (err) => {
        fs.appendFileSync(log, `\n${err.message}\n`)
        resolve(null)
      })
    })
    return { pid: child.pid, exited }
  },
  killTree: (pid) =>
    new Promise((resolve) => {
      if (WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
        resolve()
      }
    }),
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  identity: processIdentity,
}

/** False when the row's pid now belongs to another process (a recycled pid): never ours to watch or kill. */
function isOurs(row: schema.TicketResume): boolean {
  if (!row.pid) return false
  if (!row.pidIdentity) return true
  const now = runner.identity(row.pid)
  return now === null || now === row.pidIdentity
}

let runner: ResumeRunner = realRunner
/** Tests run against their own; `null` puts the real one back. */
export function setResumeRunner(r: ResumeRunner | null) {
  runner = r ?? realRunner
}

/** The timers watching running resumes, by row, so a stop (or a test's end) leaves none behind. */
const watching = new Map<number, ReturnType<typeof setTimeout>[]>()

function unwatch(rowId: number) {
  for (const t of watching.get(rowId) ?? []) clearTimeout(t)
  watching.delete(rowId)
}

/** Stops watching every running resume (the processes go on). */
export function stopWatching() {
  for (const id of watching.keys()) unwatch(id)
}

// --- reads ---

const logPathOf = (rowId: number) => path.join(logsDir, 'resumes', `${rowId}.log`)
const promptPathOf = (rowId: number) => path.join(logsDir, 'resumes', `${rowId}.prompt.md`)

/** The last lines of a resume's log. */
export function resumeLogTail(row: Pick<schema.TicketResume, 'logPath'>, lines = TAIL_LINES): string[] {
  if (!row.logPath) return []
  try {
    const fd = fs.openSync(row.logPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const take = Math.min(size, 16_384)
      const buf = Buffer.alloc(take)
      fs.readSync(fd, buf, 0, take, size - take)
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

export interface ResumeView extends schema.TicketResume {
  /** The last lines of its log. */
  tail: string[]
}

/**
 * What the ticket's Resume card shows: whether the project has a resume command, the resume in hand (one
 * that runs, else the latest) with its log tail, and the few before it.
 */
export function ticketResume(ticketId: number) {
  const t = ticketOf(ticketId)
  const project = projectOf(t.projectId)
  const rows = db
    .select()
    .from(schema.ticketResumes)
    .where(eq(schema.ticketResumes.ticketId, ticketId))
    .orderBy(desc(schema.ticketResumes.id))
    .limit(8)
    .all()
  const current = rows.find((r) => r.state === 'running' || r.state === 'queued') ?? rows[0] ?? null
  return {
    enabled: !!project.resumeCommand.trim() || templateOf(project) !== null,
    current: current ? ({ ...current, tail: resumeLogTail(current) } satisfies ResumeView) : null,
    recent: rows.filter((r) => r.id !== current?.id),
  }
}

/** The CLIs the presets name, and whether each is on this machine's PATH (the board's, as it started). */
export function presetTools(): { id: string; binary: string; found: boolean }[] {
  return RESUME_PRESETS.map((p) => ({ id: p.id, binary: p.binary, found: !!resolveTool(p.binary) }))
}

/** The resume templates the board ships, and whether each one's program is on this machine's PATH. */
export function templateTools() {
  return templateList().map((t) => ({ ...t, found: !!resolveTool(t.binary) }))
}

/** The project's template when it names one the board ships; anything else reads as off (fail closed). */
function templateOf(project: schema.Project): TemplateId | null {
  return isTemplateId(project.resumeTemplate) ? project.resumeTemplate : null
}

// --- what a trigger needs ---

function ticketOf(id: number) {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get()
  if (!t) throw notFound('ticket')
  return t
}

function projectOf(id: number) {
  const p = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!p) throw notFound('project')
  return p
}

const humanNames = () => new Set(listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : [])))

/** The human's latest words on the ticket: their newest post or reply, whichever is later. */
function humanWords(ticketId: number): string {
  const humans = humanNames()
  const posts = db.select().from(schema.updates).where(eq(schema.updates.ticketId, ticketId)).all()
  const replies = posts.length
    ? db
        .select()
        .from(schema.comments)
        .where(
          and(
            eq(schema.comments.parentType, 'update'),
            inArray(
              schema.comments.parentId,
              posts.map((p) => p.id),
            ),
          ),
        )
        .all()
    : []
  const mine = [
    ...posts.filter((p) => humans.has(p.author)).map((p) => ({ at: p.createdAt, body: p.body })),
    ...replies.filter((c) => humans.has(c.author)).map((c) => ({ at: c.createdAt, body: c.body })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  return (mine[0]?.body ?? '').trim().slice(0, WORDS_MAX)
}

/**
 * Whether an agent is still working the ticket after `since` (the question was asked, or the ticket
 * went to the stage it left): any signal of an agent within the lease (the same ten minutes a heartbeat
 * keeps alive, `LEASE_TTL_MINUTES`), apart from the end of a span and the first moments after `since`,
 * which are an agent finishing its turn. The board's own events are not an agent.
 */
function liveAgent(ticketId: number, since: string | null): string | null {
  const now = Date.now()
  const after = Math.max(since ? Date.parse(since) + WIND_DOWN_MS : 0, now - LEASE_TTL_MINUTES * 60_000)
  const fresh = (at: string) => Date.parse(at) > after
  // A wait's own lease refresh counts only while a wait of the ticket is still registered.
  const waiting = ticketHasWaiter(ticketId)
  const event = db
    .select()
    .from(schema.ticketEvents)
    .where(eq(schema.ticketEvents.ticketId, ticketId))
    .orderBy(desc(schema.ticketEvents.id))
    .all()
    .find(
      (e) =>
        e.kind !== 'span_end' &&
        e.kind !== 'stage' &&
        !isBoardRecord(e.agent, e.by) &&
        !(e.kind === 'heartbeat' && e.note === WAIT_NOTE && !waiting) &&
        fresh(e.at),
    )
  if (event) return event.agent
  const humans = humanNames()
  const post = db
    .select()
    .from(schema.updates)
    .where(eq(schema.updates.ticketId, ticketId))
    .orderBy(desc(schema.updates.id))
    .all()
    .find((p) => !humans.has(p.author) && p.author !== BOARD && fresh(p.createdAt))
  return post?.author ?? null
}

/** The folder to run in: the ticket's registered worktree that exists, else its repo's checkout. */
function folderOf(ticket: schema.Ticket): string | null {
  const exists = (p: string) => {
    try {
      return !!p && fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const workspaces = db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ticketId, ticket.id))
    .all()
    .sort((a, b) => Number(b.agent === ticket.assignee) - Number(a.agent === ticket.assignee) || b.id - a.id)
  const ws = workspaces.find((w) => path.isAbsolute(w.path) && exists(w.path))
  if (ws) return ws.path
  const repo = ticketRepo(ticket)
  return repo && path.isAbsolute(repo.repoPath) && exists(repo.repoPath) ? repo.repoPath : null
}

/**
 * The model and effort the asking run recorded, for a template to use: the newest span start or hand-off of
 * the ticket's agent. Null when there is no such run. While the run-report fields are not on the events
 * table, the run is there but records nothing: `unrecorded`, so the table decides and the row says so.
 */
function askingRunOf(ticket: schema.Ticket): { model: unknown; effort: unknown } | null {
  if (!ticket.assignee) return null
  const columns = (db.all(sql`PRAGMA table_info(ticket_events)`) as { name: string }[]).map((c) => c.name)
  if (!columns.includes('model') || !columns.includes('effort')) return { model: null, effort: null }
  const run = db.all(
    sql`SELECT model, effort FROM ticket_events
        WHERE ticket_id = ${ticket.id} AND agent = ${ticket.assignee} AND kind IN ('span_start', 'handoff')
        ORDER BY id DESC LIMIT 1`,
  )[0] as { model: unknown; effort: unknown } | undefined
  return run ?? null
}

// --- the prompt ---

interface Cause {
  postId: number | null
  /** The human's answer as the board replied it (the option and the note), for an answer. */
  answer?: string
}

function promptOf(ticket: schema.Ticket, project: schema.Project, cause: Cause, template = false): string {
  const stages = listStages(ticket.projectId)
  const lines = [
    `You are continuing work on ticket #${ticket.id} "${ticket.title}" of the project "${project.name}" (project id ${project.id}) on the board at ${config.boardUrl}.`,
    `Your agent name on the board is ${ticket.assignee || '(none)'}: use it for every call you make there.`,
    '',
  ]
  const post = cause.postId
    ? (db.select().from(schema.updates).where(eq(schema.updates.id, cause.postId)).get() ?? null)
    : null
  if (post?.decision) {
    lines.push(
      'The human answered a decision you asked for.',
      '',
      `Question (card #${post.id}):`,
      post.body.trim(),
      '',
      `Options: ${post.decision.map((o, i) => `${i}: ${o.label}`).join('; ')}`,
      '',
      'The human’s answer:',
      (cause.answer ?? '').trim() || '(see the card)',
    )
  } else {
    lines.push(
      `The human moved the ticket back to ${stageOf(stages, ticket.status)} to go on with it.`,
      '',
      'The human’s latest words on the ticket:',
      humanWords(ticket.id) || '(none)',
    )
  }
  // A template run follows the project's own rules and workflow, the same steps the ticket's agent was given.
  if (template)
    lines.push(
      '',
      'The project’s instructions (its rules: how to run its repos, conventions, what never to do; they win over your habits):',
      project.instructions.trim() || '(none)',
      '',
      `Get your workflow with get_workflow (ticketId ${ticket.id}) and run exactly the steps it lists, in that order.`,
    )
  lines.push(
    '',
    'Read the ticket’s summary and threads with the board’s tools, reply under the card that you are continuing, and work as the board skill says.',
  )
  return lines.join('\n')
}

const stageOf = (stages: ReturnType<typeof listStages>, key: string) =>
  stages.find((s) => s.key === key)?.name ?? key

// --- starting ---

interface Start {
  ticketId: number
  trigger: ResumeTrigger
  postId?: number | null
  /** The human's answer words, for an answer. */
  answer?: string
  /** When the question was asked, or the ticket went to the stage it left: signals after it are a live agent. */
  since?: string | null
  /** The answer on the card was changed after an earlier one. */
  edited?: boolean
}

const SKIP_OFF = 'resuming is off: the project has no resume command (Settings, Resume)'

function reply(postId: number | null, body: string) {
  if (!postId) return
  db.insert(schema.comments).values({ parentType: 'update', parentId: postId, author: BOARD, body }).run()
}

function moveTo(ticket: schema.Ticket, key: string) {
  const stages = listStages(ticket.projectId)
  if (key === ticket.status) return
  db.update(schema.tickets)
    .set({
      status: key,
      ...movePatch(stages, ticket.status, key, ticket.startedAt),
      ...reopenPatch(stages, ticket.status, key),
    })
    .where(eq(schema.tickets.id, ticket.id))
    .run()
  noteStageMove(ticket.id, ticket.status, key)
}

const WAITING = 'an agent is waiting for this answer'
const FROM_CHAT =
  'the answer came from the chat, so the agent that asked has the first answer: press Resume on the ticket to run the work with the changed one'
const EDITED_AFTER_WAITER =
  'the answer was changed after it was delivered to the agent waiting for it: the agent has the first answer, so press Resume on the ticket to run the work with the changed one'

function deliveredOf(postId: number) {
  return (
    db
      .select({ delivered: schema.updates.answerDelivered })
      .from(schema.updates)
      .where(eq(schema.updates.id, postId))
      .get()?.delivered ?? ''
  )
}

function skipped(s: Start, reason: string, quiet = false) {
  const row = db
    .insert(schema.ticketResumes)
    .values({ ticketId: s.ticketId, postId: s.postId ?? null, trigger: s.trigger, state: 'skipped', reason })
    .returning()
    .get()
  // Resuming off is the board as it always was: no new words under the card.
  if (!quiet)
    reply(
      s.postId ?? null,
      reason === WAITING
        ? 'Delivered to the agent waiting for it: the board did not start another.'
        : `The board did not resume the work: ${reason}.`,
    )
  return row
}

/**
 * The trigger: starts at most one process for the ticket, or records why it did not. Never throws into
 * the answer or the move that set it off (a failure here is that resume's failed row).
 */
export function startResume(s: Start): schema.TicketResume {
  const ticket = ticketOf(s.ticketId)
  const project = projectOf(ticket.projectId)
  // The human's free-text command wins over a template; a template runs only when there is no command.
  const command = project.resumeCommand.trim()
  const template = command ? null : templateOf(project)
  if (!command && !template) return skipped(s, SKIP_OFF, true)
  if (s.trigger === 'answer') {
    // Only a question an agent waits on is continued: a request to the board (archive, a repo) is answered
    // for the board, and a finished ticket has nothing to continue (Resume on it stays the human's choice).
    const card = s.postId
      ? db.select().from(schema.updates).where(eq(schema.updates.id, s.postId)).get()
      : undefined
    if (card?.archiveTickets || card?.repoRequest)
      return skipped(s, 'the card is a request to the board, not a question an agent waits on', true)
    const kind = kindOf(listStages(ticket.projectId), ticket.status)
    if (kind === 'done' || kind === 'cancelled')
      return skipped(s, 'the ticket is finished: press Resume on it to run the work again', true)
  }
  if (ticket.archivedAt) return skipped(s, 'the ticket is archived')
  if (!ticket.assignee) return skipped(s, 'no agent holds the ticket: there is nobody to continue it')
  // One answer, one agent: an answer that already reached an agent (relayed to the session that asked,
  // handed to a waiting one, or given to a process the board started) is marked on its card, and an edit of
  // it starts nothing. The mark is read from the card, never inferred from the rows of this table.
  const delivered = s.edited && s.postId ? deliveredOf(s.postId) : ''
  if (delivered === 'chat') return skipped(s, FROM_CHAT)
  if (delivered === 'waiter') return skipped(s, EDITED_AFTER_WAITER)
  const running = db
    .select()
    .from(schema.ticketResumes)
    .where(
      and(
        eq(schema.ticketResumes.ticketId, s.ticketId),
        inArray(schema.ticketResumes.state, ['queued', 'running']),
      ),
    )
    .get()
  if (running)
    return skipped(
      s,
      s.edited
        ? 'a resume is already running for this ticket; it finds the changed answer in its threads'
        : 'a resume is already running for this ticket; it finds this answer in its threads',
    )
  if (delivered === 'resume')
    return skipped(
      s,
      'the answer was changed after the resume started: press Resume on the ticket to run it again',
    )
  if (s.trigger === 'answer' && s.postId && hasWaiter(s.ticketId, s.postId)) return skipped(s, WAITING)
  const live = liveAgent(s.ticketId, s.since ?? null)
  if (live) return skipped(s, `${live} is working the ticket: it has a live agent`)
  const cwd = folderOf(ticket)
  if (!cwd) return skipped(s, 'the ticket has no folder on this machine to run the command in')

  // A template: its model and effort are the asking run's, else the complexity's (src/lib/resumeTemplates.ts).
  const picked = template ? chooseModelEffort(ticket.complexity, askingRunOf(ticket)) : null
  const launch = template && picked ? assemble(template, picked.model, picked.effort) : null
  const row = db
    .insert(schema.ticketResumes)
    .values({
      ticketId: s.ticketId,
      postId: s.postId ?? null,
      trigger: s.trigger,
      state: 'queued',
      command: launch ? launch.binary : resumeCommandName(command),
      template: template ?? '',
      model: picked?.model ?? '',
      effort: picked?.effort ?? '',
      choice: picked?.choice ?? '',
    })
    .returning()
    .get()
  try {
    fs.mkdirSync(path.dirname(logPathOf(row.id)), { recursive: true })
    const prompt = promptOf(ticket, project, { postId: s.postId ?? null, answer: s.answer }, launch !== null)
    fs.writeFileSync(promptPathOf(row.id), prompt)
    const env = {
      ...worktreeEnv(),
      // A template's constants (its sandbox flag, the subagent model); the board's own values come last.
      ...launch?.env,
      BOARD_URL: config.boardUrl,
      BOARD_PROJECT_ID: String(project.id),
      BOARD_TICKET_ID: String(ticket.id),
      BOARD_AGENT_NAME: ticket.assignee,
      BOARD_RESUME_PROMPT_FILE: promptPathOf(row.id),
    }
    const proc = runner.spawn({
      command: launch ? commandLine(launch) : command,
      argv: launch ? { binary: launch.binary, args: launch.args } : undefined,
      cwd,
      env,
      log: logPathOf(row.id),
      stdin: prompt,
    })
    if (proc.pid === undefined) {
      void proc.exited.catch(() => {})
      return fail(row.id, 'the command could not be started', null)
    }
    const running = db
      .update(schema.ticketResumes)
      .set({
        state: 'running',
        pid: proc.pid,
        pidIdentity: runner.identity(proc.pid),
        startedAt: new Date().toISOString(),
        logPath: logPathOf(row.id),
      })
      .where(eq(schema.ticketResumes.id, row.id))
      .returning()
      .get()!
    // The process was given this card's answer (in its prompt): an edit of it starts no second one.
    if (s.postId)
      db.update(schema.updates)
        .set({ answerDelivered: 'resume' })
        .where(eq(schema.updates.id, s.postId))
        .run()
    reply(
      s.postId ?? null,
      `Continuing: the board started ${row.command}${picked ? ` (${picked.model}, ${picked.effort} effort)` : ''}${path.basename(cwd) ? ` in ${path.basename(cwd)}` : ''}.`,
    )
    logActivity({
      projectId: ticket.projectId,
      actor: BOARD,
      kind: 'ticket',
      text: `resumed #${ticket.id} ${ticket.title} with ${row.command}`,
      refType: 'ticket',
      refId: ticket.id,
    })
    watch(running, proc, project.resumeTimeoutMinutes)
    return running
  } catch (err) {
    return fail(row.id, err instanceof Error ? err.message : String(err), null)
  }
}

/** Watches the process of a running row: its exit, and the timeout. */
function watch(row: schema.TicketResume, proc: ResumeProc, timeoutMinutes: number) {
  const left = Math.max(
    0,
    Date.parse(row.startedAt ?? new Date().toISOString()) + timeoutMinutes * 60_000 - Date.now(),
  )
  const timer = setTimeout(() => {
    void (async () => {
      if (row.pid) await runner.killTree(row.pid)
      end(row.id, null, `it did not finish within ${timeoutMinutes} minutes: the board stopped it`)
    })()
  }, left)
  timer.unref?.()
  watching.set(row.id, [timer])
  void proc.exited.then((code) => end(row.id, code, null))
}

/** Watches a running row of an earlier board: its pid is polled, since the board has no handle on it. */
function rewatch(row: schema.TicketResume, timeoutMinutes: number) {
  const pid = row.pid!
  const left = Math.max(0, Date.parse(row.startedAt ?? row.createdAt) + timeoutMinutes * 60_000 - Date.now())
  const stop = setTimeout(() => {
    void (async () => {
      if (!isOurs(row)) return end(row.id, undefined, null)
      await runner.killTree(pid)
      end(row.id, null, `it did not finish within ${timeoutMinutes} minutes: the board stopped it`)
    })()
  }, left)
  const poll = setInterval(() => {
    if (!runner.alive(pid) || !isOurs(row)) end(row.id, undefined, null)
  }, POLL_MS)
  stop.unref?.()
  poll.unref?.()
  watching.set(row.id, [stop, poll as unknown as ReturnType<typeof setTimeout>])
}

const UNKNOWN_EXIT = 'the process ended while the board was not watching: its exit status is not known'

/**
 * A running row's end. `code` undefined: the process is gone and its status was never seen (a restart),
 * which is not called a failure. `why` is a failure the board decided on (the timeout). The first end wins.
 */
function end(rowId: number, code: number | null | undefined, why: string | null) {
  unwatch(rowId)
  const row = db.select().from(schema.ticketResumes).where(eq(schema.ticketResumes.id, rowId)).get()
  if (!row || row.state !== 'running') return
  if (code === 0 || code === undefined) {
    db.update(schema.ticketResumes)
      .set({
        state: 'succeeded',
        exitCode: code ?? null,
        reason: code === undefined ? UNKNOWN_EXIT : '',
        endedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.ticketResumes.id, rowId), eq(schema.ticketResumes.state, 'running')))
      .run()
    return
  }
  fail(
    rowId,
    why ??
      (code === null
        ? 'the command was killed or could not be started'
        : code === 127 && !WIN
          ? 'the shell did not find the command (exit code 127)'
          : `the command exited with code ${code}`),
    code,
  )
}

/** A failed resume: the row, a reply under the card, the ticket back to blocked, a notice for the human. */
function fail(rowId: number, reason: string, code: number | null): schema.TicketResume {
  const row = db
    .update(schema.ticketResumes)
    .set({ state: 'failed', exitCode: code, reason, endedAt: new Date().toISOString() })
    .where(
      and(eq(schema.ticketResumes.id, rowId), inArray(schema.ticketResumes.state, ['queued', 'running'])),
    )
    .returning()
    .get()
  if (!row) return db.select().from(schema.ticketResumes).where(eq(schema.ticketResumes.id, rowId)).get()!
  const ticket = ticketOf(row.ticketId)
  const tail = resumeLogTail(row, 3)
  const stages = listStages(ticket.projectId)
  const blocked = firstOfKind(stages, 'blocked')
  // Only a ticket in an active stage is moved; one in review, done or open stays, and the words say so.
  const toBlocked = !!blocked && kindOf(stages, ticket.status) === 'active'
  reply(
    row.postId,
    `The board could not resume the work: ${reason}.${tail.length ? `\n\n\`\`\`\n${tail.join('\n')}\n\`\`\`` : ''}\n\n${toBlocked ? 'The ticket is back in blocked; Retry' : 'Retry'} on the ticket starts it again.`,
  )
  if (toBlocked) moveTo(ticket, blocked.key)
  try {
    postNotice({ name: BOARD, agent: true }, ticket.projectId, {
      title: `The board could not resume #${ticket.id} ${ticket.title}`,
      body: `${reason}. ${toBlocked ? 'The ticket is back in blocked. ' : ''}Open it to read the log and press Retry.`,
      reason: 'the human answered or moved the ticket and nothing is working on it',
      href: `/projects/${ticket.projectId}/features/${ticket.id}`,
    })
  } catch (err) {
    console.error('could not post the notice for a failed resume:', err)
  }
  logActivity({
    projectId: ticket.projectId,
    actor: BOARD,
    kind: 'ticket',
    text: `could not resume #${ticket.id} ${ticket.title}: ${reason}`,
    refType: 'ticket',
    refId: ticket.id,
  })
  return row
}

// --- the triggers, called from features.ts ---

/** The human answered a decision card on the board (not a relayed answer). */
export function resumeAfterAnswer(
  post: Pick<schema.Update, 'id' | 'ticketId' | 'createdAt'>,
  answer: string,
  edited: boolean,
) {
  return guarded(() =>
    startResume({
      ticketId: post.ticketId,
      trigger: 'answer',
      postId: post.id,
      answer,
      since: post.createdAt,
      edited,
    }),
  )
}

/**
 * The human moved a ticket out of a blocked, review or approved stage into an active one. `from` is the stage it
 * left: its time of arrival is when the agent that put it there was last working.
 */
export function resumeAfterMove(ticketId: number, from: string, to: string) {
  const ticket = ticketOf(ticketId)
  const stages = listStages(ticket.projectId)
  const left = kindOf(stages, from)
  if ((left !== 'blocked' && left !== 'review' && left !== 'approved') || kindOf(stages, to) !== 'active')
    return null
  const arrived = db
    .select({ at: schema.ticketEvents.at })
    .from(schema.ticketEvents)
    .where(
      and(
        eq(schema.ticketEvents.ticketId, ticketId),
        eq(schema.ticketEvents.kind, 'stage'),
        eq(schema.ticketEvents.toStage, from),
      ),
    )
    .orderBy(desc(schema.ticketEvents.id))
    .get()
  return guarded(() => startResume({ ticketId, trigger: 'move', since: arrived?.at ?? null }))
}

/** The ticket's newest answered decision card an agent waits on (not a request to the board), or null. */
function newestAnswered(ticketId: number) {
  return (
    db
      .select()
      .from(schema.updates)
      .where(
        and(
          eq(schema.updates.ticketId, ticketId),
          isNotNull(schema.updates.decision),
          isNotNull(schema.updates.decidedAt),
          isNull(schema.updates.archiveTickets),
          isNull(schema.updates.repoRequest),
        ),
      )
      .orderBy(desc(schema.updates.decidedAt), desc(schema.updates.id))
      .get() ?? null
  )
}

/** The answer on a card as the agent gets it: the human's reply under it, or the words relayed from the chat. */
function answerWords(post: schema.Update): string | undefined {
  if (post.relayedBy) return `Decided in chat: ${post.relayedText}`
  const humans = humanNames()
  return db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.parentType, 'update'), eq(schema.comments.parentId, post.id)))
    .orderBy(desc(schema.comments.id))
    .all()
    .find((c) => humans.has(c.author) && /^(Decided|Changed the decision)/.test(c.body))?.body
}

/** The Resume / Retry button: starts one run now, the same way the last one was set off. */
export function retryResume(ticketId: number): schema.TicketResume {
  const ticket = ticketOf(ticketId)
  const last = db
    .select()
    .from(schema.ticketResumes)
    .where(and(eq(schema.ticketResumes.ticketId, ticketId), isNotNull(schema.ticketResumes.startedAt)))
    .orderBy(desc(schema.ticketResumes.id))
    .get()
  // The card whose answer the work goes on with: the newest answered question on the ticket, when no run
  // has gone on with it yet (an answer that was relayed, handed to a waiting agent or skipped leaves no run
  // behind), else the card the last run came from.
  const newest = newestAnswered(ticketId)
  const lastPost = last?.postId
    ? (db.select().from(schema.updates).where(eq(schema.updates.id, last.postId)).get() ?? null)
    : null
  const post =
    newest && (!last || newest.id === last.postId || (newest.decidedAt ?? '') > (last.startedAt ?? ''))
      ? newest
      : lastPost
  const answer = post ? answerWords(post) : undefined
  // Signals of the run that ended are its own, not another agent's; a question asked after it counts from
  // when it was asked.
  const ended = last?.endedAt ?? last?.startedAt ?? null
  const since =
    post && post.id !== last?.postId && (!ended || post.createdAt > ended) ? post.createdAt : ended
  const row = startResume({
    ticketId,
    trigger: 'retry',
    postId: post?.id ?? null,
    answer,
    since,
  })
  if (row.state === 'skipped') throw new HttpError(409, row.reason)
  // A command that could not start leaves the ticket where it was: still blocked.
  if (row.state !== 'running') throw new HttpError(502, `the board could not resume the work: ${row.reason}`)
  // The ticket is where the work is again.
  const stages = listStages(ticket.projectId)
  const fresh = ticketOf(ticketId)
  const work = projectWorkStage(ticket.projectId, stages)
  if (work && kindOf(stages, fresh.status) !== 'active') moveTo(fresh, work.key)
  return row
}

/** Runs a trigger without letting it break the answer or the move that set it off. */
function guarded(fn: () => schema.TicketResume): schema.TicketResume | null {
  try {
    return fn()
  } catch (err) {
    console.error('resume failed to start:', err)
    return null
  }
}

// --- the board starting ---

/**
 * As the board starts: a row that never started is closed (the board stopped between its two steps); a
 * running row whose process is gone is closed with its exit unknown; one whose process is alive is
 * watched again, and timed out from when it started.
 */
export function sweepResumes() {
  const open = db
    .select()
    .from(schema.ticketResumes)
    .where(inArray(schema.ticketResumes.state, ['queued', 'running']))
    .all()
  for (const row of open) {
    if (row.state === 'queued' || row.pid === null) {
      fail(row.id, 'the board stopped before it started the command', null)
      continue
    }
    if (watching.has(row.id)) continue
    const project = db
      .select({ minutes: schema.projects.resumeTimeoutMinutes })
      .from(schema.projects)
      .innerJoin(schema.tickets, eq(schema.tickets.projectId, schema.projects.id))
      .where(eq(schema.tickets.id, row.ticketId))
      .get()
    if (runner.alive(row.pid) && isOurs(row)) rewatch(row, project?.minutes ?? 240)
    else end(row.id, undefined, null)
  }
}
