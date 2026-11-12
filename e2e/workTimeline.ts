import type { APIRequestContext, Page } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { ok } from './fixtures'

/** Shared by the work timeline specs (work-timeline-*.spec.ts): recording events, aging a ticket, and page helpers. */

export const create = (human: APIRequestContext, project: Project, data: Record<string, unknown>) =>
  ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { defaultPhases: false, ...data } }),
  )

export const record = (
  agent: APIRequestContext,
  project: Project,
  ticketId: number,
  data: Record<string, unknown>,
) =>
  ok<{ spanId?: number; waitId?: number }>(
    agent.post(`/api/projects/${project.id}/tickets/${ticketId}/events`, { data }),
  )

/** Moves a ticket's whole past `minutes` back: its events, its creation, its start and its posts. */
export function age(ticketId: number, minutes: number) {
  const shift = `-${minutes} minutes`
  inDatabase((db) => {
    db.prepare("update ticket_events set at = strftime('%Y-%m-%dT%H:%M:%fZ', at, ?) where ticket_id = ?").run(
      shift,
      ticketId,
    )
    db.prepare(
      'update tickets set "createdAt" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', "createdAt", ?), started_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', started_at, ?) where id = ?',
    ).run(shift, shift, ticketId)
    // A post is a lease signal: ageing it is how a fixture says the agent has not spoken for a while.
    db.prepare(
      "update updates set createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', createdAt, ?) where ticket_id = ?",
    ).run(shift, ticketId)
  })
}

/**
 * A ticket in progress with a lane: a 20-minute wait on the test lock with nothing else going on, then
 * a hand-off to a sub-agent and a build span by the agent, and 40 minutes of silence after the span
 * started. The span is still open, so its lease has expired and it reads as Lost contact, not Stalled.
 * The lane has nothing.
 */
export async function workedTicket(human: APIRequestContext, agent: APIRequestContext, project: Project) {
  const t = await create(human, project, { title: 'Ship the importer', status: 'in_progress' })
  const lane = await create(human, project, { title: 'Importer docs', status: 'in_progress', parentId: t.id })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'lock', note: 'test lock' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'wait_end' })
  await record(agent, project, t.id, {
    kind: 'handoff',
    agent: 'orchestrator',
    from: 'orchestrator',
    to: 'builder-sub-1',
  })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  age(t.id, 40)
  return { t, lane }
}

/** A ticket in progress with a lane, worked and then silent: the same shape as `workedTicket`, with its
 * build span closed. A 20-minute wait on the test lock, a hand-off, a 40-minute build that ended 40
 * minutes ago and nothing since: nothing open, so it reads as Stalled, not Lost contact. */
export async function stalledTicket(human: APIRequestContext, agent: APIRequestContext, project: Project) {
  const t = await create(human, project, { title: 'Ship the importer', status: 'in_progress' })
  const lane = await create(human, project, { title: 'Importer docs', status: 'in_progress', parentId: t.id })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'lock', note: 'test lock' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'wait_end' })
  await record(agent, project, t.id, {
    kind: 'handoff',
    agent: 'orchestrator',
    from: 'orchestrator',
    to: 'builder-sub-1',
  })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  age(t.id, 40)
  await record(agent, project, t.id, { kind: 'span_end' })
  age(t.id, 40)
  return { t, lane }
}

export type Playwright = {
  request: { newContext: (o: object) => Promise<APIRequestContext> }
}

/** REST as whoever `actor` names in test mode (orchestrator:<name>, agent:<name>), with any other headers. */
export const as = (playwright: Playwright, baseURL: string | undefined, actor: string, headers = {}) =>
  playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Test-Actor': actor, ...headers } })

/** Whether the page itself scrolls sideways. */
export const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

export const errorsOn = (page: Page) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
