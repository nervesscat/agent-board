// The benchmark's datasets: a copy of the live board's data, and a generated large one. Both are
// written into a folder of the harness's own; the live data is only ever read, through SQLite's
// backup API, the way `pnpm dev` copies it.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const norm = (p) => {
  const abs = path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}
const inside = (child, parent) => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + path.sep)
}

/**
 * Refuses a data folder for the benchmarked server that is, holds or sits in one of `forbidden` (the
 * live board's data folder, a checkout's data/ or data/dev): the bench only ever runs on its own copy.
 */
export function assertBenchDataDir(dir, forbidden) {
  for (const f of forbidden)
    if (inside(dir, f) || inside(f, dir))
      throw new Error(`refusing to use ${dir} as the benchmark's DATA_DIR: it overlaps ${f}`)
}

/** Rows per table, for the results. */
export function tableCounts(dbFile) {
  const db = new Database(dbFile, { readonly: true })
  try {
    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
      )
      .all()
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.prepare(`select count(*) as n from "${name}"`).get().n]),
    )
  } finally {
    db.close()
  }
}

const stat = (file) => {
  try {
    const s = fs.statSync(file)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Copies the live board's database (a backup: it is in WAL mode and may be open) and its uploads into
 * `dest`. Answers null when there is no live data to copy.
 */
export async function copyLive(liveDir, dest) {
  const source = path.join(liveDir, 'board.db')
  if (!fs.existsSync(source)) return null
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const before = stat(source)
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await db.backup(path.join(dest, 'board.db'))
  } finally {
    db.close()
  }
  if (fs.existsSync(path.join(liveDir, 'uploads')))
    fs.cpSync(path.join(liveDir, 'uploads'), path.join(dest, 'uploads'), { recursive: true })
  return { source: liveDir, before, after: stat(source) }
}

// --- the generated dataset ---

/** A small seeded generator (mulberry32), so the same seed and scale give the same rows. */
export function prng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min, max) => min + Math.floor(next() * (max - min + 1))
  return { next, int, pick: (list) => list[int(0, list.length - 1)], chance: (p) => next() < p }
}

const WORDS = (
  'board ticket lane branch review merge commit build server client query index cache poll render ' +
  'agent human preview worktree upload attachment summary inbox thread post reply decision stage ' +
  'migration schema endpoint payload latency bundle route feed task progress handoff note ' +
  'origin fetch push queue check deploy fix test spec refactor layout dialog button sidebar column'
).split(' ')

