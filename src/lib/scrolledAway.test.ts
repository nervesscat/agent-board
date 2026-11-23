import { describe, expect, it } from 'vitest'

import { scrolledAway } from './scrolledAway'

const entry = (isIntersecting: boolean, bottom: number) =>
  ({ isIntersecting, boundingClientRect: { bottom } }) as Parameters<typeof scrolledAway>[0]

describe('scrolledAway', () => {
  it('is false while the element is in view, wholly or partly', () => {
    expect(scrolledAway(entry(true, 120), 49)).toBe(false)
    expect(scrolledAway(entry(true, 52), 49)).toBe(false)
  })

  it('is true once it has gone up under the bar', () => {
    expect(scrolledAway(entry(false, 49), 49)).toBe(true)
    expect(scrolledAway(entry(false, -300), 49)).toBe(true)
  })

  it('is false for an element below the window, not yet scrolled to', () => {
    expect(scrolledAway(entry(false, 1400), 49)).toBe(false)
  })
})
