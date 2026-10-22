import { afterEach, describe, expect, it, vi } from 'vitest'

import { anchorId, cameBack, followHistory, parseAnchor } from './reveal'

describe('parseAnchor', () => {
  it('names an element by its id', () => {
    expect(parseAnchor('post-12')).toEqual({ hash: 'post-12', target: 'post-12', holder: null })
    expect(parseAnchor('handoff')).toEqual({ hash: 'handoff', target: 'handoff', holder: null })
    expect(parseAnchor('reply-40')).toEqual({ hash: 'reply-40', target: 'reply-40', holder: null })
  })

  it('names a reply with the element whose thread holds it', () => {
    expect(parseAnchor('post-12-reply-40')).toEqual({
      hash: 'post-12-reply-40',
      target: 'reply-40',
      holder: 'post-12',
    })
  })

  it('has nothing without a hash, and takes anything else as an id as it is', () => {
    expect(parseAnchor('')).toBeNull()
    expect(parseAnchor('post-x-reply-4')).toEqual({
      hash: 'post-x-reply-4',
      target: 'post-x-reply-4',
      holder: null,
    })
  })
})

describe('anchorId', () => {
  it('reads the number of an id of the kind asked for', () => {
    expect(anchorId('post-12', 'post')).toBe(12)
    expect(anchorId('pr-3', 'pr')).toBe(3)
  })

  it('is null for another kind, a malformed id or none', () => {
    expect(anchorId('pr-3', 'post')).toBeNull()
    expect(anchorId('post-12-reply-4', 'post')).toBeNull()
    expect(anchorId('post-', 'post')).toBeNull()
    expect(anchorId(null, 'post')).toBeNull()
    expect(anchorId(undefined, 'post')).toBeNull()
  })
})

describe('followHistory', () => {
  /** The browser's history, its replaceState patched as the router patches it to hear of each one. */
  class BrowserHistory {
    state: unknown = null
    replaceState(state: unknown) {
      this.state = state
    }
  }
  const routerState = { __TSR_index: 0, key: 'k1', __TSR_key: 'k1' }

  function follow() {
    const history = new BrowserHistory()
    const patched = vi.fn()
    Object.assign(history, { replaceState: patched })
    vi.stubGlobal('window', { history })
    vi.stubGlobal('document', { dispatchEvent: () => true })
    let hear: (move: { action: { type: string }; location: { state: unknown } }) => void = () => {}
    const location = { href: '/prs', state: routerState }
    followHistory({
      history: { subscribe: (fn: typeof hear) => ((hear = fn), () => {}) },
      latestLocation: location,
      stores: { resolvedLocation: { get: () => location } },
    } as never)
    const move = (type: string) => hear({ action: { type }, location: { state: routerState } })
    return { history, patched, move }
  }

  afterEach(() => vi.unstubAllGlobals())

  it('takes Back and Forward to an entry of the router for a return', () => {
    const { history, move } = follow()
    history.state = { __TSR_index: 2, key: 'k2', __TSR_key: 'k2' }
    move('BACK')
    expect(cameBack()).toBe(true)
    move('GO')
    expect(cameBack()).toBe(true)
    move('PUSH')
    expect(cameBack()).toBe(false)
  })

  it('takes a #link typed into the address bar, an entry with no state of the router, for an arrival', () => {
    const { history, patched, move } = follow()
    history.state = null
    move('GO')
    expect(cameBack()).toBe(false)
    // The entry keeps the state the router made up for it, written past the router's patch, so a later
    // Back or Forward to it is a return.
    expect(history.state).toEqual(routerState)
    expect(patched).not.toHaveBeenCalled()
    move('BACK')
    expect(cameBack()).toBe(true)
  })
})