function sentence(r, min = 6, max = 16) {
  const words = Array.from({ length: r.int(min, max) }, () => r.pick(WORDS))
  const s = words.join(' ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

function markdown(r, paragraphs) {
  const out = []
  for (let i = 0; i < paragraphs; i++) {
    const kind = r.int(0, 9)
    if (kind === 0)
      out.push(
        '```ts\n' + Array.from({ length: r.int(2, 8) }, () => `// ${sentence(r)}`).join('\n') + '\n```',
      )
    else if (kind <= 2)
      out.push(Array.from({ length: r.int(2, 6) }, () => `- ${sentence(r, 3, 10)}`).join('\n'))
    else if (kind === 3)
      out.push(`**${sentence(r, 2, 5)}** ${sentence(r)} [link](https://example.com/${r.pick(WORDS)})`)
    else out.push(Array.from({ length: r.int(1, 4) }, () => sentence(r)).join(' '))
  }
  return out.join('\n\n')
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A real PNG of noise (it hardly compresses), so attachments weigh what screenshots do. */
function png(r, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let i = 0; i < raw.length; i++) raw[i] = i % (width * 3 + 1) === 0 ? 0 : r.int(0, 255)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const STAGES = [
  ['backlog', 'Backlog', 'open', 'slate'],
  ['todo', 'To do', 'open', 'gray'],
  ['in_progress', 'In progress', 'active', 'sky'],
  ['blocked', 'Blocked', 'blocked', 'amber'],
  ['review', 'In review', 'review', 'violet'],
  ['done', 'Done', 'done', 'emerald'],
  ['cancelled', 'Cancelled', 'cancelled', 'slate'],
]
const STATUS_WEIGHTS = [
  ['backlog', 12],
  ['todo', 14],
  ['in_progress', 14],
  ['blocked', 5],
  ['review', 10],
  ['done', 40],
  ['cancelled', 5],
]
export const GENERATED_HUMAN = 'bench-human'
const AGENTS = ['claude', 'codex', 'opencode-agent']
const PROJECT_AGENTS = ['spec', 'builder', 'verify']
// The report schedule of project p is REPORT_CADENCE[p % 4]: half keep a daily report, a quarter a
// weekly one (due on Fridays), the rest none. Each with a shift of its own, its report due at its end.
const REPORT_CADENCE = ['daily', 'weekly', 'daily', 'off']
const SHIFTS = [
  ['08:00', '16:00'],
  ['09:00', '17:00'],
  ['09:30', '18:00'],
  ['10:00', '19:00'],
]
const REPORT_TEMPLATE = '## Done\n\n## In progress\n\n## Blocked\n\n## Next'
const TAGS = ['API', 'UI', 'Performance', 'Bug', 'Refactor', 'High', 'Medium', 'Low', 'Docs', 'Forms']

/** How much a scale of 1 generates; every count is multiplied by the scale. */
export function generatedPlan(scale = 1) {
  const n = (x, min = 1) => Math.max(min, Math.round(x * scale))
  return {
    projects: n(20, 2),
    rootTickets: n(40, 4),
    // The first project is the busy one: three times the tickets, and one ticket with a long feed.
    bigProjectFactor: 3,
    bigTicketPosts: n(300, 20),
    bigTicketLanes: n(24, 3),
    prsPerProject: n(25, 2),
    reviewsPerProject: n(10, 1),
    days: DAYS,
  }
}

// --- the generated dataset's clock ---
//
// The board buckets by the server's local calendar day (what happened today, since when a ticket is in
// progress, which report is missing) and compares ages with whole days of elapsed time (a ticket in
// progress with no post for a day is stalled; a PR merged in the last 14 days is in the queue). The
// server's clock cannot be set, so the dataset is laid out relative to the local day it is generated
// on, the same way whatever the hour: the rows are written on a virtual clock (0 is the start of
// today, `VIRTUAL_NOW` is now, earlier days are negative), and the rows of each virtual day land in a
// slot of `SLOT_MS` early in its local calendar day, placed so that from the moment the dataset may be
// generated (`ready`) until the day ends, a row of k days ago is between k and k + 1 whole days old.
// On most days each slot is the first minute of its day, and `ready` is a minute after midnight.
// Calendar days are not all 24 h long, though: when a daylight saving change makes the days from day
// k ago through today an hour longer than k + 1 whole days, day k's slot starts an hour after its
// midnight (or the rows would be k + 1 whole days old before the day is over); when it makes them an
// hour shorter, `ready` is an hour after today's midnight (or the rows would be under k whole days old
// before then). So on the day the clocks go back, and for the 60 days after they go forward, the
// dataset waits until 1:01 to be generated. A run that crosses midnight sees a new day: the harness
// writes the dataset again for it (`bench.mjs`).

const DAY = 86_400_000
/** How many days back the generated dataset goes. */
const DAYS = 60
/** Where now is on the virtual clock: today has had half a day of work. */
export const VIRTUAL_NOW = DAY / 2
/** The part of each local day that holds that day's rows. */
export const SLOT_MS = 60_000

/** The local calendar day of `ms`, YYYY-MM-DD, as the board names days. */
export function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The Monday of the week a local day (YYYY-MM-DD) is in: a weekly report's period. */
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number)
  const noon = new Date(y, m - 1, d, 12)
  noon.setDate(d - ((noon.getDay() + 6) % 7))
  return localDay(noon.getTime())
}

/** The local midnight that starts the day of `ms`. */
export function startOfLocalDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How long until a dataset can be generated (0: now), see `anchoredClock`. */
export const msUntilSlot = (now = Date.now()) => Math.max(0, anchoredClock(now).ready - now)

/**
 * The moment to generate a dataset for (`generate`'s `now`): the one clock read the wait was decided
 * on, so that a later read (past the next midnight, before that day's ready moment) cannot be refused.
 * Too soon after midnight, it calls `onWait(ms)`, waits that long and reads the clock again.
 */
export async function generationMoment({
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait = () => {},
} = {}) {
  for (;;) {
    const now = clock()
    const wait = msUntilSlot(now)
    if (wait === 0) return now
    onWait(wait)
    await sleep(wait + 100)
  }
}

/**
 * The clock of a dataset generated on the local day of `now`: `real(v)` is the real moment of a
 * virtual one, where virtual day `d` (0 today, -1 yesterday) is local calendar day `d` from now's and a
 * moment's place in its virtual day is its place in that day's slot; `ready` is the first moment it
 * can be generated (above).
 */
export function anchoredClock(now) {
  const today = startOfLocalDay(now)
  const midnight = (d) => {
    const x = new Date(today)
    x.setDate(x.getDate() + d)
    return x.getTime()
  }
  const tomorrow = midnight(1)
  // Day k ago's slot: its midnight, or as much later as the days from it through today are longer
  // than k + 1 whole days, so that its rows are under k + 1 whole days old until tomorrow.
  const slots = new Map()
  const slot = (k) => {
    if (!slots.has(k)) {
      const start = midnight(-k)
      slots.set(k, start + Math.max(0, tomorrow - start - (k + 1) * DAY))
    }
    return slots.get(k)
  }
  // The first moment each day's rows are over k whole days old, past the end of its slot.
  let ready = 0
  for (let k = 0; k <= DAYS; k++) ready = Math.max(ready, slot(k) + k * DAY + SLOT_MS)
  const real = (v) => {
    const day = Math.floor(v / DAY)
    return slot(-day) + Math.floor(((v - day * DAY) / DAY) * SLOT_MS)
  }
  return { day: localDay(today), ready, real }
}

/**
 * The local days a generated dataset was laid out on during one benchmark, in `generator.days`: the
 * day it was first written for (`generator.day`, which stays that day), then each day it was written
 * again for. `over()`: the last of them has ended.
 */
export function laidOutDays(generator) {
  generator.days = [generator.day]
  return {
    over: (now = Date.now()) => localDay(now) !== generator.days.at(-1),
    writtenAgain: (day) => generator.days.push(day),
  }
}

/**
 * Writes a large dataset into `dest`: a database migrated with `migrationsFolder` (the target's own
 * migrations) and filled from a seed, the attachments' bytes where local storage keeps them
 * (`uploads/<stored_as>`), and a git repo with an origin for the projects' repos to point at. `now` is
 * the moment it is generated for: the rows are laid out on its local day (above), and it must be no
 * earlier than that day's `ready` moment (`msUntilSlot`), or rows would be in its future or younger
 * than the whole days they stand for.
 */
export function generate(dest, { scale = 1, seed = 1, migrationsFolder, now: generatedAt = Date.now() }) {
  const clock = anchoredClock(generatedAt)
  if (generatedAt < clock.ready)
    throw new Error(
      `a dataset generated this soon after midnight (before ${new Date(clock.ready).toString()}) would put rows in the future or make them younger than their whole days; wait ${clock.ready - generatedAt} ms`,
    )
  // Every moment below is on the virtual clock; `iso` and `dayOf` turn one into a real one.
  const now = VIRTUAL_NOW
  const plan = generatedPlan(scale)
  const r = prng(seed)
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 })
  fs.mkdirSync(path.join(dest, 'uploads'), { recursive: true })
  const sqlite = new Database(path.join(dest, 'board.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder })

  const iso = (v) => new Date(clock.real(v)).toISOString()
  const dayOf = (v) => localDay(clock.real(v))
  const ago = (maxDays) => now - Math.floor(r.next() * maxDays * DAY)
  const ins = (table, cols) =>
    sqlite.prepare(`insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
  const q = {
    project: ins('projects', ['name', 'instructions', 'createdAt']),
    stage: ins('stages', ['project_id', 'key', 'name', 'kind', 'color', 'position']),
    agent: ins('agents', [
      'project_id',
      'name',
      'instructions',
      'delegation',
      'created_by',
      'createdAt',
      'updatedAt',
    ]),
    repo: ins('repos', ['project_id', 'name', 'repo_path', 'github_repo', 'base_branch', 'createdAt']),
    ticket: ins('tickets', [
      'project_id',
      'repo_id',
      'parent_id',
      'title',
      'body',
      'status',
      'assignee',
      'branch',
      'base_branch',
      'pr_number',
      'created_by',
      'tags',
      'approved_at',
      'approved_by',
      'archived_at',
      'archived_by',
      'started_at',
      'createdAt',
      'updatedAt',
    ]),
    need: ins('ticket_needs', ['ticket_id', 'needs_id']),
    task: ins('tasks', ['ticket_id', 'text', 'done', 'position']),
    workspace: ins('workspaces', ['ticket_id', 'name', 'branch', 'path', 'agent', 'createdAt']),
    update: ins('updates', [
      'ticket_id',
      'author',
      'via',
      'body',
      'progress',
      'decision',
      'decided_option',
      'decided_by',
      'decided_at',
      'createdAt',
    ]),
    comment: ins('comments', ['parent_type', 'parent_id', 'reply_to', 'author', 'body', 'createdAt']),
    attachment: ins('attachments', [
      'update_id',
      'comment_id',
      'ticket_id',
      'name',
      'mime',
      'size',
      'stored_as',
      'uploaded_by',
      'createdAt',
    ]),
    pr: ins('prs', [
      'project_id',
      'repo_id',
      'number',
      'title',
      'url',
      'author',
      'head_ref',
      'base_ref',
      'head_sha',
      'is_draft',
      'review_decision',
      'my_review',
      'waiting_on',
      'review_stage',
      'mergeable',
      'merge_state_status',
      'checks',
      'updated_at',
      'fetched_at',
      'open',
      'merged_at',
      'closed_at',
    ]),
    review: ins('review_results', [
      'project_id',
      'repo_id',
      'pr_number',
      'sha',
      'verdict',
      'checks',
      'counts',
      'summary_md',
      'author',
      'createdAt',
    ]),
    activity: ins('activity', ['project_id', 'actor', 'kind', 'ref_type', 'ref_id', 'text', 'createdAt']),
    reportSettings: ins('report_settings', [
      'project_id',
      'prompt',
      'template',
      'cadence',
      'weekday',
      'shift_start',
      'shift_end',
      'workdays',
      'alert_minutes',
      'format',
      'since',
      'updated_by',
      'updatedAt',
    ]),
    report: ins('reports', ['project_id', 'cadence', 'period', 'body', 'author', 'createdAt']),
    actor: ins('actors', ['name', 'kind', 'last_seen_at']),
  }

  // A pool of files the attachments copy their bytes from: screenshots and markdown notes.
  const images = Array.from({ length: 24 }, () => png(r, r.int(80, 200), r.int(60, 140)))
  const notes = Array.from({ length: 12 }, () => Buffer.from(markdown(r, r.int(10, 40))))
  let fileNo = 0
  const attach = (owner, at, by) => {
    const image = r.chance(0.7)
    const bytes = image ? r.pick(images) : r.pick(notes)
    const ext = image ? '.png' : '.md'
    const storedAs = `${crypto.createHash('sha1').update(`${seed}:${++fileNo}`).digest('hex').slice(0, 32)}${ext}`
    fs.writeFileSync(path.join(dest, 'uploads', storedAs), bytes)
    q.attachment.run(
      owner.updateId ?? null,
      owner.commentId ?? null,
      owner.ticketId ?? null,
      image ? `screenshot-${fileNo}.png` : `notes-${fileNo}.md`,
      image ? 'image/png' : 'text/markdown',
      bytes.length,
      storedAs,
      by,
      iso(at),
    )
  }
  const weighted = (pairs) => {
    let x = r.next() * pairs.reduce((s, [, w]) => s + w, 0)
    for (const [v, w] of pairs) if ((x -= w) < 0) return v
    return pairs[0][0]
  }
  const people = [GENERATED_HUMAN, ...AGENTS]
  let ticketNo = 0

  const repoDir = path.join(dest, 'repos', 'app')
  /** Branches to create in the repo: name, parent branch (null: main), whether origin has it, ahead. */
  const branches = []

  const fill = sqlite.transaction(() => {
    q.actor.run(GENERATED_HUMAN, 'human', iso(now))
    for (const a of AGENTS) q.actor.run(a, 'agent', iso(now - r.int(0, 3) * 3_600_000))

    for (let p = 0; p < plan.projects; p++) {
      const created = now - plan.days * DAY
      const projectId = q.project.run(`project-${p + 1}`, markdown(r, 3), iso(created)).lastInsertRowid
      STAGES.forEach(([key, name, kind, color], i) => q.stage.run(projectId, key, name, kind, color, i))
      for (const name of PROJECT_AGENTS)
        q.agent.run(
          projectId,
          name,
          markdown(r, 12),
          markdown(r, 4),
          GENERATED_HUMAN,
          iso(created),
          iso(created),
        )
      const repoId = q.repo.run(projectId, 'app', repoDir, null, 'main', iso(created)).lastInsertRowid
      const cadence = REPORT_CADENCE[p % REPORT_CADENCE.length]
      if (cadence !== 'off') {
        const [shiftStart, shiftEnd] = r.pick(SHIFTS)
        q.reportSettings.run(
          projectId,
          markdown(r, 2),
          r.chance(0.5) ? '' : REPORT_TEMPLATE,
          cadence,
          5,
          shiftStart,
          shiftEnd,
          // The busy project's agents report every day: a day without its report is missing whatever
          // the weekday, so its report periods read the same on any day of the week (`listReports`).
          JSON.stringify(p === 0 ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5]),
          r.pick([15, 30, 60]),
          'text',
          cadence === 'daily' ? dayOf(created) : mondayOf(dayOf(created)),
          GENERATED_HUMAN,
          iso(created),
        )
      }
      // The reports, in the periods the Daily page shows by default: two weeks of days, eight weeks. A
      // period can have several versions (posted again later; the latest is its report). The current
      // period always has its report: one still to write would be due or missing depending on the hour
      // (`reportDue`), and the dataset reads the same at any hour; earlier periods are done or missing.
      const periods = cadence === 'daily' ? 14 : cadence === 'weekly' ? 8 : 0
      const step = cadence === 'daily' ? DAY : 7 * DAY
      for (let k = 0; k < periods; k++) {
        if (k > 0 && !r.chance(cadence === 'daily' ? 0.7 : 0.8)) continue
        const versions = r.chance(0.25) ? 2 : 1
        for (let v = versions - 1; v >= 0; v--) {
          const at = now - k * step - v * 3_600_000
          const period = cadence === 'daily' ? dayOf(at) : mondayOf(dayOf(at))
          q.report.run(projectId, cadence, period, markdown(r, r.int(2, 5)), r.pick(AGENTS), iso(at))
        }
      }

      const ticketIds = []
      const roots = plan.rootTickets * (p === 0 ? plan.bigProjectFactor : 1)
      const makeTicket = (parent, depth, big = false) => {
        const createdAt = parent ? Math.max(parent.createdAt, ago(plan.days)) : ago(plan.days)
        const status = big ? 'in_progress' : weighted(STATUS_WEIGHTS)
        const working = ['in_progress', 'blocked', 'review', 'done'].includes(status)
        const assignee = working || r.chance(0.3) ? r.pick(people) : ''
        const branch = working || big ? `t${++ticketNo}-${r.pick(WORDS)}` : ''
        const baseBranch = parent?.branch || 'main'
        const archived = !big && status === 'done' && !parent && r.chance(0.35)
        const updatedAt = Math.min(now, createdAt + r.int(0, 10) * DAY)
        const id = q.ticket.run(
          projectId,
          repoId,
          parent?.id ?? null,
          big ? `The busy ticket of project ${p + 1}` : sentence(r, 3, 9).slice(0, -1),
          markdown(r, r.int(1, big ? 30 : 8)),
          status,
          assignee,
          branch,
          baseBranch,
          status === 'review' && r.chance(0.6) ? r.int(1, plan.prsPerProject) : null,
          r.pick(people),
          JSON.stringify(Array.from({ length: r.int(0, 2) }, () => r.pick(TAGS))),
          status === 'done' && r.chance(0.5) ? iso(updatedAt) : null,
          status === 'done' ? GENERATED_HUMAN : '',
          archived ? iso(updatedAt) : null,
          archived ? GENERATED_HUMAN : '',
          working ? iso(createdAt) : null,
          iso(createdAt),
          iso(updatedAt),
        ).lastInsertRowid
        const t = { id, branch, createdAt, status }
        ticketIds.push(id)
        if (branch)
          branches.push({
            name: branch,
            parent: parent?.branch || null,
            pushed: !r.chance(0.2),
            ahead: r.chance(0.2),
          })
        if (r.chance(0.04)) attach({ ticketId: id }, createdAt, r.pick(people))

        const tasks = r.int(0, 8)
        for (let i = 0; i < tasks; i++)
          q.task.run(id, sentence(r, 3, 8), r.chance(status === 'done' ? 0.9 : 0.4) ? 1 : 0, i)
        if (branch && r.chance(0.4)) q.workspace.run(id, branch, branch, '', r.pick(AGENTS), iso(createdAt))
        q.activity.run(
          projectId,
          r.pick(people),
          'ticket',
          'ticket',
          id,
          `created ${branch || 'a ticket'}`,
          iso(createdAt),
        )

        // The busy ticket is being worked right now: its feed runs up to now and ends in a progress
        // post, so the board has work going on (not stalled) whatever the seed.
        const posts = big ? plan.bigTicketPosts : r.int(0, 16)
        for (let i = 0; i < posts; i++) {
          const share = big ? (i + 1) / posts : (i + 1) / (posts + 1)
          const at = Math.min(now, createdAt + Math.floor(share * (now - createdAt)))
          const latest = big && i === posts - 1
          const author = r.pick(people)
          const decision = r.chance(0.03)
          const decided = decision && r.chance(0.5)
          const updateId = q.update.run(
            id,
            author,
            author === GENERATED_HUMAN ? '' : r.pick(['', AGENTS[0]]),
            markdown(r, r.int(1, 7)),
            r.chance(0.7) || latest ? 1 : 0,
            decision
              ? JSON.stringify([
                  { label: sentence(r, 2, 4), detail: sentence(r), recommended: true },
                  { label: sentence(r, 2, 4), detail: sentence(r) },
                ])
              : null,
            decided ? 0 : null,
            decided ? GENERATED_HUMAN : '',
            decided ? iso(at) : null,
            iso(at),
          ).lastInsertRowid
          q.activity.run(projectId, author, 'update', 'ticket', id, sentence(r, 4, 10), iso(at))
          if (r.chance(0.05)) for (let k = r.int(1, 2); k > 0; k--) attach({ updateId }, at, author)
          if (r.chance(big ? 0.5 : 0.25)) {
            let previous = null
            for (let k = r.int(1, big ? 12 : 6); k > 0; k--) {
              const who = r.pick(people)
              const commentId = q.comment.run(
                'update',
                updateId,
                previous && r.chance(0.3) ? previous : null,
                who,
                markdown(r, r.int(1, 3)),
                iso(Math.min(now, at + k * 600_000)),
              ).lastInsertRowid
              previous = commentId
              q.activity.run(projectId, who, 'comment', 'update', updateId, sentence(r, 3, 8), iso(at))
              if (r.chance(0.02)) attach({ commentId }, at, who)
            }
          }
        }

        const lanes = big
          ? plan.bigTicketLanes
          : depth === 0
            ? weighted([
                [0, 50],
                [r.int(1, 2), 25],
                [r.int(3, 6), 25],
              ])
            : depth === 1 && r.chance(0.2)
              ? r.int(1, 3)
              : 0
        for (let i = 0; i < lanes; i++) makeTicket(t, depth + 1, false)
        return t
      }
      for (let i = 0; i < roots; i++) makeTicket(null, 0, p === 0 && i === 0)
      for (const id of ticketIds)
        if (r.chance(0.03)) {
          const other = r.pick(ticketIds)
          if (other !== id) q.need.run(id, other)
        }

      for (let n = 1; n <= plan.prsPerProject; n++) {
        const open = n > plan.prsPerProject / 2
        const merged = !open && r.chance(0.7)
        const at = open ? ago(10) : ago(13)
        const head = crypto.createHash('sha1').update(`${seed}:${p}:${n}`).digest('hex')
        const prId = q.pr.run(
          projectId,
          repoId,
          n,
          sentence(r, 3, 8).slice(0, -1),
          `https://github.com/bench/app/pull/${n}`,
          r.pick(people),
          `pr-${n}`,
          'main',
          head,
          r.chance(0.1) ? 1 : 0,
          r.pick([null, 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']),
          r.pick(['none', 'approved', 'commented']),
          r.pick(['me', 'others']),
          r.pick(['pending', 'reviewed', 'on_hold']),
          r.pick(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
          r.pick(['CLEAN', 'BEHIND', 'BLOCKED', 'DIRTY']),
          JSON.stringify(
            Array.from({ length: r.int(0, 6) }, (_, i) => ({
              name: `check-${i}`,
              state: r.pick(['pass', 'fail', 'pending']),
              url: null,
            })),
          ),
          iso(at),
          iso(at),
          open ? 1 : 0,
          merged ? iso(at) : null,
          open ? null : iso(at),
        ).lastInsertRowid
        if (r.chance(0.3))
          for (let k = r.int(1, 4); k > 0; k--)
            q.comment.run('pr', prId, null, r.pick(people), markdown(r, 2), iso(at))
      }
      for (let k = 0; k < plan.reviewsPerProject; k++) {
        const at = ago(plan.days)
        const id = q.review.run(
          projectId,
          repoId,
          r.int(1, plan.prsPerProject),
          crypto.createHash('sha1').update(`${seed}:review:${p}:${k}`).digest('hex'),
          r.pick(['SHIP', 'FIX FIRST', 'COULD NOT VERIFY']),
          JSON.stringify({ reliable: 'YES', works: r.pick(['YES', 'NO']) }),
          JSON.stringify({ confirmed: r.int(0, 3), refuted: r.int(0, 3), passed: r.int(10, 40) }),
          markdown(r, r.int(4, 14)),
          r.pick(AGENTS),
          iso(at),
        ).lastInsertRowid
        q.activity.run(projectId, r.pick(AGENTS), 'review', 'review', id, sentence(r), iso(at))
      }
    }
  })
  fill()
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  sqlite.close()

  // Its commits are from early yesterday.
  makeRepo(path.join(dest, 'repos'), branches, clock.real(-DAY))
  return { plan, scale, seed, day: clock.day, counts: tableCounts(path.join(dest, 'board.db')) }
}

