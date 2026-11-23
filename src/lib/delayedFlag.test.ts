import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { afterDelay, isOtherTicket } from '#/lib/delayedFlag'

describe('afterDelay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once the delay has passed, not before', () => {
    const fire = vi.fn()
    afterDelay(150, fire)
    vi.advanceTimersByTime(149)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('never fires when cancelled first (a fast load)', () => {
    const fire = vi.fn()
    const cancel = afterDelay(150, fire)
    vi.advanceTimersByTime(100)
    cancel()
    vi.advanceTimersByTime(1000)
    expect(fire).not.toHaveBeenCalled()
  })
})

describe('isOtherTicket', () => {
  it('is true with no data', () => expect(isOtherTicket(undefined, '5')).toBe(true))
  it('is true for another ticket', () => expect(isOtherTicket({ id: 4 }, '5')).toBe(true))
  it('is false for the ticket asked for', () => expect(isOtherTicket({ id: 5 }, '5')).toBe(false))
})
