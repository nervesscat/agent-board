import { useEffect, useMemo, useState } from 'react'

import { measureOffset } from './workStatus'

/** The time now, again every `ms`. */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * False in the server render and the first client render, true after mount. A value read from the clock
 * that is drawn before mount would differ between the two, so it waits for this.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}

/**
 * The offset of the server's clock from the browser's, for a server time the response carried (`now` of a
 * timeline, or of an activity): measured when that time arrived, so the browser's clock is corrected by it.
 * 0 when there is none.
 */
export function useServerOffset(serverNow: string | null | undefined): number {
  return useMemo(() => (serverNow ? measureOffset(serverNow, Date.now()) : 0), [serverNow])
}
