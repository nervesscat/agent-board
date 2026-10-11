import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'

import { assertBenchDataDir, generate, generatedPlan, pickTargets, prng } from './data.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-test-'))
const migrationsFolder = path.resolve('drizzle')
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

describe('assertBenchDataDir', () => {
  const live = path.join(root, 'checkout', 'data')
  it('refuses the live data folder, a folder in it, and a folder that holds it', () => {
    expect(() => assertBenchDataDir(live, [live])).toThrow(/refusing/)
    expect(() => assertBenchDataDir(path.join(live, 'dev'), [live])).toThrow(/refusing/)
    expect(() => assertBenchDataDir(path.join(root, 'checkout'), [live])).toThrow(/refusing/)
  })
  it('accepts a folder of its own', () => {
    expect(() =>
      assertBenchDataDir(path.join(root, 'checkout', '.bench', 'work', 'live-copy'), [live]),
    ).not.toThrow()
  })
})

describe('the generated dataset', () => {
  it('is the same for the same seed', () => {
    const a = prng(7)
    const b = prng(7)
    expect(Array.from({ length: 5 }, a.next)).toEqual(Array.from({ length: 5 }, b.next))
  })

  it('fills every table the hot endpoints read, with attachment bytes where local storage keeps them', () => {
    const dir = path.join(root, 'gen')
    const now = Date.parse('2026-01-15T12:00:00Z')
    const scale = 0.05
    const { counts, plan } = generate(dir, { scale, seed: 3, migrationsFolder, now })
    expect(plan).toEqual(generatedPlan(scale))
    expect(counts.projects).toBe(plan.projects)
    expect(counts.tickets).toBeGreaterThan(plan.projects * plan.rootTickets)
    for (const table of [
      'stages',
      'agents',
      'repos',
      'prs',
      'tasks',
      'updates',
      'comments',
      'attachments',
      'activity',
      'review_results',
    ])
      expect(counts[table], table).toBeGreaterThan(0)

    const db = new Database(path.join(dir, 'board.db'), { readonly: true })
    const lanes = db.prepare('select count(*) as n from tickets where parent_id is not null').get().n
    const files = db.prepare('select stored_as, size from attachments').all()
    db.close()
    expect(lanes).toBeGreaterThan(0)
    for (const f of files) expect(fs.statSync(path.join(dir, 'uploads', f.stored_as)).size).toBe(f.size)
    expect(fs.existsSync(path.join(dir, 'repos', 'app', '.git'))).toBe(true)

    const picks = pickTargets(path.join(dir, 'board.db'))
    expect(picks).toMatchObject({ projectId: 1, human: 'bench-human' })
    expect(picks.ticketPosts).toBe(plan.bigTicketPosts)

    // The same seed and scale give the same rows.
    const again = generate(path.join(root, 'gen2'), { scale, seed: 3, migrationsFolder, now })
    expect(again.counts).toEqual(counts)
  }, 60_000)
})
