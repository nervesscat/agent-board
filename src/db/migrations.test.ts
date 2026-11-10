import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Migrations that move data, run against a database that has rows: migrate a fresh one up to the
 * migration before, write rows the way the board wrote them then, and apply the rest.
 */

const folder = path.resolve('drizzle')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-migrations-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A copy of ./drizzle that stops at `lastTag`: what a board on that migration had applied. */
function migrationsUpTo(lastTag: string) {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[]
  }
  const end = journal.entries.findIndex((e) => e.tag === lastTag)
  expect(end).toBeGreaterThanOrEqual(0)
  const dir = fs.mkdtempSync(path.join(tmp, 'drizzle-'))
  fs.mkdirSync(path.join(dir, 'meta'))
  const entries = journal.entries.slice(0, end + 1)
  for (const e of entries) fs.copyFileSync(path.join(folder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
  return dir
}

function databaseAt(lastTag: string, file = ':memory:') {
  const sqlite = new Database(file)
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(lastTag) })
  return sqlite
}

const columns = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

/** A row as the board reads it now: the columns a later migration drops are left out. */
const withoutDropped = ({
  resume_note: _n,
  resume_at: _a,
  resume_by: _b,
  resume_sha: _s,
  handoff: _h,
  ...rest
}: Record<string, unknown>) => rest

describe('0023_daily_reports_and_shifts', () => {
  it('turns the daily summaries into report versions and the due time into the shift end', () => {
    const sqlite = databaseAt('0022_pr_review_stages')
    const project = (name: string) =>
      Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid)
    const a = project('a')
    const b = project('b')
    const c = project('c')
    const d = project('d')

    const setting = sqlite.prepare(
      'INSERT INTO report_settings (project_id, prompt, cadence, due_time) VALUES (?, ?, ?, ?)',
    )
    setting.run(a, 'By the hour.', 'daily', '18:00')
    setting.run(b, '', 'weekly', null)
    // A due time before the default shift start: the shift starts at midnight instead.
    setting.run(c, '', 'daily', '08:30')

    const summary = sqlite.prepare(
      'INSERT INTO daily_summaries (project_id, date, author, body, createdAt) VALUES (?, ?, ?, ?, ?)',
    )
    // Inserted out of time order: the versions still come out oldest first.
    summary.run(a, '2026-10-05', 'claude', 'second on the 5th', '2026-10-05T18:00:00.000Z')
    summary.run(a, '2026-10-05', 'enrique', 'first on the 5th', '2026-10-05T09:00:00.000Z')
    summary.run(a, '2026-10-04', 'claude', 'the 4th', '2026-10-04T17:00:00.000Z')
    summary.run(d, '2026-10-06', 'codex', 'project d', '2026-10-06T12:00:00.000Z')
    // Board-wide: no project to keep it under.
    summary.run(null, '2026-10-05', 'claude', 'everything', '2026-10-05T20:00:00.000Z')

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const reports = sqlite
      .prepare('SELECT project_id, cadence, period, body, author, createdAt FROM reports ORDER BY id')
      .all()
    expect(reports).toEqual([
      {
        project_id: a,
        cadence: 'daily',
        period: '2026-10-04',
        body: 'the 4th',
        author: 'claude',
        createdAt: '2026-10-04T17:00:00.000Z',
      },
      {
        project_id: a,
        cadence: 'daily',
        period: '2026-10-05',
        body: 'first on the 5th',
        author: 'enrique',
        createdAt: '2026-10-05T09:00:00.000Z',
      },
      {
        project_id: a,
        cadence: 'daily',
        period: '2026-10-05',
        body: 'second on the 5th',
        author: 'claude',
        createdAt: '2026-10-05T18:00:00.000Z',
      },
      {
        project_id: d,
        cadence: 'daily',
        period: '2026-10-06',
        body: 'project d',
        author: 'codex',
        createdAt: '2026-10-06T12:00:00.000Z',
      },
    ])
    expect(() => sqlite.prepare('SELECT * FROM daily_summaries').all()).toThrow(/no such table/)

    const settings = sqlite
      .prepare(
        'SELECT project_id, prompt, template, shift_start, shift_end, workdays, alert_minutes FROM report_settings ORDER BY project_id',
      )
      .all()
    expect(settings).toEqual([
      {
        project_id: a,
        prompt: 'By the hour.',
        template: '',
        shift_start: '09:00',
        shift_end: '18:00',
        workdays: '[1,2,3,4,5]',
        alert_minutes: 30,
      },
      {
        project_id: b,
        prompt: '',
        template: '',
        shift_start: '09:00',
        shift_end: '17:00',
        workdays: '[1,2,3,4,5]',
        alert_minutes: 30,
      },
      {
        project_id: c,
        prompt: '',
        template: '',
        shift_start: '00:00',
        shift_end: '08:30',
        workdays: '[1,2,3,4,5]',
        alert_minutes: 30,
      },
    ])
    expect(columns(sqlite, 'report_settings')).not.toContain('due_time')
    for (const table of ['report_settings_changes', 'origin_refs', 'origin_ref_moves'])
      expect(columns(sqlite, table).length).toBeGreaterThan(0)
    sqlite.close()
  })

  it('gives every due time the board took a shift that ends after it starts', () => {
    const sqlite = databaseAt('0022_pr_review_stages')
    // Every HH:MM of a day, as the due time took them.
    const times = Array.from(
      { length: 24 * 60 },
      (_, m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
    )
    const project = sqlite.prepare('INSERT INTO projects (name) VALUES (?)')
    const setting = sqlite.prepare(
      'INSERT INTO report_settings (project_id, cadence, due_time) VALUES (?, ?, ?)',
    )
    const ids = new Map<number, string>()
    for (const time of times) {
      const id = Number(project.run(`due ${time}`).lastInsertRowid)
      setting.run(id, 'daily', time)
      ids.set(id, time)
    }

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const shifts = sqlite.prepare('SELECT project_id, shift_start, shift_end FROM report_settings').all() as {
      project_id: number
      shift_start: string
      shift_end: string
    }[]
    expect(shifts).toHaveLength(times.length)
    const shiftOf = (time: string) => shifts.find((s) => ids.get(s.project_id) === time)
    for (const s of shifts) {
      const time = ids.get(s.project_id)!
      expect(s.shift_end > s.shift_start, `${time}: ${s.shift_start} to ${s.shift_end}`).toBe(true)
      // Due when it was, but for midnight, which is due a minute later.
      expect(s.shift_end, time).toBe(time === '00:00' ? '00:01' : time)
    }
    expect(shiftOf('00:00')).toMatchObject({ shift_start: '00:00', shift_end: '00:01' })
    expect(shiftOf('00:05')).toMatchObject({ shift_start: '00:00', shift_end: '00:05' })
    expect(shiftOf('09:00')).toMatchObject({ shift_start: '00:00', shift_end: '09:00' })
    expect(shiftOf('09:01')).toMatchObject({ shift_start: '09:00', shift_end: '09:01' })
    sqlite.close()
  })

  it('leaves a due time of midnight with settings the board saves again', async () => {
    // The board's own database, migrated as it starts: from 0022 with a due time of 00:00.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-migrated-'))
    const sqlite = databaseAt('0022_pr_review_stages', path.join(dataDir, 'board.db'))
    const id = Number(
      sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('midnight').lastInsertRowid,
    )
    sqlite
      .prepare('INSERT INTO report_settings (project_id, prompt, cadence, due_time) VALUES (?, ?, ?, ?)')
      .run(id, 'Old prompt.', 'daily', '00:00')
    sqlite.close()
    process.env.DATA_DIR = dataDir
    const reports = await import('#/server/reports')

    // Changes that leave the shift alone: the prompt, an agent's template, the format.
    const prompt = () => reports.setReportSettings(id, { prompt: 'Say what got done.' }, 'enrique')
    expect(prompt).not.toThrow()
    expect(() =>
      reports.setReportSettings(id, { template: '## Done\n' }, 'claude', { agent: true }),
    ).not.toThrow()
    expect(() => reports.setReportSettings(id, { format: 'file' }, 'claude', { agent: true })).not.toThrow()
    expect(reports.getReportSettings(id)).toMatchObject({
      prompt: 'Say what got done.',
      format: 'file',
      shiftStart: '00:00',
      shiftEnd: '00:01',
    })
  })
})

