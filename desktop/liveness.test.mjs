import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LIVENESS_INTERVAL_MS, watchLiveness } from './app/liveness.mjs'

/**
 * A board whose answers the test decides: `answers` gets the number of the call, from 1.
 * @param {(call: number) => boolean} answers
 */
function board(answers = () => true) {
  let calls = 0
  return {
    calls: () => calls,
    check: async () => {
      calls++
      return answers(calls)
    },
  }
}

/** A report of the board going away, counting the reports. */
function loss() {
  let times = 0
  return { times: () => times, onLost: () => void times++ }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('watchLiveness', () => {
  it('checks the board every interval while it answers, and reports nothing', async () => {
    const clock = vi.getTimerCount()
    const health = board()
    const lost = loss()
    const watch = watchLiveness({ check: health.check, onLost: lost.onLost })
    watch.start()
    // Not at once: the board was just loaded, and a check is not a heartbeat.
    expect(health.calls()).toBe(0)
    expect(vi.getTimerCount()).toBe(clock + 1)

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS - 1)
    expect(health.calls()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(health.calls()).toBe(1)
    expect(vi.getTimerCount()).toBe(clock + 1)

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3)
    expect(health.calls()).toBe(4)
    expect(lost.times()).toBe(0)
  })

  it('reports a board that goes away once, and checks no more', async () => {
    // Answers the first two checks, then not.
    const health = board((call) => call <= 2)
    const lost = loss()
    const watch = watchLiveness({ check: health.check, onLost: lost.onLost })
    watch.start()

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 2)
    expect(health.calls()).toBe(2)
    expect(lost.times()).toBe(0)

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(health.calls()).toBe(3)
    expect(lost.times()).toBe(1)

    // The retry is the caller's from here: no further check and no second report.
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 10)
    expect(health.calls()).toBe(3)
    expect(lost.times()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a check that throws as the board gone', async () => {
    const lost = loss()
    const check = async () => {
      throw new Error('no answer')
    }
    const watch = watchLiveness({ check, onLost: lost.onLost })
    watch.start()
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(lost.times()).toBe(1)
  })

  it('asks once at a time: the next check waits for the answer to the one before', async () => {
    let calls = 0
    /** @type {((answers: boolean) => void)[]} */
    const waiting = []
    /** @type {() => Promise<boolean>} */
    const check = () =>
      new Promise((resolve) => {
        calls++
        waiting.push(resolve)
      })
    const lost = loss()
    const watch = watchLiveness({ check, onLost: lost.onLost })
    watch.start()

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(calls).toBe(1)
    // A board slow to answer is not asked again while its answer is out.
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3)
    expect(calls).toBe(1)

    waiting.shift()?.(true)
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(calls).toBe(2)
    waiting.shift()?.(false)
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3)
    expect(lost.times()).toBe(1)
    expect(calls).toBe(2)
  })

  it('checks nothing after stop, and reports nothing', async () => {
    const health = board()
    const lost = loss()
    const watch = watchLiveness({ check: health.check, onLost: lost.onLost })
    watch.start()
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(health.calls()).toBe(1)

    // The board's page left the window: the check waiting for its turn is dropped.
    watch.stop()
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 5)
    expect(health.calls()).toBe(1)
    expect(lost.times()).toBe(0)
  })

  it('drops a check in flight when it is stopped, and checks again when started', async () => {
    let calls = 0
    /** @type {((answers: boolean) => void)[]} */
    const waiting = []
    /** @type {() => Promise<boolean>} */
    const check = () =>
      new Promise((resolve) => {
        calls++
        waiting.push(resolve)
      })
    const lost = loss()
    const watch = watchLiveness({ check, onLost: lost.onLost })
    watch.start()
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(calls).toBe(1)

    // Stopped while the check is out: its answer, a lost board here, belongs to no watch.
    watch.stop()
    waiting.shift()?.(false)
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 5)
    expect(lost.times()).toBe(0)

    // Started again, as a freshly loaded board does: the next check is an interval away.
    watch.start()
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(calls).toBe(2)
    waiting.shift()?.(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(lost.times()).toBe(1)
  })

  it('has one check timer at a time, however often it is started', async () => {
    const health = board()
    const lost = loss()
    const clock = vi.getTimerCount()
    const watch = watchLiveness({ check: health.check, onLost: lost.onLost })
    watch.start()
    watch.start()
    watch.start()
    expect(vi.getTimerCount()).toBe(clock + 1)
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(health.calls()).toBe(1)
  })
})
