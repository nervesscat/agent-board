import { expect, expectTooltip, ok, test, tooltip } from './fixtures'
import { age, create, errorsOn, record, stalledTicket, workedTicket } from './workTimeline'

/**
 * The work timeline on the Roadmap: each ticket's bar, its totals and the stalled count.
 */

test('the Roadmap draws each ticket’s work timeline, its totals and a stalled warning', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const { t, lane } = await stalledTicket(human, agent, project)

  await page.goto(`/projects/${project.id}/roadmap`)
  const ticket = page.getByTestId('roadmap').getByRole('region', { name: `#${t.id} Ship the importer` })
  await expect(ticket).toBeVisible()
  const bar = ticket.getByTestId('work-timeline').first()
  // The build span, labelled by its phase; the wait on the lock, hatched and labelled; the hand-off.
  const span = bar.locator('[data-kind="span"][data-phase="build"]')
  await expect(span).toBeVisible()
  await expect(span).toHaveText('build')
  // Its work stopped: the span is closed, which is what lets the ticket read as Stalled.
  await expect(span).toHaveAttribute('data-open', 'false')
  const wait = bar.locator('[data-kind="wait"][data-reason="lock"]')
  await expect(wait).toBeVisible()
  await expect(wait).toHaveText('lock')
  expect(await wait.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    'repeating-linear-gradient',
  )
  await expect(bar.locator('[data-kind="handoff"]')).toHaveCount(1)

  // Silent for 40 minutes in progress: stalled. Its totals and the project's show as text.
  await expect(ticket.getByTestId('stall-notice').first()).toContainText('Stalled')
  await expect(ticket.getByTestId('work-summary').first()).toContainText(
    /Worked 40 min\s*·\s*Waited 20 min\s*·\s*On you 0/,
  )
  await expect(page.getByText('Project work, every ticket and lane:')).toBeVisible()
  await expect(page.getByText(/^1 stalled$/)).toBeVisible()
  // The lane has no events: it says so, and is not stalled.
  const laneRow = ticket.getByRole('group', { name: 'Work timeline' }).nth(1)
  await expect(laneRow).toContainText('No work recorded yet.')
  await expect(ticket.getByTestId('stall-notice')).toHaveCount(1)
  void lane

  // From the keyboard: Tab reaches the span, which has its story as its name and shows its tooltip.
  // It ran for 40 minutes and is closed now.
  const named = ticket.getByRole('button', { name: /^build by claude, .* to .*, 40 min$/ })
  await expect(named).toHaveCount(1)
  await ticket.getByRole('button', { name: '1 lane' }).focus()
  for (let i = 0; i < 6 && !(await named.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  await expect(named).toBeFocused()
  await expect(tooltip(page)).toBeVisible()
  await expect(tooltip(page)).toHaveText(/^build by claude, /)
  // The wait and the hand-off name themselves too, with a tooltip on hover.
  await expectTooltip(wait, /^wait: lock \(claude\), .*, 20 min: test lock$/)
  await expectTooltip(
    bar.locator('[data-kind="handoff"]'),
    /^orchestrator passed the work to builder-sub-1, /,
  )
  await expectTooltip(ticket.getByTestId('stall-notice'), /^nothing open since the build ended at /)

  await ticket.screenshot({ path: test.info().outputPath('roadmap-work-timeline.png') })
  expect(errors).toEqual([])
})

test('a lost run reads Lost contact on the Roadmap, and a working one does not', async ({
  page,
  project,
  human,
  agent,
}) => {
  const lost = await workedTicket(human, agent, project)
  // A run still going: its span is open and its lease is fresh.
  const live = await create(human, project, { title: 'Live import', status: 'in_progress' })
  await record(agent, project, live.id, { kind: 'span_start', phase: 'build' })

  await page.goto(`/projects/${project.id}/roadmap`)
  const roadmap = page.getByTestId('roadmap')
  // Its lease ran out with the span still open: the row says the agent is gone, not that it is building.
  const lostRow = roadmap.getByRole('region', { name: `#${lost.t.id} Ship the importer` })
  await expect(lostRow.getByTestId('lost-contact').first()).toBeVisible()
  await expect(lostRow.getByTestId('lost-contact').first()).toContainText('Lost contact')
  // Its own row reads Lost contact, never Building (the lane under it has nothing open).
  await expect(lostRow).not.toContainText('Building')

  // The fresh one is building, with no lost contact.
  const liveRow = roadmap.getByRole('region', { name: `#${live.id} Live import` })
  await expect(liveRow.getByTestId('now-line').first()).toBeVisible()
  await expect(liveRow.getByTestId('now-line').first()).toContainText('Building')
  await expect(liveRow.getByTestId('lost-contact')).toHaveCount(0)
})

test('changing the Roadmap time axis keeps a live track at now', async ({ page, project, human, agent }) => {
  await workedTicket(human, agent, project)
  await page.goto(`/projects/${project.id}/roadmap`)
  const scroller = page.getByTestId('work-timeline-scroll').first()
  await expect(scroller).toBeVisible()
  await page.getByRole('tab', { name: '7 d' }).click()
  // Now stays in view on the new axis: the track sits at its right end, where now is.
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
    .toBeLessThan(8)
})

test('a stalled ticket in another active stage names that stage in its why on the Roadmap', async ({
  page,
  project,
  human,
  agent,
}) => {
  await ok(human.post(`/api/projects/${project.id}/stages`, { data: { name: 'Bug Found', kind: 'active' } }))
  const stages = await ok<{ key: string; name: string }[]>(human.get(`/api/projects/${project.id}/stages`))
  const t = await create(human, project, {
    title: 'Crash on import',
    status: stages.find((s) => s.name === 'Bug Found')!.key,
  })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, t.id, { kind: 'span_end', phase: 'build' })
  age(t.id, 40)

  await page.goto(`/projects/${project.id}/roadmap`)
  const ticket = page.getByTestId('roadmap').getByRole('region', { name: `#${t.id} Crash on import` })
  // A badge: its why is in the tooltip.
  await expectTooltip(ticket.getByTestId('stall-notice').first(), /^in Bug Found, no agent heard from since /)
})
