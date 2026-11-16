import { useSyncExternalStore } from 'react'

/** Subscribing to nothing: the value never changes, only what the first render sees differs. */
const noSubscribe = () => () => {}

/**
 * False on the server and in the first render in the browser, true after mount. The queries a component
 * reads start in the first client render and can answer before React has hydrated the page: markup drawn
 * from that data then would not match the HTML the server sent (which had none), and React reports a
 * hydration mismatch. So a first render that depends on a query's data waits for this.
 */
export function useHydrated() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}
