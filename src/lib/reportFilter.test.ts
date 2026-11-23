import { describe, expect, it } from 'vitest'

import {
  agentOptions,
  filterReports,
  hasFilters,
  hasUnroundedReport,
  NO_REPORT_FILTERS,
  type ReportFilters,
  reportRanAt,
  roundOptions,
  sortReports,
} from './reportFilter'
import type { RunReport } from './runReports'

const HOUR = 3_600_000
// A local noon, so "today" starts 12 hours before it whatever the zone.
const now = new Date(2026, 9, 20, 12, 0, 0).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

let next = 1
const report = (more: Partial<RunReport> = {}): RunReport => ({
  id: next++,
  projectId: 1,
  ticketId: 1,
  agent: 'builder',
  round: null,
  branch: '',
  headSha: '',
  model: '',
  effort: '',
  briefedBy: '',
  startedAt: null,
  endedAt: null,
  durationMs: 0,
  durationSource: 'unknown',
  reportedDurationMs: null,
  time: { readingMs: 0, runningMs: 0, waitingMs: 0, writingMs: 0, otherMs: 0 },
  difficulty: null,
  confidence: null,
  steps: [],
  counts: {},
  sections: {},
  author: 'orch',
  createdAt: iso(now - HOUR),
  ...more,
})
const ids = (rs: RunReport[]) => rs.map((r) => r.id)
const filters = (f: Partial<ReportFilters>): ReportFilters => ({ ...NO_REPORT_FILTERS, ...f })

describe('filterReports', () => {
  it('keeps every report with no filter', () => {
    const rs = [report(), report({ agent: 'hunt', round: 1 })]
    expect(filterReports(rs, NO_REPORT_FILTERS, now)).toEqual(rs)
  })

  it('matches an agent whole and ignoring case', () => {
    const a = report({ agent: 'Hunt' })
    const b = report({ agent: 'hunt-2' })
    const c = report({ agent: 'builder' })
    expect(ids(filterReports([a, b, c], filters({ agent: 'hunt' }), now))).toEqual([a.id])
  })

  it('matches a round, or the runs outside any round', () => {
    const none = report()
    const one = report({ round: 1 })
    const two = report({ round: 2 })
    expect(ids(filterReports([none, one, two], filters({ round: 2 }), now))).toEqual([two.id])
    expect(ids(filterReports([none, one, two], filters({ round: 'none' }), now))).toEqual([none.id])
  })

  it('matches a rating exactly, or the unrated', () => {
    const rs = [
      report({ difficulty: 1, confidence: 5 }),
      report({ difficulty: 4, confidence: null }),
      report({ difficulty: null, confidence: 4 }),
    ]
    expect(ids(filterReports(rs, filters({ difficulty: 4 }), now))).toEqual([rs[1]!.id])
    expect(ids(filterReports(rs, filters({ difficulty: 'unrated' }), now))).toEqual([rs[2]!.id])
    expect(ids(filterReports(rs, filters({ confidence: 4 }), now))).toEqual([rs[2]!.id])
    expect(ids(filterReports(rs, filters({ confidence: 'unrated' }), now))).toEqual([rs[1]!.id])
    expect(filterReports(rs, filters({ difficulty: 3 }), now)).toEqual([])
  })

  it('splits the reported durations from the unreported', () => {
    const measured = report({ durationSource: 'measured', durationMs: 5 })
    const self = report({ durationSource: 'self', durationMs: 5 })
    const unknown = report()
    const rs = [measured, self, unknown]
    expect(ids(filterReports(rs, filters({ duration: 'reported' }), now))).toEqual([measured.id, self.id])
    expect(ids(filterReports(rs, filters({ duration: 'unreported' }), now))).toEqual([unknown.id])
  })

  describe('time', () => {
    const recent = report({ endedAt: iso(now - 30 * 60_000) })
    const earlierToday = report({ endedAt: iso(now - 5 * HOUR) })
    const yesterday = report({ endedAt: iso(now - 20 * HOUR) })
    const lastWeek = report({ endedAt: iso(now - 6 * 24 * HOUR) })
    const old = report({ endedAt: iso(now - 8 * 24 * HOUR) })
    const rs = [recent, earlierToday, yesterday, lastWeek, old]

    it('admits the last hour, today from the local midnight and the last 7 days', () => {
      expect(ids(filterReports(rs, filters({ time: 'hour' }), now))).toEqual([recent.id])
      expect(ids(filterReports(rs, filters({ time: 'today' }), now))).toEqual([recent.id, earlierToday.id])
      expect(ids(filterReports(rs, filters({ time: 'week' }), now))).toEqual([
        recent.id,
        earlierToday.id,
        yesterday.id,
        lastWeek.id,
      ])
    })

    it('counts the end, else the start, else the report time', () => {
      const ended = report({ startedAt: iso(now - 9 * 24 * HOUR), endedAt: iso(now - 10 * 60_000) })
      const started = report({ startedAt: iso(now - 20 * 60_000), createdAt: iso(now - 9 * 24 * HOUR) })
      const written = report({ createdAt: iso(now - 40 * 60_000) })
      expect(reportRanAt(ended)).toBe(now - 10 * 60_000)
      expect(reportRanAt(started)).toBe(now - 20 * 60_000)
      expect(reportRanAt(written)).toBe(now - 40 * 60_000)
      expect(ids(filterReports([ended, started, written, old], filters({ time: 'hour' }), now))).toEqual([
        ended.id,
        started.id,
        written.id,
      ])
    })
  })

  it('needs every filter to match', () => {
    const hit = report({ agent: 'hunt', round: 2, difficulty: 4, confidence: 3, durationSource: 'self' })
    const rs = [
      hit,
      report({ agent: 'hunt', round: 1, difficulty: 4, confidence: 3, durationSource: 'self' }),
      report({ agent: 'verify', round: 2, difficulty: 4, confidence: 3, durationSource: 'self' }),
      report({ agent: 'hunt', round: 2, difficulty: 4, confidence: 3 }),
      report({
        agent: 'hunt',
        round: 2,
        difficulty: 4,
        confidence: 3,
        durationSource: 'self',
        createdAt: iso(now - 30 * HOUR),
      }),
    ]
    const f = filters({
      agent: 'hunt',
      round: 2,
      difficulty: 4,
      confidence: 3,
      duration: 'reported',
      time: 'today',
    })
    expect(ids(filterReports(rs, f, now))).toEqual([hit.id])
  })
})