describe('0027_relayed_decisions', () => {
  it('keeps the decided card, its reply and the other posts when the relay columns are added', () => {
    const sqlite = databaseAt('0026_task_blocked_tag')
    const project = Number(
      sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('relay').lastInsertRowid,
    )
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by) VALUES (?, ?, ?)')
        .run(project, 'Answer in the chat', 'claude').lastInsertRowid,
    )
    // A decision card with two options, which the human picked.
    const options = [{ label: 'Merge now' }, { label: 'Wait for the review', recommended: true }]
    const card = Number(
      sqlite
        .prepare(
          'INSERT INTO updates (ticket_id, author, body, progress, decision, decided_option, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          ticket,
          'claude',
          'Merge now or wait for the review?',
          0,
          JSON.stringify(options),
          1,
          'enrique',
          '2026-10-10T10:00:00.000Z',
        ).lastInsertRowid,
    )
    // The human's reply under the card: a child row through the comments table.
    sqlite
      .prepare('INSERT INTO comments (parent_type, parent_id, author, body) VALUES (?, ?, ?, ?)')
      .run('update', card, 'enrique', 'Decided: **Wait for the review**')
    const plain = Number(
      sqlite
        .prepare('INSERT INTO updates (ticket_id, author, body) VALUES (?, ?, ?)')
        .run(ticket, 'claude', 'Pushed the branch.').lastInsertRowid,
    )

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(
      sqlite
        .prepare('SELECT decision, decided_option, decided_by, decided_at FROM updates WHERE id = ?')
        .get(card),
    ).toEqual({
      decision: JSON.stringify(options),
      decided_option: 1,
      decided_by: 'enrique',
      decided_at: '2026-10-10T10:00:00.000Z',
    })
    expect(
      sqlite
        .prepare('SELECT author, body FROM comments WHERE parent_type = ? AND parent_id = ?')
        .all('update', card),
    ).toEqual([{ author: 'enrique', body: 'Decided: **Wait for the review**' }])
    expect(sqlite.prepare('SELECT body FROM updates WHERE id = ?').get(plain)).toEqual({
      body: 'Pushed the branch.',
    })
    // Every post, the two written before the migration included, reads '' for the relay.
    expect(sqlite.prepare('SELECT relayed_by, relayed_text FROM updates ORDER BY id').all()).toEqual([
      { relayed_by: '', relayed_text: '' },
      { relayed_by: '', relayed_text: '' },
    ])
    sqlite.close()
  })
})

describe('0028_task_complexity', () => {
  it('gives every existing ticket the level mid, keeps what refers to it, and refuses any other level', () => {
    const sqlite = databaseAt('0027_relayed_decisions')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const insert = sqlite.prepare(
      'INSERT INTO tickets (project_id, title, created_by, status) VALUES (?, ?, ?, ?)',
    )
    const older = Number(insert.run(project, 'before the column', 'enrique', 'todo').lastInsertRowid)
    const finished = Number(insert.run(project, 'finished', 'claude', 'done').lastInsertRowid)
    // The rows that refer to a ticket are kept by the migration: a table rebuild would cascade into them.
    sqlite.prepare('INSERT INTO tasks (ticket_id, text) VALUES (?, ?)').run(older, 'Implementation')

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(sqlite.prepare('SELECT id, complexity FROM tickets ORDER BY id').all()).toEqual([
      { id: older, complexity: 'mid' },
      { id: finished, complexity: 'mid' },
    ])
    expect(sqlite.prepare('SELECT text FROM tasks WHERE ticket_id = ?').all(older)).toEqual([
      { text: 'Implementation' },
    ])

    // A ticket written without the column reads mid; the table refuses any other level, case included.
    const added = Number(
      sqlite
        .prepare("INSERT INTO tickets (project_id, title, created_by) VALUES (?, 'new', 'claude')")
        .run(project).lastInsertRowid,
    )
    expect(sqlite.prepare('SELECT complexity FROM tickets WHERE id = ?').get(added)).toEqual({
      complexity: 'mid',
    })
    const setLevel = sqlite.prepare('UPDATE tickets SET complexity = ? WHERE id = ?')
    for (const level of ['extreme', 'High', ''])
      expect(() => setLevel.run(level, added)).toThrow(/CHECK constraint/)
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO tickets (project_id, title, created_by, complexity) VALUES (?, 'x', 'claude', 'extreme')",
        )
        .run(project),
    ).toThrow(/CHECK constraint/)
    for (const level of ['low', 'mid', 'high']) {
      setLevel.run(level, added)
      expect(sqlite.prepare('SELECT complexity FROM tickets WHERE id = ?').get(added)).toEqual({
        complexity: level,
      })
    }
    sqlite.close()
  })
})

