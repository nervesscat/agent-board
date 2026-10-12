import { describe, expect, it } from 'vitest'

import { laidOutDays } from './data.mjs'
import {
  Metrics,
  beyondNoise,
  compareResults,
  markdownComparison,
  markdownSummary,
  percentile,
  slope,
} from './report.mjs'

const results = (metrics, extra = {}) => ({
  label: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:10:00.000Z',
  wallMs: 600_000,
  machine: {
    cpu: 'cpu',
    cores: 4,
    memoryGB: 16,
    freeMemoryGB: 8,
    os: 'os',
    osRelease: '1',
    arch: 'x64',
    node: 'v24',
    pnpm: '11',
  },
  target: {
    path: '/w',
    sha: 'a'.repeat(40),
    branch: 'b',
    dirty: 0,
    buildDir: '/w/.bench/build/w',
    buildMs: 1000,
  },
  settings: {
    server: 'build',
    sections: ['server'],
    runs: 3,
    requests: 20,
    warmup: 3,
    loads: 3,
    idleSeconds: 60,
    memorySeconds: 180,
    memoryRate: 20,
    scale: 1,
    seed: 1,
  },
  server: { mode: 'production build', host: '127.0.0.1', ports: [47200] },
  instrumentation: { available: true, reason: null },
  datasets: { generated: { counts: { tickets: 1 }, picks: {}, details: {}, metrics } },
  ...extra,
})

describe('percentile', () => {
  it('interpolates between ranks and ignores what is not a number', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([10, null, 20], 50)).toBe(15)
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i + 1),
        95,
      ),
    ).toBeCloseTo(19.05)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('Metrics', () => {
  it('keeps every run, the median and the range', () => {
    const m = new Metrics()
    for (const v of [12, 10, 11]) m.add('server.x.p50_ms', v, 'ms')
    expect(m.toJSON()['server.x.p50_ms']).toEqual({
      unit: 'ms',
      runs: [12, 10, 11],
      median: 11,
      min: 10,
      max: 12,
      spread: 0.18,
    })
  })

  it('drops what a run added when it does not count', () => {
    const m = new Metrics()
    m.add('a', 1, 'ms')
    const mark = m.mark()
    m.add('a', 2, 'ms')
    m.add('b', null, 'count', 'not counted')
    m.rollback(mark)
    m.add('a', 3, 'ms')
    expect(m.toJSON()).toEqual({
      a: { unit: 'ms', runs: [1, 3], median: 2, min: 1, max: 3, spread: 1 },
    })
  })

  it('reports a metric it could not measure as unavailable with the reason, never as 0', () => {
    const m = new Metrics()
    m.add('server.x.db_queries', null, 'count', 'not counted under vite dev')
    const x = m.toJSON()['server.x.db_queries']
    expect(x.median).toBeNull()
    expect(x.na).toBe('not counted under vite dev')
    const md = markdownSummary(
      results(
        { 'server.endpoint.me.db_queries': x },
        {
          datasets: {
            generated: {
              counts: {},
              picks: {},
              metrics: { 'server.endpoint.me.db_queries': x },
              details: { server: { endpoints: {} } },
            },
          },
        },
      ),
    )
    const row = md.split('\n').find((l) => l.startsWith('| me |'))
    expect(row).toContain('| n/a |')
    expect(row).not.toContain('| 0 |')
    expect(md).toContain('n/a: not counted under vite dev')
  })
})

describe('markdownSummary of a run that went past midnight', () => {
  it('names the day the data was first laid out on, then the day it was written again for', () => {
    const generator = { plan: {}, scale: 1, seed: 1, day: '2026-10-11' }
    // As the harness keeps them: laid out on the 11th, past midnight, written again for the 12th.
    const days = laidOutDays(generator)
    expect(days.over(new Date(2026, 9, 11, 23, 59).getTime())).toBe(false)
    expect(days.over(new Date(2026, 9, 12, 0, 1).getTime())).toBe(true)
    days.writtenAgain('2026-10-12')
    expect(days.over(new Date(2026, 9, 12, 0, 2).getTime())).toBe(false)
    expect(generator).toMatchObject({ day: '2026-10-11', days: ['2026-10-11', '2026-10-12'] })
    const md = markdownSummary(
      results(
        {},
        {
          datasets: {
            generated: {
              source: { generator },
              counts: {},
              picks: {},
              metrics: {},
              details: {},
              redone: [3],
            },
          },
        },
      ),
    )
    expect(md).toContain(
      'Laid out on the local day 2026-10-11 (written again for 2026-10-12). Run again because they went past midnight: run 3.',
    )
  })
})

describe('slope', () => {
  it('is the least-squares slope', () => {
    expect(
      slope([
        [0, 1],
        [1, 3],
        [2, 5],
      ]),
    ).toBe(2)
    expect(slope([[0, 1]])).toBeNull()
  })
})

describe('comparing two results', () => {
  const metric = (runs, unit = 'ms') => {
    const m = new Metrics()
    for (const r of runs) m.add('k', r, unit)
    return m.toJSON().k
  }

  it('flags a change only when the ranges over the runs do not overlap', () => {
    expect(beyondNoise(metric([10, 11, 12]), metric([11.5, 12, 13]))).toBe(false)
    expect(beyondNoise(metric([10, 11, 12]), metric([13, 14, 15]))).toBe(true)
    expect(beyondNoise(metric([10, 11, 12]), metric([7, 8, 9]))).toBe(true)
    // Bytes do not vary between runs: any change counts.
    expect(beyondNoise(metric([1000], 'bytes'), metric([1001], 'bytes'))).toBe(true)
    expect(beyondNoise(metric([1000], 'bytes'), metric([1000], 'bytes'))).toBe(false)
    // A time from a single run has no range to judge it by.
    expect(beyondNoise(metric([10]), metric([20, 21, 22]))).toBeNull()
  })

  it('lists every metric of both files with before, after and the change', () => {
    const before = results({ a: metric([10, 10, 10]), gone: metric([1]) })
    const after = results({ a: metric([5, 5, 5]), added: metric([2]) })
    const rows = compareResults(before, after)
    expect(rows.find((r) => r.key === 'a')).toMatchObject({ delta: -5, pct: -50, beyond: true })
    expect(rows.find((r) => r.key === 'gone')).toMatchObject({ only: 'before' })
    expect(rows.find((r) => r.key === 'added')).toMatchObject({ only: 'after' })
    const md = markdownComparison(before, after, rows)
    expect(md).toContain('| a | 10 ms | 5 ms | -5 ms | -50.0% | yes, down |')
    expect(md).not.toContain('not comparable')
  })

  it('warns when the two runs measured different servers', () => {
    const before = results({ a: metric([10]) })
    const after = results({ a: metric([10]) }, { settings: { ...before.settings, server: 'dev' } })
    expect(markdownComparison(before, after)).toContain('before: build, after: dev')
  })
})
