import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import fs from 'node:fs'
import path from 'node:path'

import { and, desc, eq, isNull, like, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { config, logsDir } from './config'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { listRepos, resolveRepo } from './repos'
import { attachmentUrl, saveFromPath } from './uploads'

/**
 * A review run is one unattended `claude -p "/review-queue <repo> …"` per repo of the project, in turn.
 * The queue writes a ledger and one summary.md per PR under FEATURE_REVIEW_DIR; when the process
 * exits, those files (not the model's stdout) are what becomes review_results rows.
 */

const running = new Map<number, { runId: number; kill: () => void; cancelled: boolean }>()

export const isRunning = (projectId: number) => running.has(projectId)

export function listRuns(projectId: number, limit = 20) {
  return db
    .select({
      id: schema.reviewRuns.id,
      projectId: schema.reviewRuns.projectId,
      scheduleId: schema.reviewRuns.scheduleId,
      args: schema.reviewRuns.args,
      startedBy: schema.reviewRuns.startedBy,
      startedAt: schema.reviewRuns.startedAt,
      finishedAt: schema.reviewRuns.finishedAt,
      status: schema.reviewRuns.status,
      exitCode: schema.reviewRuns.exitCode,
      queueDir: schema.reviewRuns.queueDir,
    })
    .from(schema.reviewRuns)
    .where(eq(schema.reviewRuns.projectId, projectId))
    .orderBy(desc(schema.reviewRuns.startedAt))
    .limit(limit)
    .all()
}

export function getRun(id: number) {
  const run = db.select().from(schema.reviewRuns).where(eq(schema.reviewRuns.id, id)).get()
  if (!run) throw notFound('review run')
  return run
}

export function listResults(
  projectId: number,
  limit = 100,
  filter: { prNumber?: number; sha?: string; repoId?: number } = {},
) {
  return db
    .select()
    .from(schema.reviewResults)
    .where(
      and(
        eq(schema.reviewResults.projectId, projectId),
        filter.prNumber === undefined ? undefined : eq(schema.reviewResults.prNumber, filter.prNumber),
        // A result posted without a repo counts for every repo, as in the PR queue.
        filter.repoId === undefined
          ? undefined
          : or(eq(schema.reviewResults.repoId, filter.repoId), isNull(schema.reviewResults.repoId)),
        // Short and full SHAs both match.
        filter.sha ? like(schema.reviewResults.sha, `${filter.sha.slice(0, 7)}%`) : undefined,
      ),
    )
    .orderBy(desc(schema.reviewResults.createdAt))
    .limit(limit)
    .all()
    .filter((r) => !filter.sha || r.sha.startsWith(filter.sha) || filter.sha.startsWith(r.sha))
}

export function getResult(id: number) {
  const r = db.select().from(schema.reviewResults).where(eq(schema.reviewResults.id, id)).get()
  if (!r) throw notFound('review result')
  return r
}

export function startRun(projectId: number, args: string, actor: string, scheduleId: number | null = null) {
  getProject(projectId)
  const repos = listRepos(projectId)
  if (!repos.length) throw new HttpError(400, 'this project has no repos to review')
  if (running.has(projectId)) throw new HttpError(409, 'a review is already running for this project')
  const run = db
    .insert(schema.reviewRuns)
    .values({ projectId, scheduleId, args, startedBy: actor })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'review',
    text: `started a review run (${args || 'default'})`,
    refType: 'run',
    refId: run.id,
  })

  const startedAt = new Date(run.startedAt)
  const logFile = path.join(logsDir, `review-${run.id}.log`)
  const chunks: string[] = []
  const flush = () =>
    db
      .update(schema.reviewRuns)
      .set({ log: chunks.join('') })
      .where(eq(schema.reviewRuns.id, run.id))
      .run()
  const append = (s: string) => {
    chunks.push(s)
    fs.appendFileSync(logFile, s)
  }

  const timer = setInterval(flush, 2000)
  let kill = () => {}
  const state = { runId: run.id, kill: () => kill(), cancelled: false }
  running.set(projectId, state)

  // One `claude -p "/review-queue <repo> …"` per repo, one after the other, all logged into this run.
  const reviewRepo = (repo: schema.Repo) =>
    new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
      const prompt = `/review-queue ${repo.repoPath} ${args}`.trim()
      append(`${chunks.length ? '\n' : ''}$ ${config.claudeBin} -p "${prompt}"\n(cwd ${repo.repoPath})\n\n`)
      const child = spawn(
        config.claudeBin,
        ['-p', prompt, '--output-format', 'text', '--permission-mode', 'bypassPermissions'],
        {
          cwd: repo.repoPath,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'agent-board' },
        },
      )
      const out = new StringDecoder('utf8')
      const err = new StringDecoder('utf8')
      child.stdout.on('data', (d: Buffer) => append(out.write(d)))
      child.stderr.on('data', (d: Buffer) => append(err.write(d)))
      // claude spawns its own subprocesses; on Windows only a tree kill reaches them.
      kill = () => {
        if (process.platform === 'win32' && child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      }
      child.on('error', (e) =>
        resolve({ exitCode: null, error: `could not start ${config.claudeBin}: ${e.message}` }),
      )
      child.on('close', (code) => resolve({ exitCode: code }))
    })

  void (async () => {
    let failed = false
    let lastExit: number | null = null
    let imported = 0
    for (const repo of repos) {
      if (state.cancelled) break
      const { exitCode, error } = await reviewRepo(repo)
      lastExit = exitCode
      if (error) append(`\n[board] ${error}\n`)
      if (exitCode !== 0) failed = true
      try {
        const n = ingestLedger(repo, run.id, startedAt, actor)
        imported += n
        append(`\n[board] ${repo.name}: imported ${n} review result${n === 1 ? '' : 's'}\n`)
      } catch (err) {
        failed = true
        append(`\n[board] ${repo.name}: ingest failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
    clearInterval(timer)
    running.delete(projectId)
    const status: 'done' | 'error' | 'cancelled' = state.cancelled ? 'cancelled' : failed ? 'error' : 'done'
    const queueDir = findQueueDir(startedAt)
    db.update(schema.reviewRuns)
      .set({
        status,
        exitCode: lastExit,
        queueDir,
        finishedAt: new Date().toISOString(),
        log: chunks.join(''),
      })
      .where(eq(schema.reviewRuns.id, run.id))
      .run()
    logActivity({
      projectId,
      actor,
      kind: 'review',
      text: `review run finished (${status}, ${imported} PR${imported === 1 ? '' : 's'} reviewed)`,
      refType: 'run',
      refId: run.id,
    })
  })().catch((err) => {
    // Never leave the project stuck as "running" because the bookkeeping itself threw.
    clearInterval(timer)
    running.delete(projectId)
    console.error(`review run ${run.id} failed:`, err)
    db.update(schema.reviewRuns)
      .set({ status: 'error', finishedAt: new Date().toISOString(), log: chunks.join('') })
      .where(eq(schema.reviewRuns.id, run.id))
      .run()
  })
  return run
}

export function cancelRun(projectId: number, actor: string) {
  const r = running.get(projectId)
  if (!r) throw new HttpError(409, 'no review is running for this project')
  r.cancelled = true
  r.kill()
  logActivity({
    projectId,
    actor,
    kind: 'review',
    text: 'cancelled the running review',
    refType: 'run',
    refId: r.runId,
  })
}

// --- ingest ---

interface LedgerEntry {
  repo: string
  target: string
  sha: string
  verdict: string
  confirmed?: number
  plausible?: number
  refuted?: number
  unverified?: number
  merge?: string
  checks?: Record<string, string>
  stale?: boolean
  path: string
  at: string
}

/** The ledger writes git-bash paths (`/c/Users/...`) on Windows; Node wants `C:/Users/...`. */
export function nativePath(p: string): string {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p)
  return process.platform === 'win32' && m ? `${m[1].toUpperCase()}:/${m[2]}` : p
}

export function entryBelongsTo(
  entry: LedgerEntry,
  repo: Pick<schema.Repo, 'repoPath' | 'githubRepo'>,
): boolean {
  if (repo.githubRepo && entry.repo.toLowerCase().includes(repo.githubRepo.toLowerCase())) return true
  // Both separators: a Windows checkout path may be matched from Linux and vice versa.
  const dir = repo.repoPath.split(/[\\/]/).filter(Boolean).pop()!.toLowerCase()
  return entry.path.toLowerCase().includes(`/${dir}-pr-`) || entry.path.toLowerCase().includes(`\\${dir}-pr-`)
}

export function readLedger(since: Date): LedgerEntry[] {
  const file = path.join(config.featureReviewDir, 'ledger.jsonl')
  if (!fs.existsSync(file)) return []
  const entries: LedgerEntry[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as LedgerEntry
      if (new Date(e.at) >= since) entries.push(e)
    } catch {
      // a half-written line while a review is still running; skip it
    }
  }
  return entries
}

function findQueueDir(since: Date): string | null {
  if (!fs.existsSync(config.featureReviewDir)) return null
  const dirs = fs
    .readdirSync(config.featureReviewDir)
    .filter((n) => n.startsWith('queue-'))
    .map((n) => path.join(config.featureReviewDir, n))
    .filter((p) => fs.statSync(p).mtime >= since)
    .sort()
  return dirs.at(-1) ?? null
}

/** Copy `![…](shots/x.png)` images next to summary.md into uploads and point the markdown at them. */
export function importImages(md: string, baseDir: string, actor: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, src: string) => {
    if (/^https?:\/\//.test(src)) return whole
    const file = path.resolve(baseDir, src)
    if (!fs.existsSync(file)) return whole
    return `![${alt}](${attachmentUrl(saveFromPath(file, actor))})`
  })
}

function ingestLedger(repo: schema.Repo, runId: number, since: Date, actor: string): number {
  let n = 0
  for (const entry of readLedger(since)) {
    if (!entryBelongsTo(entry, repo)) continue
    const prNumber = Number(/\bpr\s+(\d+)/i.exec(entry.target)?.[1])
    if (!prNumber) continue
    const reviewPath = nativePath(entry.path)
    const dir = path.dirname(reviewPath)
    const summaryFile = path.join(dir, 'summary.md')
    let summaryMd = fs.existsSync(summaryFile)
      ? fs.readFileSync(summaryFile, 'utf8')
      : `_No summary.md next to ${reviewPath}._`
    summaryMd = importImages(summaryMd, dir, actor)
    db.insert(schema.reviewResults)
      .values({
        projectId: repo.projectId,
        repoId: repo.id,
        runId,
        prNumber,
        sha: entry.sha,
        verdict: entry.verdict,
        checks: entry.checks ?? {},
        counts: {
          confirmed: entry.confirmed ?? 0,
          plausible: entry.plausible ?? 0,
          refuted: entry.refuted ?? 0,
          unverified: entry.unverified ?? 0,
        },
        summaryMd,
        reviewPath,
        author: actor,
      })
      .run()
    n++
  }
  return n
}

/** An agent that reviewed by hand (or any other tool) posts its result here. */
export function postResult(
  projectId: number,
  input: {
    prNumber: number
    sha: string
    verdict: string
    summaryMd: string
    checks?: Record<string, string>
    counts?: Record<string, number>
    repoId?: number | null
  },
  actor: string,
) {
  getProject(projectId)
  const repo = resolveRepo(projectId, input.repoId)
  const row = db
    .insert(schema.reviewResults)
    .values({
      projectId,
      repoId: repo.id,
      prNumber: input.prNumber,
      sha: input.sha,
      verdict: input.verdict,
      summaryMd: input.summaryMd,
      checks: input.checks ?? {},
      counts: input.counts ?? {},
      author: actor,
    })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'review',
    text: `posted a review of PR #${input.prNumber}: ${input.verdict}`,
    refType: 'review',
    refId: row.id,
  })
  return row
}

// --- schedules ---

export function listSchedules(projectId: number) {
  return db.select().from(schema.reviewSchedules).where(eq(schema.reviewSchedules.projectId, projectId)).all()
}

export function createSchedule(
  projectId: number,
  input: { time: string; days: number; args: string; enabled: boolean },
  actor: string,
) {
  getProject(projectId)
  const row = db
    .insert(schema.reviewSchedules)
    .values({ projectId, ...input, lastRunAt: new Date().toISOString() })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'schedule',
    text: `scheduled reviews at ${input.time}`,
    refType: 'schedule',
    refId: row.id,
  })
  return row
}