describe('0029_ticket_pr_link', () => {
  it('adds the PR link column without rebuilding the tickets, so their tasks, posts and lanes stay', () => {
    const sqlite = databaseAt('0028_task_complexity')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const ticket = (title: string, parentId: number | null = null) =>
      Number(
        sqlite
          .prepare('INSERT INTO tickets (project_id, parent_id, title, created_by) VALUES (?, ?, ?, ?)')
          .run(project, parentId, title, 'enrique').lastInsertRowid,
      )
    const feature = ticket('feature')
    const lane = ticket('lane', feature)
    const daily = ticket('daily ticket')
    const step = Number(
      sqlite.prepare('INSERT INTO tasks (ticket_id, text, position) VALUES (?, ?, ?)').run(feature, 'step', 0)
        .lastInsertRowid,
    )
    sqlite
      .prepare('INSERT INTO tasks (ticket_id, parent_id, text, position) VALUES (?, ?, ?, ?)')
      .run(feature, step, 'subtask', 0)
    sqlite
      .prepare('INSERT INTO updates (ticket_id, author, body) VALUES (?, ?, ?)')
      .run(feature, 'enrique', 'a post')
    sqlite
      .prepare('INSERT INTO updates (ticket_id, author, body) VALUES (?, ?, ?)')
      .run(lane, 'claude', 'a lane post')

    const rows = () => ({
      tickets: sqlite.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[],
      tasks: sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),
      updates: sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[],
    })
    const before = rows()
    expect(before.tickets).toHaveLength(3)
    expect(before.tasks).toHaveLength(2)
    expect(before.updates).toHaveLength(2)

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(columns(sqlite, 'tickets')).toContain('pr_id')
    const after = rows()
    // The same tickets, tasks and posts, row for row; the new column is empty on every ticket.
    expect(after.tickets.map((t) => t.id)).toEqual([feature, lane, daily])
    expect(after.tickets.map((t) => t.pr_id)).toEqual([null, null, null])
    // Every other column is what it was (toEqual leaves an undefined column out of the comparison).
    // Later migrations add the Merged phase marker and the place in the column: the rest of each ticket
    // is what it was.
    expect(
      after.tickets.map((t) =>
        withoutDropped({
          ...t,
          pr_id: undefined,
          merged_phase_checked: undefined,
          rank: undefined,
        }),
      ),
    ).toEqual(before.tickets.map(withoutDropped))
    expect(after.tasks).toEqual(before.tasks)
    // Later migrations add the posts' tab, summary, archive request and repo request columns: the rest of
    // each post is what it was.
    expect(
      after.updates.map(
        ({ tab: _t, summary: _s, summary_change: _c, archive_tickets: _a, repo_request: _r, ...rest }) =>
          withoutDropped(rest),
      ),
    ).toEqual(before.updates.map(withoutDropped))
    expect(sqlite.prepare('SELECT parent_id FROM tickets WHERE id = ?').get(lane)).toEqual({
      parent_id: feature,
    })
    sqlite.close()
  })
})

describe('0030_post_tabs_and_summary', () => {
  it('sorts every existing post into a tab of the feed by the rules a new post goes by, and changes nothing else', () => {
    const sqlite = databaseAt('0029_ticket_pr_link')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const ticket = Number(
      sqlite
        .prepare("INSERT INTO tickets (project_id, title, created_by) VALUES (?, 't', 'enrique')")
        .run(project).lastInsertRowid,
    )
    const actor = sqlite.prepare("INSERT INTO actors (name, kind, last_seen_at) VALUES (?, ?, '2026-10-01')")
    actor.run('enrique', 'human')
    actor.run('claude', 'agent')
    const insert = sqlite.prepare(
      `INSERT INTO updates (ticket_id, author, via, body, progress, handoff, decision, createdAt, edited_at)
       VALUES (@ticket, @author, @via, @body, @progress, @handoff, @decision, @at, @edited)`,
    )
    const post = (p: {
      author: string
      via?: string
      progress: number
      handoff?: number
      decision?: string
    }) =>
      Number(
        insert.run({
          ticket,
          via: '',
          handoff: 0,
          decision: null,
          body: `by ${p.author}`,
          at: '2026-10-10T10:00:00.000Z',
          edited: null,
          ...p,
        }).lastInsertRowid,
      )
    const progress = post({ author: 'claude', progress: 1 })
    const persona = post({ author: 'spec', via: 'claude', progress: 0 })
    const question = post({ author: 'claude', progress: 0 })
    const human = post({ author: 'enrique', progress: 1 })
    const humanNote = post({ author: 'enrique', progress: 1, handoff: 1 })
    const agentNote = post({ author: 'claude', progress: 1, handoff: 1 })
    const card = post({
      author: 'spec',
      via: 'claude',
      progress: 0,
      decision: '[{"label":"a"},{"label":"b"}]',
    })
    // An author the board never saw sign in counts as an agent, as the hand-off check reads it.
    const unknown = post({ author: 'codex', progress: 1 })
    // A post's files are kept: a rebuild of the table would cascade into them.
    sqlite
      .prepare(
        "INSERT INTO attachments (update_id, name, mime, size, stored_as, uploaded_by) VALUES (?, 'a.png', 'image/png', 1, 'x', 'claude')",
      )
      .run(progress)
    const before = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const tab = (id: number) =>
      (sqlite.prepare('SELECT tab FROM updates WHERE id = ?').get(id) as { tab: string }).tab
    expect({
      progress: tab(progress),
      persona: tab(persona),
      question: tab(question),
      human: tab(human),
      humanNote: tab(humanNote),
      agentNote: tab(agentNote),
      card: tab(card),
      unknown: tab(unknown),
    }).toEqual({
      progress: 'agents',
      persona: 'agents',
      question: 'main',
      human: 'main',
      humanNote: 'agents',
      agentNote: 'agents',
      card: 'main',
      unknown: 'agents',
    })
    // Every other column reads as it did (later migrations add the archive and repo request ones); no post
    // is a summary.
    const after = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]
    expect(
      after.map(
        ({ tab: _t, summary: _s, summary_change: _c, archive_tickets: _a, repo_request: _r, ...rest }) =>
          withoutDropped(rest),
      ),
    ).toEqual(before.map(withoutDropped))
    expect(after.every((u) => u.summary === 0 && u.summary_change === '')).toBe(true)
    expect(sqlite.prepare('SELECT update_id FROM attachments').all()).toEqual([{ update_id: progress }])
    expect(() => sqlite.prepare("UPDATE updates SET tab = 'other' WHERE id = ?").run(progress)).toThrow(
      /CHECK constraint/,
    )
    sqlite.close()
  })
})

