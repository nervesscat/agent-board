import { useEffect, useState } from 'react'

import { afterDelay } from '#/lib/delayedFlag'

/**
 * True once `active` has stayed true for `ms` (150 by default); false at once when `active` ends. Use it
 * to show a loading state only for a load that is slow: a fast one never flashes a placeholder.
 */
export function useDelayedFlag(active: boolean, ms = 150): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) return
    const cancel = afterDelay(ms, () => setElapsed(true))
    return () => {
      cancel()
      setElapsed(false)
    }
  }, [active, ms])
  return active && elapsed
}
