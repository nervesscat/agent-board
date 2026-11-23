/**
 * Runs `fire` once `ms` have passed, unless the returned function is called first. The timing of
 * `useDelayedFlag`, kept apart from React so it can be tested with fake timers.
 */
export function afterDelay(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/** Whether what is on screen is not the ticket asked for: nothing yet, or another ticket's data. */
export const isOtherTicket = (shown: { id: number } | undefined, ticketId: string) =>
  shown === undefined || String(shown.id) !== ticketId
