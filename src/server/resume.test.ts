import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-resume-')))
process.env.DATA_DIR = path.join(tmp, 'data')

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let resume: typeof import('./resume')
let cards: typeof import('./agentCards')
let handle: (request: Request) => Promise<Response>
let projectId: number

/** A command's tiny stand-in: records what it was given into the file named by its first argument. */
const script = path.join(tmp, 'agent.mjs')
fs.writeFileSync(
  script,
  `import fs from 'node:fs'
const [out, mode = '0', owner] = process.argv.slice(2)
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
const file = process.env.BOARD_RESUME_PROMPT_FILE
fs.writeFileSync(out, JSON.stringify({
  stdin,
  promptFile: file ? fs.readFileSync(file, 'utf8') : null,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('BOARD_'))),
  pid: process.pid,
}))
console.log('recorded for the test')
// A hanging stand-in ends by itself once the test run that started it is gone.
if (mode === 'hang') setInterval(() => {
  try { process.kill(Number(owner), 0) } catch { process.exit(0) }
}, 1000)
else process.exit(Number(mode))
`,
)

const node = `"${process.execPath}"`
/** The command of a test: runs the script, which writes to `out`. */
const commandFor = (out: string, mode = '0') => `${node} "${script}" "${out}" ${mode} ${process.pid}`

let n = 0
const outFile = () => path.join(tmp, `out-${++n}.json`)
const read = (out: string) => JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, any>

async function until<T>(what: () => T | undefined | false | null, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const got = what()
    if (got) return got
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const rowsOf = (ticketId: number) =>
  dbm.db.select().from(dbm.schema.ticketResumes).where(eq(dbm.schema.ticketResumes.ticketId, ticketId)).all()
const rowState = (id: number) =>
  dbm.db.select().from(dbm.schema.ticketResumes).where(eq(dbm.schema.ticketResumes.id, id)).get()!
const repliesOf = (postId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.comments)
    .where(and(eq(dbm.schema.comments.parentType, 'update'), eq(dbm.schema.comments.parentId, postId)))
    .all()
const statusOf = (ticketId: number) =>
  dbm.db.select().from(dbm.schema.tickets).where(eq(dbm.schema.tickets.id, ticketId)).get()!.status

function setCommand(command: string, minutes = 240) {
  dbm.db
    .update(dbm.schema.projects)
    .set({ resumeCommand: command, resumeTimeoutMinutes: minutes })
    .where(eq(dbm.schema.projects.id, projectId))
    .run()
}

let folderCount = 0
/** A ticket an agent works from a registered worktree, which asked a question: blocked, with its card. */
function asked(question = 'Which database?', opts: { assignee?: string; workspace?: boolean } = {}) {
  const ticket = features.createTicket(
    projectId,
    { title: 'Pick a database', status: 'in_progress', assignee: opts.assignee ?? AGENT },
    AGENT,
  )
  let folder: string | null = null
  if (opts.workspace !== false) {
    folder = path.join(tmp, `wt-${++folderCount}`)
    fs.mkdirSync(folder)
    features.addWorkspace(ticket.id, { name: 'wt', path: folder, agent: AGENT }, AGENT)
  }
  const post = ask(ticket.id, question)
  return { ticket, post, folder }
}
function ask(ticketId: number, question: string) {
  return features.askDecision(
    ticketId,
    { body: question, options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    AGENT,
  )
}
/** The card was asked a while ago: an agent's signals right after it are not a live agent. */
function askedLongAgo(postId: number) {
  dbm.db
    .update(dbm.schema.updates)
    .set({ createdAt: new Date(Date.now() - 5 * 60_000).toISOString() })
    .where(eq(dbm.schema.updates.id, postId))
    .run()
}

beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  resume = await import('./resume')
  cards = await import('./agentCards')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const repoDir = path.join(tmp, 'repo')
  fs.mkdirSync(repoDir)
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'shop' }).returning().get().id
  dbm.db.insert(dbm.schema.repos).values({ projectId, name: 'shop', repoPath: repoDir }).run()
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

/** Helper processes a test starts itself; each is stopped when the test ends. */
const strays: ChildProcess[] = []
const trackStray = (child: ChildProcess) => {
  strays.push(child)
  return child
}

