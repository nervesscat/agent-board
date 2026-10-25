import type { APIRequestContext, Page } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { HUMAN } from './env'
import { expect, expectTooltip, ok, section, test, tooltip } from './fixtures'

/**
 * The work timeline: what agents record on a ticket (spans, waits, hand-offs, heartbeats) drawn on the
 * Roadmap and the ticket page, the stalled warning it gives a silent ticket, and the threshold the
 * human sets for it.
 */

const create = (human: APIRequestContext, project: Project, data: Record<string, unknown>) =>
  ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { defaultPhases: false, ...data } }),
  )

const record = (
  agent: APIRequestContext,
  project: Project,
  ticketId: number,
  data: Record<string, unknown>,
) =>
  ok<{ spanId?: number; waitId?: number }>(
    agent.post(`/api/projects/${project.id}/tickets/${ticketId}/events`, { data }),
  )

/** Moves a ticket's whole past `minutes` back: its events, its creation and its start. */
function age(ticketId: number, minutes: number) {
  const shift = `-${minutes} minutes`
  inDatabase((db) => {
    db.prepare("update ticket_events set at = strftime('%Y-%m-%dT%H:%M:%fZ', at, ?) where ticket_id = ?").run(
      shift,
      ticketId,
    )
    db.prepare(
      'update tickets set "createdAt" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', "createdAt", ?), started_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', started_at, ?) where id = ?',
    ).run(shift, shift, ticketId)
  })
}

/**
 * A ticket in progress with a lane: a build span by the agent, a hand-off to a sub-agent, a 20-minute
 * wait on the test lock, and then 40 minutes of silence, so it reads as stalled. The lane has nothing.
 */
async function workedTicket(human: APIRequestContext, agent: APIRequestContext, project: Project) {
  const t = await create(human, project, { title: 'Ship the importer', status: 'in_progress' })
  const lane = await create(human, project, { title: 'Importer docs', status: 'in_progress', parentId: t.id })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, t.id, {
    kind: 'handoff',
    agent: 'orchestrator',
    from: 'orchestrator',
    to: 'builder-sub-1',
  })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'lock', note: 'test lock' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'wait_end' })
  age(t.id, 40)
  return { t, lane }
}

type Playwright = { request: { newContext: (o: object) => Promise<APIRequestContext> } }

/** REST as whoever `actor` names in test mode (orchestrator:<name>, agent:<name>), with any other headers. */
const as = (playwright: Playwright, baseURL: string | undefined, actor: string, headers = {}) =>
  playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Test-Actor': actor, ...headers } })

