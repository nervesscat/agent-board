import { describe, expect, it } from 'vitest'

import type { TicketEvent } from '#/lib/api'

import { waitRowText } from './WorkTimelineCard'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const start = (more: Partial<TicketEvent> = {}) => ({ at: at('12:00'), reason: 'human', note: '', ...more })
const end = (more: Partial<TicketEvent> = {}) => ({ at: at('12:05'), note: '', ...more })

describe('waitRowText', () => {
  it('says whom a paired wait waited for and how long, and the note its end gave', () => {
    expect(waitRowText(start(), end({ note: 'approved the spec' }), Date.parse(at('13:00')))).toBe(
      'waited for you · 5 min: approved the spec',
    )
  })

  it('leaves the note out when the end gave none', () => {
    expect(waitRowText(start(), end(), Date.parse(at('13:00')))).toBe('waited for you · 5 min')
  })

  it('runs an open wait to the ticket end, with no note', () => {
    expect(waitRowText(start({ reason: 'lock', note: 'build' }), undefined, Date.parse(at('12:43')))).toBe(
      'waiting for the lock (build) · 43 min',
    )
  })
})
