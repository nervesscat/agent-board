import { expect, expectTooltip, test, tooltip } from './fixtures'
import { errorsOn, workedTicket } from './workTimeline'

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
  // It started an hour back and is still open.
  const named = ticket.getByRole('button', { name: /^build by claude, .* to now, 4\d min, open$/ })
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
  await expectTooltip(
    ticket.getByTestId('stall-notice'),
    /^claude has a build open, nobody heard from since /,
  )

  await ticket.screenshot({ path: test.info().outputPath('roadmap-work-timeline.png') })
  expect(errors).toEqual([])
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