/** Whether the page itself scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

const errorsOn = (page: Page) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

test('the Roadmap draws each ticket’s work timeline, its totals and a stalled warning', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const { t, lane } = await workedTicket(human, agent, project)

  await page.goto(`/projects/${project.id}/roadmap`)
  const ticket = page.getByTestId('roadmap').getByRole('region', { name: `#${t.id} Ship the importer` })
  await expect(ticket).toBeVisible()
  const bar = ticket.getByTestId('work-timeline').first()
  // The build span, labelled by its phase; the wait on the lock, hatched and labelled; the hand-off.
  const span = bar.locator('[data-kind="span"][data-phase="build"]')
  await expect(span).toBeVisible()
  await expect(span).toHaveText('build')
  await expect(span).toHaveAttribute('data-open', 'true')
  const wait = bar.locator('[data-kind="wait"][data-reason="lock"]')
  await expect(wait).toBeVisible()
  await expect(wait).toHaveText('lock')
  expect(await wait.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    'repeating-linear-gradient',
  )
  await expect(bar.locator('[data-kind="handoff"]')).toHaveCount(1)

  // Silent for 40 minutes in progress: stalled. Its totals and the project's show as text.
  await expect(ticket.getByTestId('stalled').first()).toContainText('Stalled')
  await expect(ticket.getByLabel('Totals').first()).toContainText(
    /Working \d+m · Waiting 20m · Blocked on human 0m/,
  )
  await expect(page.getByText('Project work, every ticket and lane:')).toBeVisible()
  await expect(page.getByText(/^1 stalled$/)).toBeVisible()
  // The lane has no events: it says so, and is not stalled.
  const laneRow = ticket.getByRole('group', { name: 'Work timeline' }).nth(1)
  await expect(laneRow).toContainText('No work recorded yet.')
  await expect(ticket.getByTestId('stalled')).toHaveCount(1)
  void lane

  // From the keyboard: Tab reaches the span, which has its story as its name and shows its tooltip.
  // It started an hour back and is still open.
  const named = ticket.getByRole('button', { name: /^build by claude, .* to now, 1 h( \d+ min)?, open$/ })
  await expect(named).toHaveCount(1)
  await ticket.getByRole('button', { name: '1 lane' }).focus()
  for (let i = 0; i < 6 && !(await named.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  await expect(named).toBeFocused()
  await expect(tooltip(page)).toBeVisible()
  await expect(tooltip(page)).toHaveText(/^build by claude, /)
  // The wait and the hand-off name themselves too, with a tooltip on hover.
  await expectTooltip(wait, /^wait: lock \(claude\), .*, 20 min: test lock$/)
  await expectTooltip(bar.locator('[data-kind="handoff"]'), /^handoff orchestrator → builder-sub-1, /)
  await expectTooltip(ticket.getByTestId('stalled'), /^No heartbeat or event since .* \(claude\)$/)

  await ticket.screenshot({ path: test.info().outputPath('roadmap-work-timeline.png') })
  expect(errors).toEqual([])
})

test('the ticket page has a Timeline card with the bar, the totals and the events, heartbeats folded', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const { t } = await workedTicket(human, agent, project)
  for (let i = 0; i < 3; i++) await record(agent, project, t.id, { kind: 'heartbeat' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  await expect(card.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(
    card.getByTestId('work-timeline').locator('[data-kind="span"][data-phase="build"]'),
  ).toBeVisible()
  await expect(card.getByLabel('Totals')).toContainText('Waiting 20m')
  // A heartbeat just now: not stalled any more.
  await expect(card.getByTestId('stalled')).toHaveCount(0)

  const events = card.getByRole('list', { name: 'Events' })
  await expect(events).toContainText('handoff orchestrator → builder-sub-1')
  await expect(events).toContainText('started waiting: lock: test lock')
  await expect(events).toContainText('created in In progress')
  // Newest first; the heartbeats are one line until they are asked for.
  const items = events.getByRole('listitem')
  await expect(items.first()).toContainText(/^3 heartbeats, last /)
  await expect(items.filter({ hasText: /^\S+\s*claude\s*Agent\s*heartbeat$/ })).toHaveCount(0)
  await expect(items.nth(1)).toContainText('stopped waiting: lock')
  await card.getByRole('button', { name: 'Show heartbeats' }).click()
  await expect(items.filter({ hasText: /claude\s*Agent\s*heartbeat$/ })).toHaveCount(3)
  // Each event names its agent as everywhere else: with the role badge.
  await expect(items.first().locator('[data-role="worker"]').first()).toBeVisible()
  await expect(items.first()).toContainText('heartbeat')
  // The board's own events name the board, with its own badge: never the Human one.
  const created = items.filter({ hasText: 'created in In progress' })
  await expect(created).toHaveCount(1)
  const board = created.locator('[data-role="board"]').first()
  await expect(board).toContainText(/^board\s*Board$/)
  await expect(created.locator('[data-role="human"]')).toHaveCount(0)
  await expectTooltip(board, 'the board, recorded automatically')
  // A claimed name is followed by who recorded it, with that caller's badge.
  const handoff = items.filter({ hasText: 'handoff orchestrator → builder-sub-1' })
  await expect(handoff.getByTestId('event-by')).toContainText(/^by\s*claude\s*Agent$/)
  await expect(handoff.getByTestId('event-by').locator('[data-role="worker"]')).not.toHaveCount(0)
  // The claimed name is plain text: no badge and no tooltip of its own, since nobody signed in as it.
  const claimed = handoff.getByTestId('claimed-name')
  await expect(claimed).toHaveText('orchestrator')
  await expect(claimed).not.toHaveAttribute('data-slot', 'tooltip-trigger')
  await expect(handoff.locator('[data-role]:not([data-testid="event-by"] *)')).toHaveCount(0)
  // An event recorded under its caller's own name says nothing more.
  await expect(created.getByTestId('event-by')).toHaveCount(0)
  await expect(items.first().getByTestId('event-by')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Hide heartbeats' })).toHaveAttribute('aria-expanded', 'true')
  await card.screenshot({ path: test.info().outputPath('ticket-timeline-card.png') })

  // A ticket nothing was recorded on says so.
  const fresh = await create(human, project, { title: 'Nothing yet', status: 'todo' })
  await page.goto(`/projects/${project.id}/features/${fresh.id}`)
  const empty = page.getByRole('region', { name: 'Timeline' })
  await expect(empty).toContainText('No work recorded yet.')
  // Its creation is an event: the list has that one line.
  await expect(empty.getByRole('list', { name: 'Events' })).toContainText('created in To do')
  expect(errors).toEqual([])
})

test('a stalled ticket shows on its card, in the list and in Needs you, linking to it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await workedTicket(human, agent, project)
  const other = await create(human, project, { title: 'All quiet', status: 'in_progress' })
  await record(agent, project, other.id, { kind: 'heartbeat' })

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })
  await expect(card).toContainText('Stalled')
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('Stalled')
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })).toContainText(
    'Stalled',
  )
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('Stalled')

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const link = needsYou.getByRole('link', { name: `Stalled: #${t.id} Ship the importer` })
  await expect(link).toBeVisible()
  // `has` is matched inside each row, so it takes the link alone, not one scoped to the section.
  const row = needsYou
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Ship the importer` }) })
  await expect(row).toContainText(/silent 4\dm · last claude/)
  await expect(needsYou.getByRole('link', { name: /Stalled: .*All quiet/ })).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}$`))
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible()
})

test('a stalled row names who recorded the last event: a claimed name gets no badge of its own', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A worker's heartbeat that claims the human's name.
  const t = await create(human, project, { title: 'Claimed heartbeat', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'heartbeat', agent: HUMAN })
  age(t.id, 40)

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const row = needsYou
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Claimed heartbeat` }) })
  await expect(row).toContainText(new RegExp(`silent 4\\dm · last ${HUMAN}\\s*by\\s*claude\\s*Agent`))
  await expect(row.getByTestId('claimed-name')).toHaveText(HUMAN)
  await expect(row.locator('[data-role="human"]')).toHaveCount(0)
  await expect(row.getByTestId('event-by').locator('[data-role="worker"]')).not.toHaveCount(0)
  await expect(row.locator('[data-role]:not([data-testid="event-by"] *)')).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('an event row with a long claimed name and a long sub-identity fits 390px', async ({
    page,
    project,
    human,
    playwright,
    baseURL,
  }, info) => {
    const orchName = `orch-w${info.workerIndex}`
    const sub = `${orchName}/builder-with-a-long-sub-identity/importer-lane-one`
    const worker = await as(playwright, baseURL, `orchestrator:${orchName}`, { 'X-Agent-Name': sub })
    try {
      const t = await create(human, project, { title: 'Narrow timeline', status: 'in_progress' })
      await record(worker, project, t.id, {
        kind: 'span_start',
        phase: 'verification',
        agent: `${orchName}/verifier-for-the-importer-lane`,
        note: 'checking the importer against the sample files',
      })

      await page.goto(`/projects/${project.id}/features/${t.id}`)
      const events = page.getByRole('region', { name: 'Timeline' }).getByRole('list', { name: 'Events' })
      const row = events.getByRole('listitem').filter({ hasText: 'started verification' })
      await expect(row.getByTestId('event-by')).toContainText(sub)
      await expect(row.getByTestId('claimed-name')).toHaveText(`${orchName}/verifier-for-the-importer-lane`)
      expect(await scrollsSideways(page)).toBe(false)
      // Each part keeps a readable width, on a line of its own if it must: none is squeezed to a sliver.
      const sentence = row.getByText(/^started verification/)
      const recorder = row.getByTestId('event-by').locator('[data-role="worker"]').first()
      for (const part of [sentence, recorder, row.getByTestId('claimed-name')])
        expect((await part.boundingBox())!.width).toBeGreaterThan(150)
      // And none runs past the list's right edge, where a clipping card would hide it.
      const list = (await events.boundingBox())!
      for (const part of [sentence, recorder, row.getByTestId('claimed-name')]) {
        const box = (await part.boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(list.x + list.width + 1)
      }
      await row.screenshot({ path: test.info().outputPath('event-row-390.png') })
    } finally {
      await worker.dispose()
    }
  })
})

test('the human sets after how many minutes a ticket reads as stalled', async ({
  page,
  project,
  human,
  agent,
}) => {
  await page.goto(`/projects/${project.id}/settings`)
  const settings = page.getByRole('region', { name: 'Stalled tickets' })
  const minutes = settings.getByLabel('Stalled after (minutes)')
  await expect(minutes).toHaveValue('30')
  await minutes.fill('45')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Stalled tickets' }).getByLabel('Stalled after (minutes)'),
  ).toHaveValue('45')
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).stallMinutes).toBe(45)
  // An agent cannot change it.
  const refused = await agent.patch(`/api/projects/${project.id}`, { data: { stallMinutes: 5 } })
  expect(refused.status()).toBe(403)
})
