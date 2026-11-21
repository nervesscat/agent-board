/**
 * Agents that wait for the human's answer on a decision card, held by the board while they wait. The
 * resume (resume.ts) asks `hasWaiter` before it starts a process: an answer an agent is waiting for is
 * handed to that agent, and the board does not start a second one.
 */

/** Whether an agent is waiting for the answer to this decision card of the ticket. */
export function hasWaiter(_ticketId: number, _postId: number): boolean {
  return false
}