/** Every live process whose command line mentions `needle`, as `[pid, group]` (none on Windows). */
function processesWith(needle: string): [number, number][] {
  if (process.platform === 'win32') return []
  let text = ''
  try {
    text = execFileSync('ps', ['-eo', 'pid=,pgid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  const found: [number, number][] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m && m[3]!.includes(needle) && Number(m[1]) !== process.pid) found.push([Number(m[1]), Number(m[2])])
  }
  return found
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The group of this test run itself: never killed. */
const ownGroup = () => {
  try {
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
  } catch {
    return 0
  }
}

/** Kills a process and the group it was started in, unless that is the test run's own. */
function kill(pid: number, group: number) {
  try {
    process.kill(group > 1 && group !== ownGroup() ? -group : pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Stops every process a test started and waits for it to go, passed or failed: nothing outlives the run.
 * The stand-ins are found by their script's path, since the shell that started one may be gone while it lives.
 */
async function stopStrangers() {
  const pids: number[] = []
  for (const child of strays.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      pids.push(child.pid)
    }
  }
  for (const [pid, group] of processesWith(script)) {
    kill(pid, group)
    pids.push(pid)
  }
  const end = Date.now() + 5_000
  while (pids.some(isAlive) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

afterEach(async () => {
  resume.stopWatching()
  resume.setResumeRunner(null)
  setCommand('')
  await stopStrangers()
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

describe('resume: an answer on the board', () => {
  it('with no command, answering changes nothing new and the ticket says resuming is off', () => {
    const { ticket, post } = asked()
    expect(statusOf(ticket.id)).toBe('blocked')
    features.decide(post.id, 0, '', HUMAN)
    expect(statusOf(ticket.id)).toBe('in_progress')
    expect(repliesOf(post.id).map((c) => c.author)).toEqual([HUMAN])
    const [row] = rowsOf(ticket.id)
    expect(row).toMatchObject({ state: 'skipped', trigger: 'answer', postId: post.id, pid: null })
    expect(row!.reason).toContain('resuming is off')
    expect(resume.ticketResume(ticket.id)).toMatchObject({ enabled: false, current: { state: 'skipped' } })
  })

  it('with a command, starts exactly one process in the worktree with the prompt, the file and the env', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post, folder } = asked('Which database?')
    features.decide(post.id, 1, 'Please use the managed one.', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'running',
      trigger: 'answer',
      command: expect.stringContaining('node'),
    })
    expect(rows[0]!.pid).toBeGreaterThan(0)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const got = read(out)
    expect(got.cwd).toBe(folder)
    expect(got.stdin).toContain(`ticket #${ticket.id}`)
    expect(got.stdin).toContain('Which database?')
    expect(got.stdin).toContain('Postgres')
    expect(got.stdin).toContain('Please use the managed one.')
    expect(got.promptFile).toBe(got.stdin)
    expect(got.env).toMatchObject({
      BOARD_PROJECT_ID: String(projectId),
      BOARD_TICKET_ID: String(ticket.id),
      BOARD_AGENT_NAME: AGENT,
      BOARD_URL: expect.stringMatching(/^http/),
    })
    expect(repliesOf(post.id).some((c) => c.author === 'board' && c.body.startsWith('Continuing:'))).toBe(
      true,
    )
    expect(statusOf(ticket.id)).toBe('in_progress')
    await until(() => rowState(rows[0]!.id).state === 'succeeded')
    expect(rowState(rows[0]!.id)).toMatchObject({ exitCode: 0, reason: '' })
    expect(resume.ticketResume(ticket.id).current!.tail).toContain('recorded for the test')
  })

  it('runs in the repo when the ticket has no worktree', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { post } = asked('Where?', { workspace: false })
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    expect(read(out).cwd).toBe(path.join(tmp, 'repo'))
  })

  it('starts no second process for a second answer or an edited answer while one runs', async () => {
    const out = outFile()
    setCommand(commandFor(out, 'hang'))
    const { ticket, post } = asked('First?')
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const second = ask(ticket.id, 'Second?')
    features.decide(second.id, 0, '', HUMAN)
    features.decide(post.id, 1, 'changed my mind', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows.filter((r) => r.state === 'running')).toHaveLength(1)
    expect(rows.filter((r) => r.pid !== null)).toHaveLength(1)
    expect(rows.filter((r) => r.state === 'skipped').map((r) => r.reason)).toEqual([
      expect.stringContaining('already running'),
      expect.stringContaining('already running'),
    ])
    expect(resume.ticketResume(ticket.id).current!.state).toBe('running')
    await resumeKill(rows.find((r) => r.pid !== null)!.id)
  })

  it('does not start another for an answer edited after its resume has ended', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
    features.decide(post.id, 1, 'edited', HUMAN)
    expect(rowsOf(ticket.id).filter((r) => r.pid !== null)).toHaveLength(1)
    expect(rowsOf(ticket.id).at(-1)!.reason).toContain('press Resume')
  })

  it('never lets a card or an answer reach a shell', async () => {
    const out = outFile()
    const marker = path.join(tmp, 'injected')
    setCommand(commandFor(out))
    const { post } = asked(`Run \`touch ${marker}\` and $(touch ${marker}); touch ${marker} #`)
    features.decide(post.id, 0, `"; touch ${marker}; "`, HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    expect(read(out).stdin).toContain(`$(touch ${marker})`)
    expect(fs.existsSync(marker)).toBe(false)
  })
})

/** Ends a hanging test process, and waits for the board to see it go. */
async function resumeKill(rowId: number) {
  const row = rowState(rowId)
  // The command's whole group: its shell and the stand-in it started.
  process.kill(process.platform === 'win32' ? row.pid! : -row.pid!, 'SIGKILL')
  await until(() => rowState(rowId).state !== 'running')
}

describe('resume: a human move of the ticket', () => {
  it('resumes with the human words when the human moves a blocked ticket to in progress', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked('Which database?')
    // The agent asked with a card; the human sends the ticket back without answering it, with words.
    features.addComment(
      { parentType: 'update', parentId: post.id, body: 'Go with the managed one, please.' },
      HUMAN,
    )
    askedLongAgo(post.id)
    features.updateTicket(ticket.id, { status: 'in_progress' }, HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const got = read(out)
    expect(got.stdin).toContain('Go with the managed one, please.')
    expect(got.stdin).toContain('moved the ticket back to')
    const rows = rowsOf(ticket.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trigger: 'move', postId: null })
  })

  it('also resumes from a review stage', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket } = asked()
    features.updateTicket(ticket.id, { status: 'review' }, AGENT, { agent: true })
    features.updateTicket(ticket.id, { status: 'in_progress' }, HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    expect(rowsOf(ticket.id).filter((r) => r.pid !== null)).toHaveLength(1)
  })

  it('does not resume for an agent move, a relayed answer or a move that is not out of blocked or review', () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked()
    features.updateTicket(ticket.id, { status: 'in_progress' }, AGENT, { agent: true })
    expect(rowsOf(ticket.id)).toHaveLength(0)
    const t2 = asked()
    features.relayDecision(t2.post.id, { option: 0, words: 'yes' }, AGENT, { agent: true })
    expect(statusOf(t2.ticket.id)).toBe('in_progress')
    expect(rowsOf(t2.ticket.id)).toHaveLength(0)
    const t3 = features.createTicket(projectId, { title: 'todo one', assignee: AGENT }, AGENT)
    features.updateTicket(t3.id, { status: 'in_progress' }, HUMAN)
    expect(rowsOf(t3.id)).toHaveLength(0)
    expect(post.id).toBeGreaterThan(0)
    expect(fs.existsSync(out)).toBe(false)
  })
})

describe('resume: a ticket with a live agent', () => {
  it('starts no process and says why when an agent kept working after the question', () => {
    setCommand(commandFor(outFile()))
    const { ticket, post } = asked()
    askedLongAgo(post.id)
    // The agent is still heartbeating: its lease is open.
    dbm.db
      .insert(dbm.schema.ticketEvents)
      .values({ ticketId: ticket.id, projectId, kind: 'heartbeat', agent: AGENT, by: 'gate_test' })
      .run()
    features.decide(post.id, 0, '', HUMAN)
    const [row] = rowsOf(ticket.id)
    expect(row).toMatchObject({ state: 'skipped', pid: null })
    expect(row!.reason).toContain(`${AGENT} is working the ticket`)
    expect(repliesOf(post.id).at(-1)!.body).toContain('live agent')
  })

  it('treats an agent that only finished its turn after asking as gone', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked()
    dbm.db
      .insert(dbm.schema.ticketEvents)
      .values({ ticketId: ticket.id, projectId, kind: 'span_end', agent: AGENT, by: 'gate_test' })
      .run()
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out))
    expect(rowsOf(ticket.id)[0]!.state).not.toBe('skipped')
  })
})

