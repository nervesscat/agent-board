import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { checkMigrations } from './check-migrations.mjs'

/**
 * A migrations folder: its .sql files, and a journal with these entries (`[tag, idx, when]`). `snapshots` maps
 * a file in meta/ to its content: an object is written as JSON, a string as it is.
 */
const made = []
afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

function fixture(files, entries, snapshots = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-migrations-'))
  made.push(dir)
  fs.mkdirSync(path.join(dir, 'meta'))
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'select 1;\n')
  const journal = {
    version: '7',
    dialect: 'sqlite',
    entries: entries.map(([tag, idx, when]) => ({ idx, version: '6', when, tag, breakpoints: true })),
  }
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal))
  for (const [file, content] of Object.entries(snapshots))
    fs.writeFileSync(
      path.join(dir, 'meta', file),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  return dir
}

/** A snapshot file's content: its id, and the id of the snapshot it follows. */
const snap = (id, prevId) => ({ version: '6', dialect: 'sqlite', id, prevId })

const sound = () =>
  fixture(
    ['0000_init.sql', '0001_repos.sql', '0002_tags.sql'],
    [
      ['0000_init', 0, 100],
      ['0001_repos', 1, 200],
      ['0002_tags', 2, 300],
    ],
  )

describe('checkMigrations', () => {
  it('passes the repo’s own migrations', () => {
    expect(checkMigrations(path.resolve('drizzle'))).toEqual([])
  })

  it('passes a sound folder', () => {
    expect(checkMigrations(sound())).toEqual([])
  })

  it('finds two migrations with one number', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '0001_tags.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 200],
        ['0001_tags', 2, 300],
      ],
    )
    expect(checkMigrations(dir)).toEqual([
      '0001_tags.sql: number 0001 is also 0001_repos.sql',
      "journal entry 2 (0001_tags): idx 2 is not the file's number 0001",
    ])
  })

  it('finds a journal entry without its file, and a file without its entry', () => {
    const dir = fixture(
      ['0000_init.sql', '0002_tags.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 200],
      ],
    )
    expect(checkMigrations(dir)).toEqual([
      'journal entry 1 (0001_repos): 0001_repos.sql is missing',
      '0002_tags.sql: no journal entry',
    ])
  })

  it('finds an idx that is not the file’s number or its place', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 3, 200],
      ],
    )
    expect(checkMigrations(dir)).toEqual([
      "journal entry 1 (0001_repos): idx 3 is not the file's number 0001",
      'journal entry 1 (0001_repos): idx 3 is not its place in the journal (1)',
    ])
  })

  it('finds two entries with one `when`, because the loader keys each applied migration by it', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '0002_tags.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 300],
        ['0002_tags', 2, 300],
      ],
    )
    expect(checkMigrations(dir)).toEqual([
      'journal entry 2 (0002_tags): when 300 is also used by journal entry 1 (0001_repos); the loader keys each migration by it',
    ])
  })

  it('accepts two timestamp entries with one idx, since the loader never reads it', () => {
    const dir = fixture(
      ['0000_init.sql', '20261127093012_a.sql', '20261127093100_b.sql'],
      [
        ['0000_init', 0, 100],
        ['20261127093012_a', 3, 200],
        ['20261127093100_b', 3, 300],
      ],
    )
    expect(checkMigrations(dir)).toEqual([])
  })

  it('finds a journal that lists one tag twice, which would run the migration twice', () => {
    const dir = fixture(
      ['0000_init.sql', '20261127093012_a.sql'],
      [
        ['0000_init', 0, 100],
        ['20261127093012_a', 1, 200],
        ['20261127093012_a', 2, 300],
      ],
    )
    expect(checkMigrations(dir)).toEqual([
      'journal entry 2 (20261127093012_a): the tag is also an earlier entry, so the migration would run twice',
    ])
  })

  it('accepts a timestamp entry whose `when` is older than the entry before it, a branch merged late', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '20261127093012_a.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 300],
        ['20261127093012_a', 2, 200],
      ],
    )
    expect(checkMigrations(dir)).toEqual([])
  })

  it('accepts timestamp names, and refuses a timestamp-like name that is not one', () => {
    const dir = fixture(
      ['0000_init.sql', '20261127093012_add_x.sql'],
      [
        ['0000_init', 0, 100],
        ['20261127093012_add_x', 1, 200],
      ],
    )
    expect(checkMigrations(dir)).toEqual([])
    for (const bad of ['20261127_x', '20261127093012', '2026-11-27_x']) {
      const dir = fixture(['0000_init.sql', `${bad}.sql`], [['0000_init', 0, 100]])
      expect(checkMigrations(dir)).toEqual([
        `${bad}.sql: not named YYYYMMDDHHMMSS_slug.sql`,
        `${bad}.sql: no journal entry`,
      ])
    }
  })

  it('refuses a new numbered migration above 0066, which the timestamp name replaces', () => {
    const dir = fixture(
      ['0000_init.sql', '0067_x.sql'],
      [
        ['0000_init', 0, 100],
        ['0067_x', 67, 200],
      ],
    )
    // The fixture puts 0067 second, so it is also out of its place: that problem is reported too.
    expect(checkMigrations(dir)).toContain('0067_x.sql: new migrations are named YYYYMMDDHHMMSS_slug.sql')
  })

  it('accepts timestamp and numbered migrations in one journal', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '20261127093012_a.sql', '20261127093100_b.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 200],
        ['20261127093012_a', 2, 300],
        ['20261127093100_b', 3, 400],
      ],
    )
    expect(checkMigrations(dir)).toEqual([])
  })

  it('accepts two branches that each add a migration, merged in either order', () => {
    const base = [
      ['0000_init', 0, 100],
      ['0001_repos', 1, 200],
    ]
    const files = ['0000_init.sql', '0001_repos.sql', '20261127093012_a.sql', '20261127093100_b.sql']
    // Each branch's entry is numbered after the base; merged in the other order, the two swap places.
    expect(
      checkMigrations(fixture(files, [...base, ['20261127093012_a', 2, 300], ['20261127093100_b', 3, 400]])),
    ).toEqual([])
    expect(
      checkMigrations(fixture(files, [...base, ['20261127093100_b', 2, 400], ['20261127093012_a', 3, 300]])),
    ).toEqual([])
  })

  it('finds two snapshots that follow the same one, a merge that forked the chain', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '0002_tags.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 200],
        ['0002_tags', 2, 300],
      ],
      {
        '0000_snapshot.json': snap('id-0', '00000000-root'),
        '0001_snapshot.json': snap('id-1', 'id-0'),
        '0002_snapshot.json': snap('id-2', 'id-0'),
      },
    )
    expect(checkMigrations(dir)).toEqual([
      'meta/0001_snapshot.json and meta/0002_snapshot.json both follow snapshot id-0: a merge forked the snapshot chain (see CONTRIBUTING.md, Database changes)',
    ])
  })

  it('passes a linear snapshot chain, with a snapshot file missing from the numbers', () => {
    // 0001 has no snapshot file (as 0047 has none in the repo): the chain is still linear.
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '0002_tags.sql', '0003_more.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 200],
        ['0002_tags', 2, 300],
        ['0003_more', 3, 400],
      ],
      {
        '0000_snapshot.json': snap('id-0', '00000000-root'),
        '0002_snapshot.json': snap('id-2', 'id-0'),
        '0003_snapshot.json': snap('id-3', 'id-2'),
      },
    )
    expect(checkMigrations(dir)).toEqual([])
  })

  it('finds a snapshot that does not parse, and names it', () => {
    const dir = fixture(['0000_init.sql'], [['0000_init', 0, 100]], {
      '0000_snapshot.json': snap('id-0', '00000000-root'),
      '0001_snapshot.json': '{',
    })
    expect(checkMigrations(dir)).toEqual([expect.stringMatching(/^meta\/0001_snapshot\.json: /)])
  })

  it('finds a file not named NNNN_name.sql, and an unreadable journal', () => {
    const dir = sound()
    fs.writeFileSync(path.join(dir, 'extra.sql'), '')
    expect(checkMigrations(dir)).toEqual([
      'extra.sql: not named NNNN_name.sql',
      'extra.sql: no journal entry',
    ])
    fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), '{')
    expect(checkMigrations(dir)[1]).toMatch(/^meta\/_journal\.json: /)
  })
})
