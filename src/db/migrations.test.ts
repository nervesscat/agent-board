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

describe('0028_project_tag_suggestions', () => {
  it('gives every project the default suggestions and keeps its rows and theirs', () => {
    const sqlite = databaseAt('0027_relayed_decisions')
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
