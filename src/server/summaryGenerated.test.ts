import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

// The benchmark's generated board, written before the db module opens it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

type Generate = (
  dest: string,
  opts: { scale: number; seed: number; migrationsFolder: string; now: number },
) => unknown

// The board's local afternoon, as the benchmark lays its rows out for it.
const NOW = new Date(2026, 9, 7, 15)

let summary: typeof import('./summary')
let reference: typeof import('./summaryReference')
let dbm: typeof import('#/db')
let humans: string[] = []

beforeAll(async () => {
  const data = pathToFileURL(path.resolve('scripts/bench/data.mjs')).href
  const { generate, GENERATED_HUMAN } = (await import(data)) as {
    generate: Generate
    GENERATED_HUMAN: string
  }
  generate(tmp, { scale: 0.25, seed: 1, migrationsFolder: path.resolve('drizzle'), now: NOW.getTime() })
  humans = [GENERATED_HUMAN]
  summary = await import('./summary')
  reference = await import('./summaryReference')
  dbm = await import('#/db')
}, 120_000)

describe('the batched summary on the generated board', () => {
  it('answers as the per-project one did, byte for byte', () => {
    const projects = dbm.db.select().from(dbm.schema.projects).all()
    expect(projects.length).toBeGreaterThan(2)
    for (const opts of [{ humans, now: NOW }, { now: NOW }])
      for (const c of reference.summariesBothWays(opts)) {
        expect(
          reference.firstDifference(c.reference, c.unindexed),
          `${c.label}, without the indexes`,
        ).toBeNull()
        expect(reference.firstDifference(c.reference, c.batched), `${c.label}, with the indexes`).toBeNull()
      }
    // The board is busy enough to have something in every section.
    const all = summary.getSummary(undefined, { humans, now: NOW }).projects
    const count = (f: (p: (typeof all)[number]) => number) => all.reduce((n, p) => n + f(p), 0)
    expect(count((p) => p.needsYou.decisions.length)).toBeGreaterThan(0)
    expect(count((p) => p.needsYou.threads.length)).toBeGreaterThan(0)
    expect(count((p) => p.needsYou.prs.length)).toBeGreaterThan(0)
    expect(count((p) => p.inProgress.length)).toBeGreaterThan(0)
    expect(count((p) => p.carryingOver.length)).toBeGreaterThan(0)
    expect(count((p) => p.doneToday.activity)).toBeGreaterThan(0)
  }, 120_000)
})