describe('resume: skipped without an agent to continue', () => {
  it('skips an unassigned ticket', () => {
    setCommand(commandFor(outFile()))
    const { ticket, post } = asked('Who?', { assignee: '' })
    features.decide(post.id, 0, '', HUMAN)
    expect(rowsOf(ticket.id)[0]).toMatchObject({ state: 'skipped' })
    expect(rowsOf(ticket.id)[0]!.reason).toContain('no agent holds the ticket')
  })
})

describe('resume: failure', () => {
  const notices = () => cards.listCards(projectId).filter((c) => c.kind === 'notice')

  async function failed(command: string, minutes = 240) {
    setCommand(command, minutes)
    const { ticket, post } = asked('Which database?')
    const before = notices().length
    features.decide(post.id, 0, '', HUMAN)
    const row = rowsOf(ticket.id)[0]!
    await until(() => rowState(row.id).state === 'failed')
    return { ticket, post, row: rowState(row.id), before }
  }

  it('a non-zero exit shows on the ticket and in the notification center, and blocks the ticket again', async () => {
    const { ticket, post, row, before } = await failed(commandFor(outFile(), '3'))
    expect(row).toMatchObject({ state: 'failed', exitCode: 3 })
    expect(row.reason).toContain('code 3')
    expect(statusOf(ticket.id)).toBe('blocked')
    expect(repliesOf(post.id).at(-1)!.body).toContain('could not resume')
    expect(notices()).toHaveLength(before + 1)
    expect(notices()[0]).toMatchObject({
      actor: 'board',
      href: `/projects/${projectId}/features/${ticket.id}`,
    })
    expect(resume.ticketResume(ticket.id).current).toMatchObject({ state: 'failed' })
  })

  it('records the board as the one that moved it when a failed resume blocks the ticket again', async () => {
    const { ticket } = await failed(commandFor(outFile(), '3'))
    const { stageHistoryOf } = await import('./stageHistory')
    expect(stageHistoryOf(ticket.id).at(-1)).toMatchObject({
      to: 'blocked',
      by: 'board',
      how: 'board',
    })
  })

  it('the words say the ticket is back in blocked only when it moved, and a ticket that stayed is not claimed blocked', async () => {
    const run = async (stay: boolean) => {
      resume.setResumeRunner({
        spawn: () => {
          if (stay)
            dbm.db
              .update(dbm.schema.tickets)
              .set({ status: 'review' })
              .where(eq(dbm.schema.tickets.id, ticketId))
              .run()
          return { pid: undefined, exited: Promise.resolve(null) }
        },
        killTree: async () => {},
        alive: () => false,
        identity: () => null,
      })
      setCommand('anything')
      const { ticket, post } = asked()
      var ticketId = ticket.id
      const before = notices().length
      features.decide(post.id, 0, '', HUMAN)
      expect(rowsOf(ticket.id)[0]!.state).toBe('failed')
      return {
        ticket,
        reply: repliesOf(post.id).at(-1)!.body,
        notice: notices().slice(0, notices().length - before)[0]!.body,
      }
    }
    const moved = await run(false)
    expect(statusOf(moved.ticket.id)).toBe('blocked')
    expect(moved.reply).toContain('The ticket is back in blocked; Retry on the ticket starts it again.')
    expect(moved.notice).toContain('The ticket is back in blocked.')
    const stayed = await run(true)
    expect(statusOf(stayed.ticket.id)).toBe('review')
    expect(stayed.reply).not.toContain('blocked')
    expect(stayed.reply).toContain('Retry on the ticket starts it again.')
    expect(stayed.notice).not.toContain('blocked')
    expect(stayed.notice).toContain('press Retry')
  })

  it('a command the shell cannot find fails the same way', async () => {
    const { ticket, row } = await failed('definitely-not-an-installed-command-xyz')
    expect(row.state).toBe('failed')
    expect(row.exitCode).not.toBe(0)
    expect(statusOf(ticket.id)).toBe('blocked')
  })

  it('a command that cannot be started at all fails', async () => {
    resume.setResumeRunner({
      spawn: () => ({ pid: undefined, exited: Promise.resolve(null) }),
      killTree: async () => {},
      alive: () => false,
      identity: () => null,
    })
    setCommand('anything')
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    expect(rowsOf(ticket.id)[0]).toMatchObject({
      state: 'failed',
      reason: 'the command could not be started',
    })
    expect(statusOf(ticket.id)).toBe('blocked')
  })

  it('a process that does not exit by the timeout is stopped and fails', async () => {
    const out = outFile()
    setCommand(commandFor(out, 'hang'), 0.002)
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    const row = rowsOf(ticket.id)[0]!
    await until(() => rowState(row.id).state === 'failed')
    expect(rowState(row.id).reason).toContain('did not finish within')
    await until(() => {
      try {
        process.kill(read(out).pid, 0)
        return false
      } catch {
        return true
      }
    })
    expect(statusOf(ticket.id)).toBe('blocked')
  })

  it('Retry starts one new run and puts the ticket back in progress', async () => {
    const { ticket, post, row } = await failed(commandFor(outFile(), '3'))
    const out = outFile()
    setCommand(commandFor(out))
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ state: 'running', trigger: 'retry', postId: post.id })
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    expect(read(out).stdin).toContain('Which database?')
    expect(rowsOf(ticket.id).filter((r) => r.pid !== null)).toHaveLength(2)
    expect(rowsOf(ticket.id).find((r) => r.id === row.id)!.state).toBe('failed')
    expect(statusOf(ticket.id)).toBe('in_progress')
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })

  it('Retry while one runs is refused', async () => {
    const out = outFile()
    setCommand(commandFor(out, 'hang'))
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(409)
    expect(rowsOf(ticket.id).filter((r) => r.pid !== null)).toHaveLength(1)
    await resumeKill(rowsOf(ticket.id).find((r) => r.pid !== null)!.id)
  })
})