describe('hasFilters', () => {
  it('is false for the empty filters and true once any is set', () => {
    expect(hasFilters(NO_REPORT_FILTERS)).toBe(false)
    expect(hasFilters(filters({ agent: 'hunt' }))).toBe(true)
    expect(hasFilters(filters({ round: 'none' }))).toBe(true)
    expect(hasFilters(filters({ time: 'hour' }))).toBe(true)
    expect(hasFilters(filters({ difficulty: 'unrated' }))).toBe(true)
    expect(hasFilters(filters({ confidence: 1 }))).toBe(true)
    expect(hasFilters(filters({ duration: 'unreported' }))).toBe(true)
  })
})

describe('sortReports', () => {
  const a = report({ createdAt: iso(now - 3 * HOUR), durationMs: 10, difficulty: 2, confidence: 5 })
  const b = report({ createdAt: iso(now - 1 * HOUR), durationMs: 30, difficulty: 5, confidence: null })
  const c = report({ createdAt: iso(now - 2 * HOUR), durationMs: 30, difficulty: null, confidence: 5 })
  const d = report({ createdAt: iso(now - 4 * HOUR), durationMs: 20, difficulty: 5, confidence: 1 })
  const rs = [a, b, c, d]

  it('puts the newest first, and the oldest first', () => {
    expect(ids(sortReports(rs, 'newest'))).toEqual([b.id, c.id, a.id, d.id])
    expect(ids(sortReports(rs, 'oldest'))).toEqual([d.id, a.id, c.id, b.id])
  })

  it('puts the longest first, ties newest first', () => {
    expect(ids(sortReports(rs, 'longest'))).toEqual([b.id, c.id, d.id, a.id])
  })

  it('puts the highest difficulty first, the unrated last, ties newest first', () => {
    expect(ids(sortReports(rs, 'difficulty'))).toEqual([b.id, d.id, a.id, c.id])
  })

  it('puts the highest confidence first, the unrated last, ties newest first', () => {
    expect(ids(sortReports(rs, 'confidence'))).toEqual([c.id, a.id, d.id, b.id])
  })

  it('orders by the run, not the report time, and leaves its input alone', () => {
    const late = report({ createdAt: iso(now - 9 * HOUR), endedAt: iso(now - 10 * 60_000) })
    const input = [b, late]
    expect(ids(sortReports(input, 'newest'))).toEqual([late.id, b.id])
    expect(ids(input)).toEqual([b.id, late.id])
  })

  it('is stable for reports that tie on everything but the id', () => {
    const at = iso(now - HOUR)
    const x = report({ createdAt: at })
    const y = report({ createdAt: at })
    expect(ids(sortReports([x, y], 'newest'))).toEqual([y.id, x.id])
    expect(ids(sortReports([y, x], 'newest'))).toEqual([y.id, x.id])
  })
})

describe('options', () => {
  const rs = [
    report({ agent: 'hunt', round: 2 }),
    report({ agent: 'Hunt', round: 1 }),
    report({ agent: 'builder' }),
    report({ agent: 'hunt', round: 2 }),
  ]

  it('lists each agent once, sorted', () => {
    expect(agentOptions(rs)).toEqual(['builder', 'hunt'])
  })

  it('lists the rounds present, ascending, and whether a report has none', () => {
    expect(roundOptions(rs)).toEqual([1, 2])
    expect(hasUnroundedReport(rs)).toBe(true)
    expect(hasUnroundedReport([rs[0]!])).toBe(false)
    expect(roundOptions([])).toEqual([])
  })
})
