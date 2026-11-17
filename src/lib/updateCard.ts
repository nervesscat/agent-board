import type { UpdatesState } from './updates'

/**
 * The release announcement the desktop app shows at start: one card per release this browser has not
 * seen, kept here so a reload or a restart does not bring it back. Not stored on the server: it is this
 * browser's, like the theme and the other remembered choices.
 */
export interface UpdateMemory {
  /** The release the card was last shown for. */
  seenVersion: string | null
  /** The release Skip was pressed for; Settings, Updates lists it until it is undone. */
  skippedVersion: string | null
}

/** One key, both versions in it. */
export const UPDATE_CARD_KEY = 'update-card'

export const NO_UPDATE_MEMORY: UpdateMemory = { seenVersion: null, skippedVersion: null }

/** What reading and writing need of a storage; the browser's localStorage, or a stand-in in tests. */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** This browser's storage, or null where it cannot be reached at all (some privacy modes throw). */
function storage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Told when a choice of this browser changes, so a page that read it agrees with one that wrote it. */
const listeners = new Set<() => void>()

/** Calls `listener` whenever the memory is written or cleared; returns the remover. */
export function subscribeUpdateMemory(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const announce = () => {
  for (const listener of listeners) listener()
}

/**
 * What this browser remembers. Anything but the two version strings (no key, invalid JSON, another
 * value's shape) reads as nothing remembered, and a storage that refuses to read too: a broken value
 * never throws at the page, it just offers the card again.
 */
export function recallUpdateMemory(store: Store | null = storage()): UpdateMemory {
  try {
    const raw = store?.getItem(UPDATE_CARD_KEY)
    if (!raw) return { ...NO_UPDATE_MEMORY }
    const saved: unknown = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...NO_UPDATE_MEMORY }
    const { seenVersion, skippedVersion } = saved as Record<string, unknown>
    return {
      seenVersion: typeof seenVersion === 'string' ? seenVersion : null,
      skippedVersion: typeof skippedVersion === 'string' ? skippedVersion : null,
    }
  } catch {
    return { ...NO_UPDATE_MEMORY }
  }
}

/** Saves it; a storage that refuses to write changes nothing and throws nothing. */
function write(memory: UpdateMemory, store: Store | null) {
  try {
    store?.setItem(UPDATE_CARD_KEY, JSON.stringify(memory))
  } catch {}
}

/** Records that the card was shown for `version`: not a skip, so Settings has nothing to undo. */
export function rememberUpdateSeen(version: string, store: Store | null = storage()): UpdateMemory {
  const memory = { ...recallUpdateMemory(store), seenVersion: version }
  write(memory, store)
  return memory
}

/** Records a Skip: the card is seen and skipped for `version` until Settings' Undo forgets it. */
export function rememberUpdateSkipped(version: string, store: Store | null = storage()): UpdateMemory {
  const memory = { ...recallUpdateMemory(store), seenVersion: version, skippedVersion: version }
  write(memory, store)
  announce()
  return memory
}

/** Forgets both versions (Settings' Undo): the card may show the release again. */
export function forgetUpdateMemory(store: Store | null = storage()) {
  try {
    store?.removeItem(UPDATE_CARD_KEY)
  } catch {}
  announce()
}

/**
 * Whether the card is due: the desktop app offers a release this browser has neither seen nor skipped.
 * Every other state — a checkout board, a check still running, an error, nothing newer — stays quiet,
 * and so does an offer without a version.
 */
export function shouldShow(state: UpdatesState | undefined, memory: UpdateMemory): boolean {
  if (state?.mode !== 'desktop' || state.status !== 'available') return false
  const version = state.newest?.version
  return Boolean(version) && version !== memory.seenVersion && version !== memory.skippedVersion
}

/** The version as its artwork is named: a release tag's leading `v` is not part of the file names. */
export const artworkVersion = (version: string) => version.replace(/^v/, '')

/**
 * The release's artwork files to try, in order: this theme's, then, on a dark page, the light one (a
 * release may ship one variant only). A light page has no dark file to fall back to. With neither, the
 * card shows its placeholder header.
 */
export function artworkCandidates(version: string, dark: boolean): string[] {
  const file = `/release-art/${artworkVersion(version)}`
  return dark ? [`${file}-dark.svg`, `${file}-light.svg`] : [`${file}-light.svg`]
}
