import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  SLOT_MS,
  assertBenchDataDir,
  generate,
  generatedPlan,
  generationMoment,
  msUntilSlot,
  pickTargets,
  prng,
  startOfLocalDay,
} from './data.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-test-'))
const migrationsFolder = path.resolve('drizzle')
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

/**
 * A read's own clock, left out: the times it stamps (`generatedAt`, each activity's `now`), and the
 * liveness it works out against that clock. A ticket whose last word came today reads Working early in
 * the day and Stalled late in it, so `liveness` (`silentMinutes`, the `stalled` flag it sets, the
 * `stalled` and `lostContact` lists it fills) is left out, and so is the count of the stalled rows in
 * `needsYou.total`, which it feeds. What is left must not differ.
 */
const READ_CLOCK = new Set(['now', 'liveness', 'silentMinutes', 'stalled', 'lostContact'])
const withoutReadTimes = (value) => {
  const copy = JSON.parse(JSON.stringify(value))
  for (const p of copy.projects ?? []) if (p.needsYou?.stalled) p.needsYou.total -= p.needsYou.stalled.length
  return JSON.parse(
    JSON.stringify(copy, (k, v) =>
      (k === 'now' && typeof v === 'string') || READ_CLOCK.has(k) ? undefined : v,
    ),
  )
}

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
  // In a zone with no clock change in the 60 days the dataset spans (the days of a change are tested
  // below), whatever the machine's zone; the zone it had is put back after.
  let zone
  beforeAll(() => {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    process.env.TZ = 'America/Guatemala'
  })
  afterAll(() => {
    process.env.TZ = zone
  })
  // Local times: a run that starts just after midnight, one late in the evening two days later, and
  // what the server reads for each, at its start and 23 minutes on (still the same day). Taken when the
  // tests run, in the zone above.
  const local = (day, h, m, s = 0) => new Date(2026, 9, day, h, m, s).getTime()
  const runs = () => [
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

  it('generates for the clock read the wait was decided on, also in the last moment before midnight', async () => {
    const lastMoment = local(10, 0, 0) - 1
    const reads = [lastMoment, lastMoment + 2]
    const waits = []
    const now = await generationMoment({ clock: () => reads.shift(), sleep: (ms) => waits.push(ms) })
    expect(now).toBe(lastMoment)
    expect(waits).toEqual([])
    // A second read, past midnight and before the new day's ready moment, would be refused.
    expect(msUntilSlot(lastMoment + 2)).toBeGreaterThan(0)
    expect(() =>
      generate(path.join(root, 'last-moment'), { scale: 0.05, seed: 3, migrationsFolder, now }),
    ).not.toThrow()

    // Too soon after midnight: it waits, then hands on the read after the wait.
    const after = [local(10, 0, 0, 20), local(10, 0, 1) + 100]
    const announced = []
    const ready = await generationMoment({
      clock: () => after.shift(),
      sleep: (ms) => waits.push(ms),
      onWait: (ms) => announced.push(ms),
    })
    expect(announced).toEqual([SLOT_MS - 20_000])
    expect(waits).toEqual([SLOT_MS - 20_000 + 100])
    expect(ready).toBe(local(10, 0, 1) + 100)
  }, 60_000)

  it('reads the same through the server at any hour: today, carried over, stalled, days in progress, reports due', async () => {
    const seen = []
    for (const [i, run] of runs().entries()) {
      const dir = path.join(root, `hour-${i}`)
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
        const { generatedAt: _at, ...read } = getSummary(undefined, { now })
        const summary = withoutReadTimes(read)
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

describe('the generated dataset, whatever the hour on a daylight saving change', () => {
  const DAY = 86_400_000
  // Each day's earliest moment it is generated for, in minutes after its midnight: an hour later on the
  // day the clocks go back and in the days after they go forward.
  const cases = [
    { tz: 'Europe/Madrid', day: [2026, 9, 25], ready: 61, what: 'the clocks go back (a 25 h day)' },
    { tz: 'Europe/Madrid', day: [2026, 10, 5], ready: 1, what: '11 days after they went back' },
    { tz: 'Europe/Madrid', day: [2027, 2, 28], ready: 1, what: 'the clocks go forward (a 23 h day)' },
    { tz: 'Europe/Madrid', day: [2027, 2, 29], ready: 61, what: 'the day after they went forward' },
    { tz: 'America/New_York', day: [2026, 10, 1], ready: 61, what: 'the clocks go back (a 25 h day)' },
    { tz: 'America/New_York', day: [2027, 2, 20], ready: 61, what: '6 days after they went forward' },
  ]
  const plain = [2026, 9, 14]

  /** Runs `fn` with the process in time zone `tz`, then puts back the zone it had. */
  const inZone = async (tz, fn) => {
    const before = Intl.DateTimeFormat().resolvedOptions().timeZone
    process.env.TZ = tz
    try {
      return await fn()
    } finally {
      process.env.TZ = before
    }
  }

  /** Every moment in the database, row by row, as [calendar days before `today`, whole days before `now`]. */
  const ages = (dir, today, now) => {
    const db = new Database(path.join(dir, 'board.db'), { readonly: true })
    const out = []
    for (const { name } of db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all())
      for (const row of db.prepare(`select * from "${name}" order by rowid`).all())
        for (const v of Object.values(row))
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) {
            const ms = Date.parse(v)
            out.push([Math.round((today - startOfLocalDay(ms)) / DAY), Math.floor((now - ms) / DAY)])
          }
    db.close()
    return out
  }

  /** What the server answers at `at`, with every moment and date in it blanked out. */
  const answers = async (dir, at) => {
    vi.resetModules()
    process.env.DATA_DIR = dir
    const { getSummary } = await import('#/server/summary')
    const { dailyReport, today } = await import('#/server/daily')
    const now = new Date(at)
    const { generatedAt: _at, ...read } = getSummary(undefined, { now })
    const summary = withoutReadTimes(read)
    const daily = dailyReport(today(now))
    ;(await import('#/db')).db.$client.close()
    const blank = (value) =>
      JSON.stringify(value)
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'T')
        .replace(/\d{4}-\d{2}-\d{2}/g, 'D')
    const working = summary.projects.flatMap((p) => p.inProgress)
    return {
      stalled: working.filter((t) => t.stale).length,
      going: working.filter((t) => !t.stale).length,
      bytes: JSON.stringify(summary).length,
      summary: blank(summary),
      daily: blank(daily),
    }
  }

  /** The dataset of a day generated at its earliest moment, read then and late that evening. */
  const day = async (tz, [y, m, d], name) =>
    inZone(tz, async () => {
      const midnight = new Date(y, m, d).getTime()
      const tomorrow = new Date(y, m, d + 1).getTime()
      const at = midnight + 30_000
      const ready = at + msUntilSlot(at)
      const dir = path.join(root, name)
      generate(dir, { scale: 0.05, seed: 3, migrationsFolder, now: ready })
      const reads = [
        ready,
        new Date(y, m, d, 10).getTime(),
        new Date(y, m, d, 23, 30).getTime(),
        tomorrow - 1000,
      ]
      const read = []
      for (const now of reads) read.push(await answers(dir, now))
      return {
        hours: (tomorrow - midnight) / 3_600_000,
        readyAfter: (ready - midnight) / 60_000,
        ages: reads.map((now) => ages(dir, midnight, now)),
        answers: read,
      }
    })

  it('keeps every row on its calendar day and its whole days old, and reads the same at any hour', async () => {
    const plains = new Map()
    for (const c of cases) {
      const label = `${c.tz} ${c.day.join('-')}, ${c.what}`
      if (!plains.has(c.tz)) plains.set(c.tz, await day(c.tz, plain, `dst-plain-${c.tz.replace('/', '-')}`))
      const ref = plains.get(c.tz)
      expect(ref.hours, `${c.tz}: the plain day`).toBe(24)
      expect(ref.readyAfter).toBe(1)
      const got = await day(c.tz, c.day, `dst-${c.tz.replace('/', '-')}-${c.day.join('-')}`)
      expect(got.readyAfter, `${label}: generated from`).toBe(c.ready)
      for (const [i, ages] of got.ages.entries())
        expect(ages, `${label}: calendar and whole days of every row, read ${i}`).toEqual(ref.ages[0])
      for (const [i, a] of got.answers.entries()) {
        expect(a.stalled, `${label}: stalled, read ${i}`).toBe(ref.answers[0].stalled)
        expect(a.going, `${label}: going on, read ${i}`).toBe(ref.answers[0].going)
        expect(a, `${label}: read ${i}`).toEqual(ref.answers[0])
      }
    }
  }, 600_000)
})