describe('resume: a board restart', () => {
  /** A real process that is already gone, and its pid. */
  async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise((r) => child.once('exit', r))
    return child.pid!
  }

  function openRow(ticketId: number, pid: number | null, state: 'running' | 'queued' = 'running') {
    return dbm.db
      .insert(dbm.schema.ticketResumes)
      .values({ ticketId, trigger: 'answer', state, pid, startedAt: new Date().toISOString() })
      .returning()
      .get()
  }

  it('closes a row whose process is gone, keeps one whose process lives, and still watches it', async () => {
    setCommand('x')
    const { ticket } = asked()
    const gone = openRow(ticket.id, await deadPid())
    const queued = openRow(asked().ticket.id, null, 'queued')
    const child = trackStray(
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      }),
    )
    child.unref()
    const t2 = asked().ticket
    const alive = openRow(t2.id, child.pid!)
    resume.sweepResumes()
    expect(rowState(gone.id)).toMatchObject({ state: 'succeeded', exitCode: null })
    expect(rowState(gone.id).reason).toContain('not known')
    expect(rowState(queued.id).state).toBe('failed')
    expect(rowState(alive.id).state).toBe('running')
    // Beyond its timeout the board stops it, though it did not start it this time.
    dbm.db
      .update(dbm.schema.ticketResumes)
      .set({ startedAt: new Date(Date.now() - 10 * 3_600_000).toISOString() })
      .where(eq(dbm.schema.ticketResumes.id, alive.id))
      .run()
    resume.stopWatching()
    resume.sweepResumes()
    await until(() => rowState(alive.id).state === 'failed')
    expect(rowState(alive.id).reason).toContain('did not finish within')
    await until(() => {
      try {
        process.kill(child.pid!, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('a process started by the board is detached: its own process group', async () => {
    const out = outFile()
    setCommand(commandFor(out, 'hang'))
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const pid = rowsOf(ticket.id)[0]!.pid!
    // A group leader: it was started on its own, so the board's stop does not take it down.
    const ps = await new Promise<string>((resolve) => {
      const p = spawn('ps', ['-o', 'pgid=', '-p', String(pid)])
      let text = ''
      p.stdout.on('data', (d) => (text += d))
      p.once('close', () => resolve(text.trim()))
    })
    if (process.platform !== 'win32') expect(Number(ps)).toBe(pid)
    await resumeKill(rowsOf(ticket.id)[0]!.id)
  })
})

describe('resume: who may set it', () => {
  it('the human sets the command and the timeout; an agent token is refused', async () => {
    const mine = await call('PATCH', `/api/projects/${projectId}`, {
      resumeCommand: 'claude -p',
      resumeTimeoutMinutes: 60,
    })
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ resumeCommand: 'claude -p', resumeTimeoutMinutes: 60 })
    const theirs = await call('PATCH', `/api/projects/${projectId}`, { resumeCommand: 'rm -rf /' }, 'agent')
    expect(theirs.status).toBe(403)
    expect(
      (await call('PATCH', `/api/projects/${projectId}`, { resumeTimeoutMinutes: 5 }, 'agent')).status,
    ).toBe(403)
    expect(
      dbm.db.select().from(dbm.schema.projects).where(eq(dbm.schema.projects.id, projectId)).get()!
        .resumeCommand,
    ).toBe('claude -p')
    expect((await call('PATCH', `/api/projects/${projectId}`, { resumeCommand: 'a\nb' })).status).toBe(400)
    expect((await call('PATCH', `/api/projects/${projectId}`, { resumeTimeoutMinutes: 0 })).status).toBe(400)
  })

  it('an agent token cannot press Resume, and no MCP tool names the setting', async () => {
    const { ticket } = asked()
    expect((await call('POST', `/api/tickets/${ticket.id}/resume`, undefined, 'agent')).status).toBe(403)
    const mcp = fs.readFileSync(path.join(__dirname, 'mcp.ts'), 'utf8')
    expect(mcp).not.toMatch(/resumeCommand|resumeTimeout/)
  })

  it('shows the state on the ticket and which preset tools are on the machine', async () => {
    const { ticket } = asked()
    const res = await call('GET', `/api/tickets/${ticket.id}/resume`)
    expect(res.body).toMatchObject({ enabled: false, current: null, recent: [] })
    const tools = await call('GET', '/api/resume/tools')
    expect(tools.body.map((t: { id: string }) => t.id)).toEqual(['claude', 'codex', 'opencode'])
    expect(tools.body.every((t: { found: boolean }) => typeof t.found === 'boolean')).toBe(true)
  })
})

describe('resume: Retry and the cards that are not questions', () => {
  const noProc = { spawn: () => ({ pid: undefined, exited: Promise.resolve(null) }) }
  const fake = (extra: Partial<import('./resume').ResumeRunner> = {}) => ({
    spawn: noProc.spawn,
    killTree: async () => {},
    alive: () => false,
    identity: () => null,
    ...extra,
  })
  const ticketRow = (id: number) =>
    dbm.db.select().from(dbm.schema.tickets).where(eq(dbm.schema.tickets.id, id)).get()!

  /** The agent went quiet long ago: its earlier signals no longer make a live agent. */
  const quiet = (ticketId: number) => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    dbm.db
      .update(dbm.schema.ticketEvents)
      .set({ at: old })
      .where(eq(dbm.schema.ticketEvents.ticketId, ticketId))
      .run()
    dbm.db
      .update(dbm.schema.updates)
      .set({ createdAt: old })
      .where(eq(dbm.schema.updates.ticketId, ticketId))
      .run()
  }

  it('a Retry whose command cannot start answers an error and leaves the ticket blocked', async () => {
    resume.setResumeRunner(fake())
    setCommand('anything')
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    expect(rowsOf(ticket.id)[0]!.state).toBe('failed')
    quiet(ticket.id)
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(502)
    expect(statusOf(ticket.id)).toBe('blocked')
  })

  it('Resume on a done ticket reopens it and clears its approval', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket } = asked()
    dbm.db
      .update(dbm.schema.tickets)
      .set({
        status: 'done',
        approvedAt: new Date().toISOString(),
        approvedBy: HUMAN,
        closedByApproval: true,
      })
      .where(eq(dbm.schema.tickets.id, ticket.id))
      .run()
    quiet(ticket.id)
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(202)
    expect(ticketRow(ticket.id)).toMatchObject({
      status: 'in_progress',
      approvedAt: null,
      approvedBy: '',
      closedByApproval: false,
    })
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })

  it('an archive request answered Keep starts no resume, and leaves no reply', () => {
    setCommand(commandFor(outFile()))
    const { ticket } = asked()
    dbm.db
      .update(dbm.schema.tickets)
      .set({ status: 'done' })
      .where(eq(dbm.schema.tickets.id, ticket.id))
      .run()
    const card = features.requestArchive([ticket.id], {}, AGENT)
    features.decide(card.id, 1, '', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows.every((r) => r.state === 'skipped' && r.pid === null)).toBe(true)
    expect(repliesOf(card.id).some((c) => c.body.includes('did not resume'))).toBe(false)
  })

  it('an archive request answered Archive starts no resume and leaves no reply, though the ticket is archived', () => {
    setCommand(commandFor(outFile()))
    const { ticket } = asked()
    dbm.db
      .update(dbm.schema.tickets)
      .set({ status: 'done' })
      .where(eq(dbm.schema.tickets.id, ticket.id))
      .run()
    const card = features.requestArchive([ticket.id], {}, AGENT)
    features.decide(card.id, 0, '', HUMAN)
    expect(
      dbm.db.select().from(dbm.schema.tickets).where(eq(dbm.schema.tickets.id, ticket.id)).get()!.archivedAt,
    ).toBeTruthy()
    expect(rowsOf(ticket.id).every((r) => r.state === 'skipped' && r.pid === null)).toBe(true)
    expect(repliesOf(card.id).some((c) => c.body.includes('did not resume'))).toBe(false)
  })

  it('an answer on a finished ticket starts no resume; the human pressing Resume still may', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked()
    dbm.db
      .update(dbm.schema.tickets)
      .set({ status: 'done' })
      .where(eq(dbm.schema.tickets.id, ticket.id))
      .run()
    features.decide(post.id, 0, '', HUMAN)
    expect(rowsOf(ticket.id).every((r) => r.state === 'skipped')).toBe(true)
    expect(rowsOf(ticket.id)[0]!.reason).toContain('finished')
    quiet(ticket.id)
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(202)
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })

  it('Retry right after a failed run does not count that run own signals as a live agent', async () => {
    setCommand(commandFor(outFile(), '3'))
    const { ticket, post } = asked()
    askedLongAgo(post.id)
    features.decide(post.id, 0, '', HUMAN)
    const first = rowsOf(ticket.id)[0]!
    await until(() => rowState(first.id).state === 'failed')
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    dbm.db
      .update(dbm.schema.ticketResumes)
      .set({ startedAt: ago(5 * 60_000), endedAt: ago(60_000) })
      .where(eq(dbm.schema.ticketResumes.id, first.id))
      .run()
    dbm.db
      .insert(dbm.schema.ticketEvents)
      .values({
        ticketId: ticket.id,
        projectId,
        kind: 'heartbeat',
        agent: AGENT,
        by: 'gate_test',
        at: ago(120_000),
      })
      .run()
    setCommand(commandFor(outFile()))
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(202)
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })

  it('a restart does not kill, or keep watching, a pid that now belongs to another process', async () => {
    const killed: number[] = []
    resume.setResumeRunner(
      fake({ alive: () => true, killTree: async (pid) => void killed.push(pid), identity: () => 'now' }),
    )
    setCommand('x')
    const mk = (identity: string | null, hours = 0) =>
      dbm.db
        .insert(dbm.schema.ticketResumes)
        .values({
          ticketId: asked().ticket.id,
          trigger: 'answer',
          state: 'running',
          pid: 4242,
          pidIdentity: identity,
          startedAt: new Date(Date.now() - hours * 3_600_000).toISOString(),
        })
        .returning()
        .get()
    const recycled = mk('then', 10)
    const ours = mk('now')
    const unknown = mk(null)
    resume.sweepResumes()
    expect(rowState(recycled.id)).toMatchObject({ state: 'succeeded', exitCode: null })
    expect(rowState(recycled.id).reason).toContain('not known')
    expect(rowState(ours.id).state).toBe('running')
    expect(rowState(unknown.id).state).toBe('running')
    expect(killed).toEqual([])
  })

  it('stores the process identity when it starts, and reads the real one on this machine', async () => {
    resume.setResumeRunner(
      fake({
        spawn: () => ({ pid: 777, exited: new Promise(() => {}) }),
        identity: (pid) => `id-${pid}`,
      }),
    )
    setCommand('anything')
    const { ticket, post } = asked()
    features.decide(post.id, 0, '', HUMAN)
    expect(rowsOf(ticket.id)[0]).toMatchObject({ state: 'running', pid: 777, pidIdentity: 'id-777' })
    const mine = resume.processIdentity(process.pid)
    if (process.platform === 'win32') expect(mine).toBeNull()
    else {
      expect(mine).toBeTruthy()
      expect(resume.processIdentity(process.pid)).toBe(mine)
      const child = trackStray(
        spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }),
      )
      const theirs = resume.processIdentity(child.pid!)
      expect(theirs).toBeTruthy()
      child.kill()
      await new Promise((r) => child.once('exit', r))
      expect(resume.processIdentity(child.pid!)).toBeNull()
    }
    if (process.platform === 'linux') {
      expect(
        resume.procStartTime('12 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23'),
      ).toBe('19')
    }
  })
})

