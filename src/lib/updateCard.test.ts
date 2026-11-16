import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdates, UpdatesState } from './updates'
import {
  artworkCandidates,
  artworkVersion,
  forgetUpdateMemory,
  NO_UPDATE_MEMORY,
  recallUpdateMemory,
  rememberUpdateSeen,
  rememberUpdateSkipped,
  shouldShow,
  subscribeUpdateMemory,
  UPDATE_CARD_KEY,
} from './updateCard'

const desktop = (over: Partial<DesktopUpdates> = {}): DesktopUpdates => ({
  mode: 'desktop',
  installed: '0.2.0',
  packageType: 'pacman',
  status: 'none',
  newest: null,
  progress: null,
  error: null,
  manual: null,
  checkedAt: null,
  settings: { autoCheck: true, prereleases: false },
  ...over,
})

const available = (version = '0.3.0'): DesktopUpdates =>
  desktop({ status: 'available', newest: { version, notes: 'Fixes', notesMarkdown: 'Fixes', date: null } })

/** A storage like localStorage, with whatever is already in it. */
function fakeStore(saved: string | null = null) {
  const values = new Map<string, string>()
  if (saved !== null) values.set(UPDATE_CARD_KEY, saved)
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

describe('shouldShow', () => {
  const fresh = NO_UPDATE_MEMORY

  it('is true only for the desktop app offering a release this browser has not seen or skipped', () => {
    expect(shouldShow(available(), fresh)).toBe(true)
    // A version that was seen, skipped, or both, is not offered again.
    expect(shouldShow(available(), { seenVersion: '0.3.0', skippedVersion: null })).toBe(false)
    expect(shouldShow(available(), { seenVersion: null, skippedVersion: '0.3.0' })).toBe(false)
    expect(shouldShow(available(), { seenVersion: '0.3.0', skippedVersion: '0.3.0' })).toBe(false)
    // A later release is offered again.
    expect(shouldShow(available('0.4.0'), { seenVersion: '0.3.0', skippedVersion: '0.3.0' })).toBe(true)
  })

  it('is false for every state but a fresh offer', () => {
    const states: (UpdatesState | undefined)[] = [
      undefined,
      { mode: 'checkout' },
      ...(
        ['none', 'idle', 'checking', 'downloading', 'installing', 'manual', 'error', 'unsupported'] as const
      ).map((status) => desktop({ status, newest: status === 'unsupported' ? null : available().newest })),
      desktop({ status: 'available', newest: null }),
    ]
    for (const state of states) expect(shouldShow(state, fresh)).toBe(false)
  })
})

describe('what this browser remembers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips the seen and skipped versions through one key', () => {
    const store = fakeStore()
    expect(recallUpdateMemory(store)).toEqual(NO_UPDATE_MEMORY)

    rememberUpdateSeen('0.3.0', store)
    expect(recallUpdateMemory(store)).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
    expect(JSON.parse(store.values.get(UPDATE_CARD_KEY)!)).toEqual({
      seenVersion: '0.3.0',
      skippedVersion: null,
    })

    // A skip keeps the seen version too: the card was shown for it either way.
    rememberUpdateSkipped('0.3.0', store)
    expect(recallUpdateMemory(store)).toEqual({ seenVersion: '0.3.0', skippedVersion: '0.3.0' })

    // Undo forgets both, so the release can be offered again.
    forgetUpdateMemory(store)
    expect(store.values.has(UPDATE_CARD_KEY)).toBe(false)
    expect(recallUpdateMemory(store)).toEqual(NO_UPDATE_MEMORY)
  })

  it('reads nothing remembered out of a missing key, invalid JSON, another shape or other values', () => {
    for (const saved of [
      null,
      '',
      '{ not json',
      'null',
      '[]',
      '"0.3.0"',
      '42',
      JSON.stringify({ seenVersion: 3, skippedVersion: true }),
      JSON.stringify({ seen: '0.3.0' }),
    ])
      expect(recallUpdateMemory(fakeStore(saved)), String(saved)).toEqual(NO_UPDATE_MEMORY)
    // A value that is not a string next to one that is keeps only the string.
    expect(
      recallUpdateMemory(fakeStore(JSON.stringify({ seenVersion: '0.3.0', skippedVersion: 7 }))),
    ).toEqual({ seenVersion: '0.3.0', skippedVersion: null })
  })

  it('neither throws nor loses the offer when the storage refuses to read or write', () => {
    const refusing = {
      getItem: () => {
        throw new Error('storage is not available')
      },
      setItem: () => {
        throw new Error('storage is not available')
      },
      removeItem: () => {
        throw new Error('storage is not available')
      },
    }
    expect(() => recallUpdateMemory(refusing)).not.toThrow()
    expect(recallUpdateMemory(refusing)).toEqual(NO_UPDATE_MEMORY)
    expect(() => rememberUpdateSeen('0.3.0', refusing)).not.toThrow()
    expect(() => rememberUpdateSkipped('0.3.0', refusing)).not.toThrow()
    expect(() => forgetUpdateMemory(refusing)).not.toThrow()
    // Nothing was recorded, so the offer still stands: it is not silently dropped.
    expect(shouldShow(available(), recallUpdateMemory(refusing))).toBe(true)
  })

  it('reads and writes the browser’s own localStorage by default', () => {
    const store = fakeStore()
    vi.stubGlobal('localStorage', store)
    rememberUpdateSkipped('0.3.0')
    expect(store.values.get(UPDATE_CARD_KEY)).toBe(
      JSON.stringify({ seenVersion: '0.3.0', skippedVersion: '0.3.0' }),
    )
    expect(recallUpdateMemory()).toEqual({ seenVersion: '0.3.0', skippedVersion: '0.3.0' })
  })

  it('tells a page that has read it when Skip or Undo changes it', () => {
    const store = fakeStore()
    const heard = vi.fn()
    const stop = subscribeUpdateMemory(heard)
    // Seen alone is not a choice the page must follow: the card writing it stays open.
    rememberUpdateSeen('0.3.0', store)
    expect(heard).not.toHaveBeenCalled()
    rememberUpdateSkipped('0.3.0', store)
    expect(heard).toHaveBeenCalledTimes(1)
    forgetUpdateMemory(store)
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    rememberUpdateSkipped('0.4.0', store)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})

describe('the artwork files', () => {
  it('are the version’s own, without a leading v', () => {
    expect(artworkVersion('0.3.0')).toBe('0.3.0')
    expect(artworkVersion('v0.3.0')).toBe('0.3.0')
  })

  it('follow the page’s theme, with the light file as the dark page’s fallback', () => {
    expect(artworkCandidates('0.3.0', true)).toEqual([
      '/release-art/0.3.0-dark.svg',
      '/release-art/0.3.0-light.svg',
    ])
    expect(artworkCandidates('0.3.0', false)).toEqual(['/release-art/0.3.0-light.svg'])
    expect(artworkCandidates('v0.3.0', true)).toEqual([
      '/release-art/0.3.0-dark.svg',
      '/release-art/0.3.0-light.svg',
    ])
    // A pre-release keeps its suffix.
    expect(artworkCandidates('0.4.0-beta.1', false)).toEqual(['/release-art/0.4.0-beta.1-light.svg'])
  })
})
