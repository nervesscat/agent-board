import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { checkMigrations } from './check-migrations.mjs'

/** A migrations folder: its .sql files, and a journal with these entries (`[tag, idx, when]`). */
const made = []
afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

function fixture(files, entries) {
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
  return dir
}

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

  it('finds a `when` that does not grow, which drizzle would skip', () => {
    const dir = fixture(
      ['0000_init.sql', '0001_repos.sql', '0002_tags.sql'],
      [
        ['0000_init', 0, 100],
        ['0001_repos', 1, 300],
        ['0002_tags', 2, 300],
      ],
    )
    const problems = checkMigrations(dir)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(
      /^journal entry 2 \(0002_tags\): when 300 is not after the entry before it \(300\)/,
    )
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