describe('resume: an answer that reached an agent is recorded on its card', () => {
  /** Hours later: no signal of an agent on the ticket is recent, so only the answer's own history decides. */
  function hoursLater(ticketId: number) {
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString()
    dbm.db
      .update(dbm.schema.ticketEvents)
      .set({ at: old })
      .where(eq(dbm.schema.ticketEvents.ticketId, ticketId))
      .run()
    dbm.db
      .update(dbm.schema.updates)
      .set({ createdAt: old })
      .where(eq(dbm.schema.updates.ticketId, ticketId))
      .run()
  }

  /** A ticket whose first card started a resume that still runs, and a second card asked a while ago. */
  async function runningWithSecondCard() {
    const out = outFile()
    setCommand(commandFor(out, 'hang'))
    const { ticket, post } = asked('First?')
    features.decide(post.id, 0, '', HUMAN)
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'))
    const second = ask(ticket.id, 'Second?')
    askedLongAgo(second.id)
    const first = rowsOf(ticket.id).find((r) => r.pid !== null)!
    return { ticket, second, first }
  }

  it('an answer relayed while another resume runs, then edited, starts no process, now or later', async () => {
    const { ticket, second, first } = await runningWithSecondCard()
    features.relayDecision(second.id, { option: 0, words: 'sqlite' }, 'orch', { agent: true })
    features.decide(second.id, 1, 'edited while it runs', HUMAN)
    await resumeKill(first.id)
    hoursLater(ticket.id)
    features.decide(second.id, 0, 'edited after it ended', HUMAN)
    features.decide(second.id, 1, 'and again', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows.filter((r) => r.pid !== null)).toHaveLength(1)
    expect(rows.filter((r) => r.postId === second.id).every((r) => r.state === 'skipped')).toBe(true)
    expect(rows.at(-1)!.reason).toContain('the answer came from the chat')
    expect(repliesOf(second.id).at(-1)!.body).toContain('the agent that asked has the first answer')
  })

  it('an answer handed to a waiting agent while another resume runs, then edited, starts no process', async () => {
    const wait = await import('./answerWait')
    const { ticket, second, first } = await runningWithSecondCard()
    const p = wait.waitAndReport({ ticketId: ticket.id, postId: second.id, timeoutSeconds: 60, actor: AGENT })
    features.decide(second.id, 0, 'first words', HUMAN)
    expect(await p).toMatchObject({ answered: true, option: 0 })
    features.decide(second.id, 1, 'edited while it runs', HUMAN)
    await resumeKill(first.id)
    hoursLater(ticket.id)
    features.decide(second.id, 0, 'edited after it ended', HUMAN)
    const rows = rowsOf(ticket.id)
    expect(rows.filter((r) => r.pid !== null)).toHaveLength(1)
    expect(rows.at(-1)!.reason).toContain('delivered to the agent waiting for it')
    expect(repliesOf(second.id).at(-1)!.body).toContain('the agent has the first answer')
  })

  it('the delivered mark is on the card: set by the relay, the waiter and the start, never by a skip', async () => {
    const wait = await import('./answerWait')
    const markOf = (id: number) =>
      dbm.db.select().from(dbm.schema.updates).where(eq(dbm.schema.updates.id, id)).get()!.answerDelivered
    // A skip because a resume runs delivers nothing.
    const { ticket, second, first } = await runningWithSecondCard()
    features.decide(second.id, 0, '', HUMAN)
    expect(markOf(second.id)).toBe('')
    expect(markOf(first.postId!)).toBe('resume')
    await resumeKill(first.id)
    // A relay and a waiter mark their card.
    const relayed = ask(ticket.id, 'Third?')
    features.relayDecision(relayed.id, { option: 0, words: 'x' }, 'orch', { agent: true })
    expect(markOf(relayed.id)).toBe('chat')
    const waited = ask(ticket.id, 'Fourth?')
    const p = wait.waitAndReport({ ticketId: ticket.id, postId: waited.id, timeoutSeconds: 60, actor: AGENT })
    features.decide(waited.id, 0, '', HUMAN)
    await p
    expect(markOf(waited.id)).toBe('waiter')
  })

  it('Resume runs with the newest decided card, not the card of the last run', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked('First?')
    features.decide(post.id, 0, '', HUMAN)
    await until(() => rowsOf(ticket.id).length > 0 && rowsOf(ticket.id).every((r) => r.state !== 'running'))
    const second = ask(ticket.id, 'Second?')
    askedLongAgo(second.id)
    features.relayDecision(second.id, { option: 1, words: 'postgres, as I said' }, 'orch', { agent: true })
    features.decide(second.id, 0, 'sqlite after all', HUMAN)
    const again = outFile()
    setCommand(commandFor(again))
    const res = await call('POST', `/api/tickets/${ticket.id}/resume`)
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ trigger: 'retry', postId: second.id })
    await until(() => fs.existsSync(again) && fs.readFileSync(again, 'utf8').endsWith('}'))
    const prompt = read(again).stdin as string
    expect(prompt).toContain('Second?')
    expect(prompt).toContain('sqlite after all')
    expect(prompt).not.toContain('First?')
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })

  it('Resume uses the relayed words of the newest card, and the last run card when no newer one was answered', async () => {
    const out = outFile()
    setCommand(commandFor(out))
    const { ticket, post } = asked('First?')
    features.decide(post.id, 0, 'sqlite', HUMAN)
    await until(() => rowsOf(ticket.id).length > 0 && rowsOf(ticket.id).every((r) => r.state !== 'running'))
    // No newer answer: Resume goes on with the card the last run came from.
    const same = outFile()
    setCommand(commandFor(same))
    expect((await call('POST', `/api/tickets/${ticket.id}/resume`)).body).toMatchObject({ postId: post.id })
    await until(() => rowsOf(ticket.id).length > 1 && rowsOf(ticket.id).every((r) => r.state !== 'running'))
    expect(read(same).stdin).toContain('First?')
    // A newer card answered from the chat: Resume carries its words.
    const second = ask(ticket.id, 'Second?')
    askedLongAgo(second.id)
    features.relayDecision(second.id, { option: 1, words: 'postgres, as I said' }, 'orch', { agent: true })
    const third = outFile()
    setCommand(commandFor(third))
    expect((await call('POST', `/api/tickets/${ticket.id}/resume`)).body).toMatchObject({ postId: second.id })
    await until(() => fs.existsSync(third) && fs.readFileSync(third, 'utf8').endsWith('}'))
    expect(read(third).stdin).toContain('postgres, as I said')
    await until(() => rowsOf(ticket.id).every((r) => r.state !== 'running'))
  })
})
