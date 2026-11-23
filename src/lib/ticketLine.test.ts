import { describe, expect, it } from 'vitest'

import { stamp } from '#/lib/format'
import { openedByText, openedText, updatedText } from '#/lib/ticketLine'

describe('the ticket line texts', () => {
  const iso = '2026-11-21T09:12:00.000Z'

  it('say who opened it, in which role, and when', () => {
    expect(openedByText('claude', 'Orchestrator', iso)).toBe(
      `Opened by claude (Orchestrator) on ${stamp(iso)}`,
    )
    expect(openedByText('enrique', 'Human', iso)).toMatch(/^Opened by enrique \(Human\) on .+\d/)
  })

  it('say when it was opened, with the full date and time', () => {
    expect(openedText(iso)).toBe(`Opened on ${stamp(iso)}`)
  })

  it('say when it was updated, with the full date and time', () => {
    expect(updatedText(iso)).toBe(`Updated on ${stamp(iso)}`)
    expect(updatedText(iso)).not.toMatch(/ago/)
  })
})