/**
 * The repo every generated project points at: main, a branch per ticket that has one (a lane's on its
 * parent's), most of them pushed to a bare origin beside it, some with commits origin lacks.
 */
function makeRepo(dir, branches, from) {
  const repo = path.join(dir, 'app')
  const origin = path.join(dir, 'app.git')
  fs.mkdirSync(repo, { recursive: true })
  const git = (cwd, args, input) =>
    execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...args], {
      cwd,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  git(dir, ['init', '-q', '--bare', '-b', 'main', origin])
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', origin])

  const when = Math.floor(from / 1000)
  let mark = 0
  const lines = []
  const commit = (ref, from, file, message) => {
    const m = ++mark
    const content = `${message}\n`
    lines.push(
      `commit ${ref}`,
      `mark :${m}`,
      `committer bench <bench@example.com> ${when + m} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
    )
    if (from) lines.push(`from ${from}`)
    lines.push(`M 644 inline ${file}`, `data ${Buffer.byteLength(content)}`, content)
    return `:${m}`
  }
  const marks = new Map()
  marks.set('main', commit('refs/heads/main', null, 'README.md', 'init'))
  const pending = [...branches]
  // Parents first: a lane's branch starts from its parent ticket's.
  while (pending.length) {
    const i = pending.findIndex((b) => !b.parent || marks.has(b.parent))
    const b = pending.splice(i === -1 ? 0 : i, 1)[0]
    marks.set(
      b.name,
      commit(
        `refs/heads/${b.name}`,
        marks.get(b.parent ?? 'main') ?? marks.get('main'),
        `${b.name}.txt`,
        b.name,
      ),
    )
  }
  git(repo, ['fast-import', '--quiet'], lines.join('\n') + '\n')
  git(repo, ['reset', '-q', '--hard', 'main'])
  git(repo, ['push', '-q', 'origin', '--all'])
  // Then the local-only branches leave origin, and some branches get commits origin does not have.
  const after = []
  mark = 0
  lines.length = 0
  for (const b of branches) {
    if (!b.pushed) after.push(`:refs/heads/${b.name}`)
    else if (b.ahead)
      commit(`refs/heads/${b.name}`, `refs/heads/${b.name}^0`, `${b.name}.txt`, `${b.name} more`)
  }
  if (lines.length) git(repo, ['fast-import', '--quiet'], lines.join('\n') + '\n')
  for (let i = 0; i < after.length; i += 200) git(repo, ['push', '-q', 'origin', ...after.slice(i, i + 200)])
}

/**
 * What the benchmark measures in a dataset: the project with the most tickets on its board, its
 * ticket with the longest feed (any) and the longest on the board (top level, not archived), the post
 * with the most replies, an image attachment, and who the human and the agent are.
 */
export function pickTargets(dbFile) {
  const db = new Database(dbFile, { readonly: true })
  try {
    const one = (sql, ...args) => db.prepare(sql).get(...args)
    const project = one(
      'select project_id as id from tickets where parent_id is null and archived_at is null group by project_id order by count(*) desc, project_id limit 1',
    )
    if (!project) throw new Error(`${dbFile} has no ticket on any board to measure`)
    const biggest = (where) =>
      one(
        `select t.id, t.title, count(u.id) as posts from tickets t left join updates u on u.ticket_id = t.id
         where t.project_id = ? ${where} group by t.id order by posts desc, t.id limit 1`,
        project.id,
      )
    const ticket = biggest('')
    const board = biggest('and t.parent_id is null and t.archived_at is null')
    const post =
      one(
        `select u.id from updates u join tickets t on t.id = u.ticket_id
         join comments c on c.parent_type = 'update' and c.parent_id = u.id
         where t.project_id = ? group by u.id order by count(c.id) desc, u.id limit 1`,
        project.id,
      ) ?? one('select id from updates where ticket_id = ? order by id desc limit 1', ticket.id)
    const attachment = one(
      "select id, size from attachments where mime like 'image/%' order by id desc limit 1",
    )
    const human = one("select name from actors where kind = 'human' order by last_seen_at desc limit 1")
    const agent = one("select name from actors where kind = 'agent' order by last_seen_at desc limit 1")
    return {
      projectId: project.id,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketPosts: ticket.posts,
      boardTicketId: board.id,
      boardTicketTitle: board.title,
      postId: post?.id ?? null,
      attachmentId: attachment?.id ?? null,
      attachmentSize: attachment?.size ?? null,
      human: human?.name ?? 'human',
      agent: agent?.name ?? 'claude',
    }
  } finally {
    db.close()
  }
}
