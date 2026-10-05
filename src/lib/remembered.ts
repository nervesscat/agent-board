import { useEffect } from 'react'

/**
 * A choice a page keeps in its URL (so the server renders it, a link shares it and a reload keeps
 * it) and that this browser remembers for the next visit without one. Storage is read only after
 * mount: read while rendering, the browser's first render would disagree with the server's (which has
 * no storage), and React keeps the server's attributes, so a tab would show one choice and the page
 * another. With none in the URL, `restore` gets the remembered one, if any, to put in the URL.
 */
export function useRestoreRemembered<T extends string>(
  key: string,
  current: T | undefined,
  allowed: readonly T[],
  restore: (value: T) => void,
) {
  useEffect(() => {
    if (current !== undefined) return
    let saved: string | null = null
    try {
      saved = localStorage.getItem(key)
    } catch {}
    const value = allowed.find((v) => v === saved)
    if (value !== undefined) restore(value)
    // Once per visit without a value in the URL: `allowed` is a constant and `restore` only navigates.
  }, [key, current])
}

/** Remembers a choice in this browser; storage can be unavailable, and then it is not remembered. */
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
