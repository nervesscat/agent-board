import { describe, expect, it, vi } from 'vitest'

import { whenArrived } from './remembered'

describe('whenArrived', () => {
  /** A router moving from the Overview to the PR queue: what whenArrived reads of it. */
  function moving() {
    const overview = { href: '/projects/p', state: { __TSR_key: 'k1' } }
    const queue = { href: '/projects/p/prs', state: { __TSR_key: 'k2' } }
    let status = 'pending'
    let resolved: typeof overview | undefined = overview
    const listeners = new Set<() => void>()
    const router = {
      latestLocation: queue,
      stores: { status: { get: () => status }, resolvedLocation: { get: () => resolved } },
      subscribe: (event: string, fn: () => void) => {
        expect(event).toBe('onResolved')
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const resolve = (to: typeof overview) => {
      status = 'idle'
      resolved = to
      for (const fn of listeners) fn()
    }
    return { router: router as never, queue, resolve, listeners }
  }

  it('waits for the move to the page shown to finish', () => {
    const { router, queue, resolve, listeners } = moving()
    const then = vi.fn()
    whenArrived(router, then)
    expect(then).not.toHaveBeenCalled()
    resolve(queue)
    expect(then).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('calls at once when the move has finished', () => {
    const { router, queue, resolve } = moving()
    resolve(queue)
    const then = vi.fn()
    whenArrived(router, then)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting while the page loaded is another entry than the one shown', () => {
    const { router, queue, resolve } = moving()
    const then = vi.fn()
    whenArrived(router, then)
    // The same URL under another entry of the history: not the move to this one.
    resolve({ ...queue, state: { __TSR_key: 'k0' } })
    expect(then).not.toHaveBeenCalled()
    resolve(queue)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when told to', () => {
    const { router, queue, resolve, listeners } = moving()
    const then = vi.fn()
    const stop = whenArrived(router, then)
    stop()
    expect(listeners.size).toBe(0)
    resolve(queue)
    expect(then).not.toHaveBeenCalled()
  })
})
