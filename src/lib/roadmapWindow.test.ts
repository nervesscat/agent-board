import { describe, expect, it } from 'vitest'

import { parseWindowChoice, windowFor, type WindowRow } from './roadmapWindow'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Noon, local time, so `today` (local midnight) is six hours back and no DST edge is in play.
const now = new Date(2026, 10, 8, 12, 0, 0).getTime()
const row = (start: string | null): WindowRow => ({ work: { start } })
const at = (ms: number) => new Date(ms).toISOString()

describe('parseWindowChoice', () => {
  it('keeps the four choices', () => {
    expect(parseWindowChoice('today')).toBe('today')
    expect(parseWindowChoice('24h')).toBe('24h')
    expect(parseWindowChoice('7d')).toBe('7d')
    expect(parseWindowChoice('fit')).toBe('fit')
  })

  it('falls back to the default for unknown or absent input', () => {
    expect(parseWindowChoice('30d')).toBe('default')
    expect(parseWindowChoice('')).toBe('default')
    expect(parseWindowChoice(undefined)).toBe('default')
    expect(parseWindowChoice(7)).toBe('default')
  })
})

describe('windowFor', () => {
  const rows = [row(at(now - 3 * HOUR)), row(null)]

  it('today runs from local midnight to now', () => {
    expect(windowFor('today', rows, now)).toEqual({ start: new Date(2026, 10, 8).getTime(), end: now })
  })

  it('24h and 7d run that long back to now, whatever the rows', () => {
    expect(windowFor('24h', rows, now)).toEqual({ start: now - DAY, end: now })
    expect(windowFor('7d', rows, now)).toEqual({ start: now - 7 * DAY, end: now })
  })

  it('fit starts at the earliest start among the rows, however far back', () => {
    const old = [row(at(now - 3 * DAY)), row(at(now - HOUR))]
    expect(windowFor('fit', old, now)).toEqual({ start: now - 3 * DAY, end: now })
  })

  it('fit with no work to show falls back to a day back', () => {
    expect(windowFor('fit', [row(null)], now)).toEqual({ start: now - DAY, end: now })
    expect(windowFor('fit', [], now)).toEqual({ start: now - DAY, end: now })
  })

  it('the default starts at the earliest start when that is within 24 h', () => {
    expect(windowFor('default', rows, now)).toEqual({ start: now - 3 * HOUR, end: now })
  })

  it('the default caps an earlier start at 24 h back', () => {
    const early = [row(at(now - 3 * DAY)), row(at(now - 2 * HOUR))]
    expect(windowFor('default', early, now)).toEqual({ start: now - DAY, end: now })
  })

  it('the default with no rows is 24 h back', () => {
    expect(windowFor('default', [], now)).toEqual({ start: now - DAY, end: now })
  })
})
