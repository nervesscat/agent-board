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
    // A later migration adds the Merged phase marker: the rest of each ticket is what it was.
    expect(after.tickets.map((t) => ({ ...t, pr_id: undefined, merged_phase_checked: undefined }))).toEqual(
      before.tickets,
    )
    expect(after.tasks).toEqual(before.tasks)
    // Later migrations add the posts' tab, summary and archive request columns: the rest of each post is
    // what it was.
    expect(
      after.updates.map(({ tab: _t, summary: _s, summary_change: _c, archive_tickets: _a, ...rest }) => rest),
    ).toEqual(before.updates)
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
    const before = sqlite.prepare('SELECT * FROM updates ORDER BY id').all()

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
    // Every other column reads as it did (a later migration adds the archive request one); no post is a
    // summary.
    const after = sqlite.prepare('SELECT * FROM updates ORDER BY id').all() as Record<string, unknown>[]
    expect(
      after.map(({ tab: _t, summary: _s, summary_change: _c, archive_tickets: _a, ...rest }) => rest),
    ).toEqual(before)
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
    expect(after.map(({ archive_tickets: _a, ...rest }) => rest)).toEqual(before)
    expect(after.map((u) => u.archive_tickets)).toEqual([null])
    expect(sqlite.prepare('SELECT update_id FROM attachments').all()).toEqual([{ update_id: card }])
    sqlite.close()
  })
})

describe('0034_auto_phase_state', () => {
  it('leaves existing tickets to be looked at for Merged, and no PR green by a local run, rows kept', () => {
    const sqlite = databaseAt('0033_archive_requests')
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

    migrate(drizzle(sqlite), { migrationsFolder: folder })

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