export function updateSchedule(
  id: number,
  patch: Partial<{ time: string; days: number; args: string; enabled: boolean }>,
  actor: string,
) {
  const s = db.select().from(schema.reviewSchedules).where(eq(schema.reviewSchedules.id, id)).get()
  if (!s) throw notFound('schedule')
  const retimed = patch.time !== undefined || patch.days !== undefined || patch.enabled === true
  const row = db
    .update(schema.reviewSchedules)
    .set(retimed ? { ...patch, lastRunAt: new Date().toISOString() } : patch)
    .where(eq(schema.reviewSchedules.id, id))
    .returning()
    .get()!
  logActivity({
    projectId: s.projectId,
    actor,
    kind: 'schedule',
    text: `updated the review schedule (${row.time}, ${row.enabled ? 'on' : 'off'})`,
    refType: 'schedule',
    refId: id,
  })
  return row
}

export function deleteSchedule(id: number, actor: string) {
  const s = db.select().from(schema.reviewSchedules).where(eq(schema.reviewSchedules.id, id)).get()
  if (!s) throw notFound('schedule')
  db.delete(schema.reviewSchedules).where(eq(schema.reviewSchedules.id, id)).run()
  logActivity({
    projectId: s.projectId,
    actor,
    kind: 'schedule',
    text: `removed the ${s.time} review schedule`,
  })
}

/** Local wall-clock check: due when today's slot has passed and nothing ran since it. */
export function isDue(
  s: Pick<schema.ReviewSchedule, 'time' | 'days' | 'enabled' | 'lastRunAt'>,
  now: Date,
): boolean {
  if (!s.enabled) return false
  if (!((s.days >> now.getDay()) & 1)) return false
  const [hh, mm] = s.time.split(':').map(Number)
  const slot = new Date(now)
  slot.setHours(hh, mm, 0, 0)
  if (now < slot) return false
  return !s.lastRunAt || new Date(s.lastRunAt) < slot
}

export function tickSchedules(now = new Date()) {
  for (const s of db.select().from(schema.reviewSchedules).all()) {
    if (!isDue(s, now) || running.has(s.projectId)) continue
    db.update(schema.reviewSchedules)
      .set({ lastRunAt: now.toISOString() })
      .where(eq(schema.reviewSchedules.id, s.id))
      .run()
    try {
      startRun(s.projectId, s.args, 'scheduler', s.id)
    } catch (err) {
      console.error(`schedule ${s.id} could not start:`, err instanceof Error ? err.message : err)
    }
  }
}