describe('0031_project_tag_suggestions', () => {
  it('gives every project the default suggestions and keeps its rows and theirs', () => {
    const sqlite = databaseAt('0030_post_tabs_and_summary')
    const project = Number(
      sqlite
        .prepare('INSERT INTO projects (name, instructions, default_phases) VALUES (?, ?, ?)')
        .run('tags', 'Run the tests.', JSON.stringify(['Build'])).lastInsertRowid,
    )
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by, tags) VALUES (?, ?, ?, ?)')
        .run(project, 'Fix the form', 'claude', JSON.stringify(['Forms'])).lastInsertRowid,
    )
    sqlite.prepare('INSERT INTO tasks (ticket_id, text) VALUES (?, ?)').run(ticket, 'Repro it')
    sqlite
      .prepare('INSERT INTO updates (ticket_id, author, body) VALUES (?, ?, ?)')
      .run(ticket, 'claude', 'Started.')
    const counts = () =>
      ['projects', 'stages', 'tickets', 'tasks', 'updates'].map(
        (table) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      )
    const before = counts()

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(counts()).toEqual(before)
    expect(
      sqlite
        .prepare('SELECT name, instructions, default_phases, tag_suggestions FROM projects WHERE id = ?')
        .get(project),
    ).toEqual({
      name: 'tags',
      instructions: 'Run the tests.',
      default_phases: JSON.stringify(['Build']),
      tag_suggestions: JSON.stringify(['Bug', 'UI', 'Implementation', 'Report']),
    })
    expect(sqlite.prepare('SELECT tags FROM tickets WHERE id = ?').get(ticket)).toEqual({
      tags: JSON.stringify(['Forms']),
    })
    sqlite.close()
  })
})

describe('0033_archive_requests', () => {
  it('adds the archive request column without rebuilding the posts, so they and their files stay', () => {
    const sqlite = databaseAt('0032_passkey_sign_in')
    const project = Number(
      sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('archive').lastInsertRowid,
    )
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by) VALUES (?, ?, ?)')
        .run(project, 'Shipped', 'claude').lastInsertRowid,
    )
    const card = Number(
      sqlite
        .prepare('INSERT INTO updates (ticket_id, author, body, decision) VALUES (?, ?, ?, ?)')
        .run(ticket, 'claude', 'Which one?', JSON.stringify([{ label: 'A' }, { label: 'B' }]))
        .lastInsertRowid,
    )
    sqlite
      .prepare(
        "INSERT INTO attachments (update_id, name, mime, size, stored_as, uploaded_by) VALUES (?, 'a.png', 'image/png', 1, 'x', 'claude')",
      )
      .run(card)
    const before = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const after = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]
    // A later migration adds the repo request column.
    expect(after.map(({ archive_tickets: _a, repo_request: _r, ...rest }) => withoutDropped(rest))).toEqual(
      before.map(withoutDropped),
    )
    expect(after.map((u) => u.archive_tickets)).toEqual([null])
    expect(sqlite.prepare('SELECT update_id FROM attachments').all()).toEqual([{ update_id: card }])
    sqlite.close()
  })
})

describe('0034_work_timeline', () => {
  it('adds the stall threshold without rebuilding projects, and the events table with its checks', () => {
    const sqlite = databaseAt('0033_archive_requests')
    const project = Number(
      sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('timeline').lastInsertRowid,
    )
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by) VALUES (?, ?, ?)')
        .run(project, 'Kept', 'claude').lastInsertRowid,
    )

    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo('0034_work_timeline') })

    expect(sqlite.prepare('SELECT stall_minutes FROM projects').all()).toEqual([{ stall_minutes: 30 }])
    expect(sqlite.prepare('SELECT id FROM tickets').all()).toEqual([{ id: ticket }])
    const fresh = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('new').lastInsertRowid)
    expect(sqlite.prepare('SELECT stall_minutes FROM projects WHERE id = ?').get(fresh)).toEqual({
      stall_minutes: 30,
    })
    expect(() => sqlite.prepare('UPDATE projects SET stall_minutes = 0').run()).toThrow(/CHECK/)
    expect(() => sqlite.prepare('UPDATE projects SET stall_minutes = 1441').run()).toThrow(/CHECK/)

    expect(columns(sqlite, 'ticket_events')).toEqual(
      expect.arrayContaining(['ticket_id', 'project_id', 'kind', 'agent', 'by', 'ref_id', 'reason', 'at']),
    )
    const insert = sqlite.prepare(
      'INSERT INTO ticket_events (ticket_id, project_id, kind, agent, by, reason) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run(ticket, project, 'wait_start', 'claude', 'claude', 'lock')
    expect(() => insert.run(ticket, project, 'nap', 'claude', 'claude', '')).toThrow(/CHECK/)
    expect(() => insert.run(ticket, project, 'wait_start', 'claude', 'claude', 'coffee')).toThrow(/CHECK/)
    const indexes = (sqlite.prepare("PRAGMA index_list('ticket_events')").all() as { name: string }[]).map(
      (i) => i.name,
    )
    expect(indexes).toEqual(expect.arrayContaining(['ticket_events_ticket_at', 'ticket_events_project_at']))
    // Deleting the ticket takes its events.
    sqlite.prepare('DELETE FROM tickets WHERE id = ?').run(ticket)
    expect(sqlite.prepare('SELECT count(*) AS n FROM ticket_events').get()).toEqual({ n: 0 })
    sqlite.close()
  })
})

describe('0035_auto_phase_state', () => {
  it('leaves existing tickets to be looked at for Merged, and no PR green by a local run, rows kept', () => {
    const sqlite = databaseAt('0034_work_timeline')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by) VALUES (?, ?, ?)')
        .run(project, 'Seeded before Merged', 'claude').lastInsertRowid,
    )
    sqlite.prepare('INSERT INTO tasks (ticket_id, text, position) VALUES (?, ?, ?)').run(ticket, 'Pushed', 0)
    sqlite
      .prepare(
        `INSERT INTO prs (project_id, number, title, url, author, head_ref, base_ref, head_sha, updated_at, fetched_at)
         VALUES (?, 7, 't', 'u', 'a', 'feat', 'main', 'abc', '2026-10-01', '2026-10-01')`,
      )
      .run(project)
    const before = {
      tickets: sqlite.prepare('SELECT * FROM tickets').all() as Record<string, unknown>[],
      tasks: sqlite.prepare('SELECT * FROM tasks').all(),
      prs: sqlite.prepare('SELECT * FROM prs').all() as Record<string, unknown>[],
    }

    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo('0035_auto_phase_state') })

    const tickets = sqlite.prepare('SELECT * FROM tickets').all() as Record<string, unknown>[]
    const prs = sqlite.prepare('SELECT * FROM prs').all() as Record<string, unknown>[]
    expect(tickets.map((t) => t.merged_phase_checked)).toEqual([0])
    expect(prs.map((p) => p.local_ci_sha)).toEqual([null])
    expect(tickets.map(({ merged_phase_checked: _m, ...rest }) => rest)).toEqual(before.tickets)
    expect(prs.map(({ local_ci_sha: _l, ...rest }) => rest)).toEqual(before.prs)
    expect(sqlite.prepare('SELECT * FROM tasks').all()).toEqual(before.tasks)
    sqlite.close()
  })
})

