import { afterEach, describe, expect, it, vi } from 'vitest'

import { KEY_ENTRIES, anchorId, cameBack, followHistory, parseAnchor } from './reveal'

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

  it('takes Back to an entry the browser made before the router started for a return', () => {
    // The page as the browser loads it: one entry, no state, and the head's script run on it.
    const listeners = new Set<() => void>()
    const history = new BrowserHistory()
    const win = {
      history,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }
    new Function('window', KEY_ENTRIES)(win)
    const opened = history.state as { __TSR_key: string }
    expect(opened).toEqual({ __TSR_index: 0, key: opened.__TSR_key, __TSR_key: opened.__TSR_key })
    // A #link followed while the scripts load: the browser's own entry, keyed as it is made.
    const browserMakes = () => {
      history.state = null
      for (const fn of listeners) fn()
    }
    browserMakes()
    const followed = history.state as { __TSR_key: string }
    expect(followed.__TSR_key).toBeTruthy()
    expect(followed.__TSR_key).not.toBe(opened.__TSR_key)

    // The router starts on that entry, and from then on the browser's entries are left to followHistory.
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', { dispatchEvent: () => true })
    let hear: (move: { action: { type: string }; location: { state: unknown } }) => void = () => {}
    const location = { href: '/prs', state: followed }
    followHistory({
      history: { subscribe: (fn: typeof hear) => ((hear = fn), () => {}) },
      latestLocation: location,
      stores: { resolvedLocation: { get: () => location } },
    } as never)
    expect(listeners.size).toBe(0)
    expect('stopKeyingEntries' in win).toBe(false)

    // Back to the entry the page was opened on: a return.
    history.state = opened
    hear({ action: { type: 'GO' }, location: { state: opened } })
    expect(cameBack()).toBe(true)
    // A #link typed into the address bar now: an arrival still.
    browserMakes()
    expect(history.state).toBeNull()
    hear({ action: { type: 'GO' }, location: { state: routerState } })
    expect(cameBack()).toBe(false)
    expect(history.state).toEqual(routerState)
  })
})
