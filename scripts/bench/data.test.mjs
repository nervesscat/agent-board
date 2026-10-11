import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  SLOT_MS,
  assertBenchDataDir,
  generate,
  generatedPlan,
  msUntilSlot,
  pickTargets,
  prng,
  startOfLocalDay,
} from './data.mjs'

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
    const now = new Date(2026, 0, 15, 12).getTime()
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

describe('the generated dataset, whatever the hour', () => {
  const DAY = 86_400_000
  // Local times: a run that starts just after midnight, one late in the evening two days later, and
  // what the server reads for each, at its start and 23 minutes on (still the same day).
  const local = (day, h, m, s = 0) => new Date(2026, 9, day, h, m, s).getTime()
  const runs = [
    { name: 'just after midnight', generated: local(7, 0, 1, 30), reads: [local(7, 0, 2), local(7, 0, 25)] },
    {
      name: 'late in the evening',
      generated: local(9, 23, 36),
      reads: [local(9, 23, 37), local(9, 23, 59, 30)],
    },
  ]

  /**
   * A response with every moment and day in it written relative to the dataset's day: `D-3+120` is
   * 120 ms after midnight three local days before, `D0` today. What is left must not differ at all.
   */
  const relative = (value, anchor) => {
    const dayOffset = (ms) => Math.round((startOfLocalDay(ms) - anchor) / DAY)
    return JSON.stringify(value)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (iso) => {
        const ms = Date.parse(iso)
        return `D${dayOffset(ms)}+${ms - startOfLocalDay(ms)}`
      })
      .replace(
        /(?<![\dT:+-])\d{4}-\d{2}-\d{2}(?![\dT])/g,
        (day) => `D${dayOffset(new Date(`${day}T00:00:00`).getTime())}`,
      )
  }

  it("refuses to put today's rows after the moment it is generated for", () => {
    expect(msUntilSlot(local(7, 0, 0, 20))).toBe(SLOT_MS - 20_000)
    expect(msUntilSlot(local(7, 0, 1))).toBe(0)
    expect(() =>
      generate(path.join(root, 'too-early'), {
        scale: 0.05,
        seed: 3,
        migrationsFolder,
        now: local(7, 0, 0, 20),
      }),
    ).toThrow(/after midnight/)
  })

  it('reads the same through the server at any hour: today, carried over, stalled, days in progress, reports due', async () => {
    const seen = []
    for (const run of runs) {
      const dir = path.join(root, `hour-${runs.indexOf(run)}`)
      generate(dir, { scale: 0.05, seed: 3, migrationsFolder, now: run.generated })
      const db = new Database(path.join(dir, 'board.db'), { readonly: true })
      const newest = db
        .prepare(
          'select max(m) as m from (select max(createdAt) as m from updates union all select max(createdAt) from comments union all select max(createdAt) from activity union all select max(updatedAt) from tickets)',
        )
        .get().m
      db.close()
      expect(Date.parse(newest), 'no row after the moment it was generated for').toBeLessThanOrEqual(
        run.generated,
      )

      // The server's own code on this dataset, at the moments it would read it.
      vi.resetModules()
      process.env.DATA_DIR = dir
      const { getSummary } = await import('#/server/summary')
      const { dailyReport, today } = await import('#/server/daily')
      const { listReports } = await import('#/server/reports')
      const anchor = startOfLocalDay(run.generated)
      for (const at of run.reads) {
        const now = new Date(at)
        const { generatedAt: _at, ...summary } = getSummary(undefined, { now })
        const daily = dailyReport(today(now))
        // A period's label names its date ("Fri, Oct 9"), which no layout of the data can keep.
        const reports = listReports(1, {}, now).periods.map(({ label: _label, ...p }) => p)
        expect(daily.activity.length, 'something happened today').toBeGreaterThan(0)
        expect(
          summary.projects.some((p) => p.carryingOver.length),
          'work carried over',
        ).toBe(true)
        expect(
          new Set(summary.projects.flatMap((p) => p.inProgress.map((t) => t.stale))),
          'stalled work and work going on',
        ).toEqual(new Set([true, false]))
        seen.push({
          run: run.name,
          at: new Date(at).toString(),
          bytes: { summary: JSON.stringify(summary).length, daily: JSON.stringify(daily).length },
          summary: relative(summary, anchor),
          daily: relative(daily, anchor),
          reports: relative(reports, anchor),
        })
      }
      ;(await import('#/db')).db.$client.close()
    }
    const [first, ...rest] = seen
    for (const s of rest) {
      expect(s.bytes, `${s.run} at ${s.at}`).toEqual(first.bytes)
      expect(s.summary, `${s.run} at ${s.at}: the summary`).toBe(first.summary)
      expect(s.daily, `${s.run} at ${s.at}: the daily report`).toBe(first.daily)
      expect(s.reports, `${s.run} at ${s.at}: the report periods`).toBe(first.reports)
    }
  }, 120_000)
})
