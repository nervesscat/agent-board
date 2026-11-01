import { type AnyRouter, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

/**
 * A choice a page keeps in its URL (so the server renders it, a link shares it and a reload keeps
 * it) and that this browser remembers for the next visit without one. Storage is read only after
 * mount: read while rendering, the browser's first render would disagree with the server's (which has
 * no storage), and React keeps the server's attributes, so a tab would show one choice and the page
 * another. With none in the URL, `restore` gets the remembered one, if any, to put in the URL, once
 * the move to the page has finished (`whenArrived`).
 */
export function useRestoreRemembered<T extends string>(
  key: string,
  current: T | undefined,
  allowed: readonly T[],
  restore: (value: T) => void,
) {
  const router = useRouter()
  useEffect(() => {
    if (current !== undefined) return
    return whenArrived(router, () => {
      const value = recall(key, allowed)
      if (value !== undefined) restore(value)
    })
    // Once per visit without a value in the URL: `allowed` is a constant and `restore` only navigates.
  }, [key, current])
}

/** What whenArrived reads of the router. */
type Moving = Pick<AnyRouter, 'latestLocation' | 'stores' | 'subscribe'>

/**
 * Calls `then` once the router has finished the move to the page shown, at once if it has: until
 * then, a page puts nothing in its URL by itself. The page mounts while the move to it is still
 * loading, and as the next move starts the router keeps the window's place for the last page it
 * finished loading, the one the reader left: a replace that early would keep it for that page once
 * more, with the window of the page now shown (scrolled to its top), and Back to it would land there.
 * Once the move has finished, a replace keeps the place for the page it replaces.
 *
 * Without a render of its own: the page re-rendered as the move finishes would draw again what it has
 * just brought into view (src/lib/reveal.ts). Returns a function that stops waiting.
 */
export function whenArrived(router: Moving, then: () => void) {
  if (arrived(router)) {
    then()
    return () => {}
  }
  const stop = router.subscribe('onResolved', () => {
    if (!arrived(router)) return
    stop()
    then()
  })
  return stop
}

function arrived(router: Moving) {
  const at = router.latestLocation
  const loaded = router.stores.resolvedLocation.get()
  return (
    router.stores.status.get() === 'idle' &&
    loaded?.href === at.href &&
    loaded.state.__TSR_key === at.state.__TSR_key
  )
}

/** The choice this browser remembers, if it is one of `allowed`. Only after mount (see above). */
export function recall<T extends string>(key: string, allowed: readonly T[]): T | undefined {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(key)
  } catch {}
  return allowed.find((v) => v === saved)
}

/** Remembers a choice in this browser; storage can be unavailable, and then it is not remembered. */
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
