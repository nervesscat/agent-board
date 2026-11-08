import { expect, expectTooltip, test } from './fixtures'
import { as, create, errorsOn, record, scrollsSideways, workedTicket } from './workTimeline'

/**
 * The work timeline on the ticket page: the Timeline card, its events, and an event row on a phone.
 */

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
  await expect(items.nth(2)).toContainText('handoff orchestrator → builder-sub-1')
  await expect(items.nth(3)).toContainText('stopped waiting: lock')
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