describe('0036_pr_left_as', () => {
  it('leaves every stored PR without an answer from GitHub, rows kept', () => {
    const sqlite = databaseAt('0035_auto_phase_state')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const pr = sqlite.prepare(
      `INSERT INTO prs (project_id, number, title, url, author, head_ref, base_ref, head_sha, updated_at, fetched_at, open, merged_at, closed_at)
       VALUES (?, ?, 't', 'u', 'a', 'feat', 'main', 'abc', '2026-10-01', '2026-10-01', ?, ?, ?)`,
    )
    pr.run(project, 7, 1, null, null)
    pr.run(project, 8, 0, '2026-10-02', '2026-10-02')
    // Closed by an older refresh with no merge time: the case GitHub was never asked about.
    pr.run(project, 9, 0, null, '2026-10-03')
    const before = sqlite.prepare('SELECT * FROM prs').all()

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const prs = sqlite.prepare('SELECT * FROM prs').all() as Record<string, unknown>[]
    expect(prs.map((p) => p.left_as)).toEqual([null, null, null])
    expect(prs.map(({ left_as: _l, ...rest }) => rest)).toEqual(before)
    sqlite.close()
  })
})

describe('0037_drop_handoff_post_phase', () => {
  // The migrator runs with foreign keys on; the migration must not need their cascade either.
  it.each([true, false])(
    'drops the top-level Hand-off post phase with its steps, and from stored lists (foreign keys %s)',
    (foreignKeys) => {
      const sqlite = databaseAt('0036_pr_left_as')
      sqlite.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
      const project = (phases: string | null) =>
        Number(
          sqlite.prepare('INSERT INTO projects (name, default_phases) VALUES (?, ?)').run('p', phases)
            .lastInsertRowid,
        )
      const builtIn = project(null)
      const custom = project('["Implementation","Pushed","PR","CI","Preview","Merged","Hand-off post"]')
      const without = project('["A","B"]')
      const onlyPost = project('["Hand-off post"]')
      const middle = project('[" hand-off POST ","Implementation","Hand-off post notes","Merged"]')

      const ticket = (
        title: string,
        extra: { status?: string; archivedAt?: string; parentId?: number } = {},
      ) =>
        Number(
          sqlite
            .prepare(
              'INSERT INTO tickets (project_id, title, created_by, status, archived_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              builtIn,
              title,
              'claude',
              extra.status ?? 'todo',
              extra.archivedAt ?? null,
              extra.parentId ?? null,
            ).lastInsertRowid,
        )
      const task = (
        ticketId: number,
        text: string,
        position: number,
        done = false,
        parentId?: number,
        blocked = false,
      ) =>
        Number(
          sqlite
            .prepare(
              'INSERT INTO tasks (ticket_id, text, position, done, parent_id, blocked, blocked_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              ticketId,
              text,
              position,
              done ? 1 : 0,
              parentId ?? null,
              blocked ? 1 : 0,
              blocked ? 'a key' : '',
            ).lastInsertRowid,
        )

      // At 100% with its Hand-off post done.
      const full = ticket('Full')
      const fullImpl = task(full, 'Implementation', 0, true)
      task(full, 'Write it', 0, true, fullImpl)
      task(full, 'Hand-off post', 1, true)
      // Its only open task was Hand-off post.
      const almost = ticket('Almost')
      task(almost, 'Implementation', 0, true)
      task(almost, 'Hand-off post', 1)
      // 3 of 4 phases done, Hand-off post (done) in the middle.
      const most = ticket('Most')
      const mostImpl = task(most, 'Implementation', 0, true)
      task(most, 'Hand-off post', 1, true)
      task(most, 'Pushed', 2, true)
      task(most, 'PR', 3)
      // A step of that name under another phase is someone's choice; so are other spellings.
      const kept = [
        task(most, 'Hand-off post', 0, false, mostImpl, true),
        task(most, 'Handoff post', 4),
        task(most, 'Hand-off post notes', 5, true),
      ]
      // Archived, odd spacing and case, with steps under it.
      const archived = ticket('Archived', { status: 'done', archivedAt: '2026-10-01' })
      task(archived, 'Implementation', 0, true)
      const archivedPost = task(archived, ' hand-off POST ', 1)
      task(archived, 'Summary', 0, true, archivedPost)
      task(archived, 'Screenshots', 1, false, archivedPost)
      // Closed with Hand-off post as its only task.
      const closed = ticket('Closed', { status: 'done' })
      task(closed, 'Hand-off post', 0, true)
      // A lane of the full ticket.
      const lane = ticket('Lane', { parentId: full })
      task(lane, 'Implementation', 0)
      task(lane, 'Hand-off post', 1, true)

      const rows = (where: string, ...params: unknown[]) =>
        sqlite.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id`).all(...params)
      const progress = (where: string, ...params: unknown[]) =>
        sqlite
          .prepare(`SELECT coalesce(sum(done), 0) AS done, count(*) AS total FROM tasks WHERE ${where}`)
          .get(...params)
      const rollup = `ticket_id IN (SELECT id FROM tickets WHERE id = ? OR parent_id = ?)`
      const before = {
        kept: rows(`id IN (${kept.join(', ')})`),
        // Everything but the top-level Hand-off posts and the archived one's steps.
        others: rows(
          "(parent_id IS NOT NULL OR lower(trim(text)) <> 'hand-off post') AND parent_id IS NOT ?",
          archivedPost,
        ),
        tickets: sqlite.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[],
        stored: sqlite.prepare('SELECT id, default_phases FROM projects WHERE id = ?').get(without),
      }
      expect(before.kept).toHaveLength(3)
      expect(progress('ticket_id = ?', most)).toEqual({ done: 4, total: 7 })
      expect(progress(rollup, full, full)).toEqual({ done: 4, total: 5 })

      // Up to this migration only: a later one (0042_summary_phase) adds a phase to these tickets.
      migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo('0037_drop_handoff_post_phase') })

      expect(rows("parent_id IS NULL AND lower(trim(text)) = 'hand-off post'")).toEqual([])
      expect(rows('parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM tasks)')).toEqual([])
      // Every other row is as it was: done, blocked, position and parent included.
      expect(rows(`id IN (${kept.join(', ')})`)).toEqual(before.kept)
      expect(rows('1')).toEqual(before.others)
      expect(sqlite.prepare('SELECT * FROM tickets ORDER BY id').all()).toEqual(before.tickets)

      expect(progress('ticket_id = ?', full)).toEqual({ done: 2, total: 2 })
      expect(progress('ticket_id = ?', almost)).toEqual({ done: 1, total: 1 })
      // Its phases alone: 3 of 4 before, 2 of 3 now.
      expect(
        progress('ticket_id = ? AND parent_id IS NULL AND id NOT IN (?, ?)', most, ...kept.slice(1)),
      ).toEqual({
        done: 2,
        total: 3,
      })
      expect(progress('ticket_id = ?', most)).toEqual({ done: 3, total: 6 })
      expect(progress('ticket_id = ?', archived)).toEqual({ done: 1, total: 1 })
      expect(progress('ticket_id = ?', closed)).toEqual({ done: 0, total: 0 })
      expect(progress('ticket_id = ?', lane)).toEqual({ done: 0, total: 1 })
      // The full ticket's rollup with its lane.
      expect(progress(rollup, full, full)).toEqual({ done: 2, total: 3 })
      // The phases left keep their positions, gap included.
      expect(
        sqlite
          .prepare(
            'SELECT text, position FROM tasks WHERE ticket_id = ? AND parent_id IS NULL ORDER BY position, id',
          )
          .all(most),
      ).toEqual([
        { text: 'Implementation', position: 0 },
        { text: 'Pushed', position: 2 },
        { text: 'PR', position: 3 },
        { text: 'Handoff post', position: 4 },
        { text: 'Hand-off post notes', position: 5 },
      ])

      const phases = (id: number) =>
        (
          sqlite.prepare('SELECT default_phases FROM projects WHERE id = ?').get(id) as {
            default_phases: string | null
          }
        ).default_phases
      expect(phases(builtIn)).toBeNull()
      expect(JSON.parse(phases(custom)!)).toEqual([
        'Implementation',
        'Pushed',
        'PR',
        'CI',
        'Preview',
        'Merged',
      ])
      expect(sqlite.prepare('SELECT id, default_phases FROM projects WHERE id = ?').get(without)).toEqual(
        before.stored,
      )
      expect(JSON.parse(phases(onlyPost)!)).toEqual([])
      expect(JSON.parse(phases(middle)!)).toEqual(['Implementation', 'Hand-off post notes', 'Merged'])
      sqlite.close()
    },
  )
})

describe('0038_multi_repo_tickets_and_runs', () => {
  it("gives every ticket its repo as a one-repo list, and every workspace its ticket's repo, changing nothing else", () => {
    const sqlite = databaseAt('0037_drop_handoff_post_phase')
    const insertProject = sqlite.prepare('INSERT INTO projects (name) VALUES (?)')
    const project = (name: string) => Number(insertProject.run(name).lastInsertRowid)
    const two = project('two repos')
    const none = project('no repos')
    const repo = (projectId: number, name: string) =>
      Number(
        sqlite
          .prepare('INSERT INTO repos (project_id, name, repo_path) VALUES (?, ?, ?)')
          .run(projectId, name, `/code/${name}`).lastInsertRowid,
      )
    // Inserted out of name order: the project's first repo is the lowest name, as the board lists them.
    const web = repo(two, 'web')
    const api = repo(two, 'api')
    const ticket = sqlite.prepare(
      'INSERT INTO tickets (project_id, repo_id, parent_id, title, created_by, branch, base_branch, pr_number) VALUES (@project, @repo, @parent, @title, @by, @branch, @base, @pr)',
    )
    const add = (title: string, over: Record<string, unknown> = {}) =>
      Number(
        ticket.run({
          project: two,
          repo: null,
          parent: null,
          title,
          by: 'claude',
          branch: '',
          base: 'main',
          pr: null,
          ...over,
        }).lastInsertRowid,
      )
    const onWeb = add('on web', { repo: web, branch: 'feat/web', base: 'dev', pr: 12 })
    const firstRepo = add('no repo given', { branch: 'feat/first' })
    const lane = add('a lane', { repo: web, parent: onWeb, branch: 'lane/web', base: 'feat/web' })
    const repoless = add('nowhere', { project: none, branch: 'feat/x' })
    sqlite.prepare('INSERT INTO tasks (ticket_id, text) VALUES (?, ?)').run(onWeb, 'Implementation')
    sqlite
      .prepare('INSERT INTO updates (ticket_id, author, body) VALUES (?, ?, ?)')
      .run(onWeb, 'claude', 'Started.')
    const workspace = sqlite.prepare('INSERT INTO workspaces (ticket_id, name, path) VALUES (?, ?, ?)')
    const wsWeb = Number(workspace.run(onWeb, 'wt', '/code/web-feat').lastInsertRowid)
    const wsFirst = Number(workspace.run(firstRepo, 'wt', '/code/api-feat').lastInsertRowid)
    const wsNone = Number(workspace.run(repoless, 'wt', '').lastInsertRowid)

    const counts = () =>
      ['projects', 'repos', 'tickets', 'tasks', 'updates', 'workspaces'].map(
        (table) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      )
    const before = counts()
    const tickets = () =>
      sqlite.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[]
    const ticketsBefore = tickets()

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(counts()).toEqual(before)
    // The tickets themselves are untouched, their repo, branch and PR included (a later migration adds
    // their place in the column).
    expect(tickets().map(({ rank: _r, ...rest }) => withoutDropped(rest))).toEqual(
      ticketsBefore.map(withoutDropped),
    )
    expect(
      sqlite
        .prepare(
          'SELECT ticket_id, repo_id, branch, base_branch, pr_number, position FROM ticket_repos ORDER BY ticket_id',
        )
        .all(),
    ).toEqual([
      { ticket_id: onWeb, repo_id: web, branch: 'feat/web', base_branch: 'dev', pr_number: 12, position: 0 },
      {
        ticket_id: firstRepo,
        repo_id: api,
        branch: 'feat/first',
        base_branch: 'main',
        pr_number: null,
        position: 0,
      },
      {
        ticket_id: lane,
        repo_id: web,
        branch: 'lane/web',
        base_branch: 'feat/web',
        pr_number: null,
        position: 0,
      },
    ])
    expect(sqlite.prepare('SELECT id, repo_id FROM workspaces ORDER BY id').all()).toEqual([
      { id: wsWeb, repo_id: web },
      { id: wsFirst, repo_id: api },
      { id: wsNone, repo_id: null },
    ])
    expect(sqlite.prepare('SELECT runs_seeded FROM repos').all()).toEqual([
      { runs_seeded: 0 },
      { runs_seeded: 0 },
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM run_configs').get()).toEqual({ n: 0 })

    // A repo deleted takes its ticket rows and run configs with it, and leaves its workspaces on the primary.
    sqlite
      .prepare("INSERT INTO run_configs (repo_id, name, type, start) VALUES (?, 'Preview', 'preview', 'x')")
      .run(web)
    sqlite.prepare('DELETE FROM repos WHERE id = ?').run(web)
    expect(sqlite.prepare('SELECT count(*) AS n FROM run_configs').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT ticket_id FROM ticket_repos ORDER BY ticket_id').all()).toEqual([
      { ticket_id: firstRepo },
    ])
    expect(sqlite.prepare('SELECT repo_id FROM workspaces WHERE id = ?').get(wsWeb)).toEqual({
      repo_id: null,
    })
    expect(() =>
      sqlite.prepare("INSERT INTO run_configs (repo_id, name, type) VALUES (?, 'x', 'cron')").run(api),
    ).toThrow(/CHECK constraint/)
    sqlite.close()
  })
})

describe('0041_repo_requests', () => {
  it('adds the repo request column without rebuilding the posts, so they, their cards and files stay', () => {
    const sqlite = databaseAt('0040_project_layout')
    const project = Number(
      sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('repos').lastInsertRowid,
    )
    const ticket = Number(
      sqlite
        .prepare('INSERT INTO tickets (project_id, title, created_by) VALUES (?, ?, ?)')
        .run(project, 'New repo', 'claude').lastInsertRowid,
    )
    const card = Number(
      sqlite
        .prepare(
          'INSERT INTO updates (ticket_id, author, body, decision, archive_tickets) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          ticket,
          'claude',
          'Archive #1?',
          JSON.stringify([{ label: 'Archive' }, { label: 'Keep' }]),
          JSON.stringify([ticket]),
        ).lastInsertRowid,
    )
    sqlite
      .prepare(
        "INSERT INTO attachments (update_id, name, mime, size, stored_as, uploaded_by) VALUES (?, 'a.png', 'image/png', 1, 'x', 'claude')",
      )
      .run(card)
    const before = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const after = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]
    expect(after.map(({ repo_request: _r, ...rest }) => withoutDropped(rest))).toEqual(
      before.map(withoutDropped),
    )
    expect(after.map((u) => u.repo_request)).toEqual([null])
    expect(sqlite.prepare('SELECT update_id FROM attachments').all()).toEqual([{ update_id: card }])
    sqlite.close()
  })
})

describe('0042_summary_phase', () => {
  it('adds Summary to open tickets with the hand-off phases, before Merged, and to lists equal to the built-in one', () => {
    const sqlite = databaseAt('0041_repo_requests')
    const project = (phases: string | null) =>
      Number(
        sqlite.prepare('INSERT INTO projects (name, default_phases) VALUES (?, ?)').run('p', phases)
          .lastInsertRowid,
      )
    const builtIn = project(null)
    const oldList = project('["Implementation","Pushed","PR","CI","Preview","Merged"]')
    const spaced = project('[" implementation ","PUSHED","pr","Ci","preview\\n","merged"]')
    const removed = project('["Implementation","Pushed","PR","Merged"]')
    const renamed = project('["Implementation","Pushed","PR","CI","Demo","Merged"]')
    const reordered = project('["Implementation","PR","Pushed","CI","Preview","Merged"]')
    const added = project('["Implementation","Pushed","PR","CI","Preview","Merged","Docs"]')
    const none = project('[]')
    const stage = sqlite.prepare('INSERT INTO stages (project_id, key, name, kind) VALUES (?, ?, ?, ?)')
    for (const [key, kind] of [
      ['todo', 'open'],
      ['in_progress', 'active'],
      ['review', 'review'],
      ['done', 'done'],
      ['cancelled', 'cancelled'],
      ['shipped', 'done'],
    ])
      stage.run(builtIn, key, key, kind)

    const ticket = (
      title: string,
      extra: { status?: string; archivedAt?: string; parentId?: number; prId?: number } = {},
    ) =>
      Number(
        sqlite
          .prepare(
            'INSERT INTO tickets (project_id, title, created_by, status, archived_at, parent_id, pr_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            builtIn,
            title,
            'claude',
            extra.status ?? 'in_progress',
            extra.archivedAt ?? null,
            extra.parentId ?? null,
            extra.prId ?? null,
          ).lastInsertRowid,
      )
    const task = (ticketId: number, text: string, position: number, done = false, parentId?: number) =>
      Number(
        sqlite
          .prepare('INSERT INTO tasks (ticket_id, text, position, done, parent_id) VALUES (?, ?, ?, ?, ?)')
          .run(ticketId, text, position, done ? 1 : 0, parentId ?? null).lastInsertRowid,
      )
    /** Seeded as addTasks does: the steps take positions after their phase, the phases after them. */
    const phased = (ticketId: number, phases: string[], doneUpTo = 0) => {
      let position = 0
      for (const [i, text] of phases.entries()) {
        const id = task(ticketId, text, position++, i < doneUpTo)
        if (text === 'Implementation') task(ticketId, 'step', position++, i < doneUpTo, id)
      }
    }
    const BUILT_IN_OLD = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Merged']

    const open = ticket('Open')
    phased(open, BUILT_IN_OLD, 3)
    const inReview = ticket('In review', { status: 'review' })
    phased(inReview, BUILT_IN_OLD, 5)
    const noMerged = ticket('No Merged')
    phased(noMerged, ['Implementation', 'Pushed', 'PR'])
    // Merged sharing its position with an earlier phase (older rows): Summary still lands between them.
    const shared = ticket('Shared positions')
    task(shared, 'Implementation', 0)
    task(shared, 'Preview', 1)
    task(shared, ' MERGED ', 1)
    task(shared, 'Notes', 2)
    // Not touched: these.
    const hasSummary = ticket('Has Summary')
    phased(hasSummary, ['Implementation', 'Pushed', ' summary ', 'Merged'])
    // A step named Summary is an ordinary task: the ticket still gets the phase.
    const subSummary = ticket('Summary as a step only')
    const subImpl = task(subSummary, 'Implementation', 0)
    task(subSummary, 'Summary', 1, false, subImpl)
    task(subSummary, 'Merged', 2)
    const done = ticket('Done', { status: 'done' })
    phased(done, BUILT_IN_OLD, 6)
    const shipped = ticket('Shipped', { status: 'shipped' })
    phased(shipped, BUILT_IN_OLD, 6)
    const cancelled = ticket('Cancelled', { status: 'cancelled' })
    phased(cancelled, BUILT_IN_OLD)
    const archived = ticket('Archived', { archivedAt: '2026-10-01' })
    phased(archived, BUILT_IN_OLD)
    // A PR's own ticket, from the queue.
    const repo = Number(
      sqlite
        .prepare("INSERT INTO repos (project_id, name, repo_path) VALUES (?, 'r', '/code/r')")
        .run(builtIn).lastInsertRowid,
    )
    const prRow = Number(
      sqlite
        .prepare(
          "INSERT INTO prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha, updated_at, fetched_at) VALUES (?, ?, 7, 't', 'u', 'a', 'h', 'main', 's', 'x', 'x')",
        )
        .run(builtIn, repo).lastInsertRowid,
    )
    const prTicket = ticket('A PR', { prId: prRow })
    phased(prTicket, BUILT_IN_OLD)
    const lane = ticket('Lane without phases', { parentId: open })
    task(lane, 'Implementation', 0)
    task(lane, 'Write it', 1)
    const plain = ticket('No tasks')

    const tasks = () => sqlite.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, unknown>[]
    const before = {
      tasks: tasks(),
      tickets: sqlite.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[],
      lists: sqlite.prepare('SELECT id, default_phases FROM projects ORDER BY id').all(),
    }

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    const order = (ticketId: number) =>
      (
        sqlite
          .prepare('SELECT text FROM tasks WHERE ticket_id = ? AND parent_id IS NULL ORDER BY position, id')
          .all(ticketId) as { text: string }[]
      ).map((r) => r.text)
    const phases = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Summary', 'Merged']
    const tree = (ticketId: number) =>
      (
        sqlite
          .prepare('SELECT text, parent_id FROM tasks WHERE ticket_id = ? ORDER BY position, id')
          .all(ticketId) as { text: string; parent_id: number | null }[]
      ).map((r) => (r.parent_id ? `- ${r.text}` : r.text))
    expect(order(open)).toEqual(phases)
    expect(order(inReview)).toEqual(phases)
    expect(order(noMerged)).toEqual(['Implementation', 'Pushed', 'PR', 'Summary'])
    expect(order(shared)).toEqual(['Implementation', 'Preview', 'Summary', ' MERGED ', 'Notes'])
    expect(tree(subSummary)).toEqual(['Implementation', '- Summary', 'Summary', 'Merged'])
    // A step keeps its place under its phase, in the tree as the page reads it.
    expect(tree(open)).toEqual([
      'Implementation',
      '- step',
      'Pushed',
      'PR',
      'CI',
      'Preview',
      'Summary',
      'Merged',
    ])
    // Added unticked, never blocked, once.
    const summaries = sqlite
      .prepare(
        "SELECT ticket_id, done, blocked, blocked_reason FROM tasks WHERE text = 'Summary' AND parent_id IS NULL ORDER BY ticket_id",
      )
      .all()
    expect(summaries).toEqual(
      [open, inReview, noMerged, shared, subSummary].map((ticket_id) => ({
        ticket_id,
        done: 0,
        blocked: 0,
        blocked_reason: '',
      })),
    )
    // Every row that was there is there, as it was but for the positions that made room.
    const after = tasks()
    const moved = new Set([open, inReview, shared, subSummary])
    expect(after.slice(0, before.tasks.length).map(({ position: _p, ...rest }) => rest)).toEqual(
      before.tasks.map(({ position: _p, ...rest }) => rest),
    )
    expect(
      after
        .slice(0, before.tasks.length)
        .filter((t) => !moved.has(t.ticket_id as number))
        .map((t) => t.position),
    ).toEqual(before.tasks.filter((t) => !moved.has(t.ticket_id as number)).map((t) => t.position))
    expect(after).toHaveLength(before.tasks.length + 5)
    for (const id of [hasSummary, done, shipped, cancelled, archived, prTicket, lane, plain])
      expect(after.filter((t) => t.ticket_id === id)).toEqual(before.tasks.filter((t) => t.ticket_id === id))
    // A later migration adds the tickets' place in the column: the rest of each is what it was.
    expect(
      (sqlite.prepare('SELECT * FROM tickets ORDER BY id').all() as Record<string, unknown>[]).map(
        ({ rank: _r, ...rest }) => withoutDropped(rest),
      ),
    ).toEqual(before.tickets.map(withoutDropped))

    const list = (id: number) =>
      (
        sqlite.prepare('SELECT default_phases FROM projects WHERE id = ?').get(id) as {
          default_phases: string | null
        }
      ).default_phases
    expect(list(builtIn)).toBeNull()
    expect(JSON.parse(list(oldList)!)).toEqual(phases)
    expect(JSON.parse(list(spaced)!)).toEqual([
      ' implementation ',
      'PUSHED',
      'pr',
      'Ci',
      'preview\n',
      'Summary',
      'merged',
    ])
    const lists = new Map(
      (before.lists as { id: number; default_phases: string | null }[]).map((r) => [r.id, r.default_phases]),
    )
    for (const id of [removed, renamed, reordered, added, none]) expect(list(id)).toBe(lists.get(id))
    sqlite.close()
  })
})

describe('0046_drop_resume_note', () => {
  it('drops the resume columns and the handoff marker, keeping every ticket, task and post', () => {
    const sqlite = databaseAt('0045_work_event_on')
    const project = Number(sqlite.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid)
    const ticket = Number(
      sqlite
        .prepare(
          'INSERT INTO tickets (project_id, title, created_by, resume_note, resume_at, resume_by, resume_sha) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          project,
          'Carried over',
          'enrique',
          '**State:** halfway',
          '2026-11-01T12:00:00.000Z',
          'claude',
          '0123456789abcdef',
        ).lastInsertRowid,
    )
    sqlite.prepare('INSERT INTO tasks (ticket_id, text, position) VALUES (?, ?, ?)').run(ticket, 'step', 0)
    const post = Number(
      sqlite
        .prepare('INSERT INTO updates (ticket_id, author, body, handoff) VALUES (?, ?, ?, ?)')
        .run(ticket, 'claude', 'where it stands', 1).lastInsertRowid,
    )

    migrate(drizzle(sqlite), { migrationsFolder: folder })

    expect(columns(sqlite, 'tickets')).not.toContain('resume_note')
    expect(columns(sqlite, 'tickets')).not.toContain('resume_at')
    expect(columns(sqlite, 'tickets')).not.toContain('resume_by')
    expect(columns(sqlite, 'tickets')).not.toContain('resume_sha')
    expect(columns(sqlite, 'updates')).not.toContain('handoff')
    expect(sqlite.prepare('SELECT id, title FROM tickets WHERE id = ?').get(ticket)).toEqual({
      id: ticket,
      title: 'Carried over',
    })
    expect(sqlite.prepare('SELECT ticket_id, text FROM tasks WHERE ticket_id = ?').get(ticket)).toEqual({
      ticket_id: ticket,
      text: 'step',
    })
    expect(
      sqlite.prepare('SELECT id, ticket_id, author, body, progress FROM updates WHERE id = ?').get(post),
    ).toEqual({ id: post, ticket_id: ticket, author: 'claude', body: 'where it stands', progress: 1 })
    sqlite.close()
  })
})
