import { expect, expectTooltip, ok, test, tooltip } from './fixtures'
import {
  age,
  create,
  errorsOn,
  quietTicket,
  record,
  reviewTicket,
  stalledTicket,
  workedTicket,
} from './workTimeline'

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

  // Silent for 40 minutes in progress: No word. Its totals and the project's show as text.
  const line = ticket.getByTestId('work-line').first()
  await expect(line).toHaveAttribute('data-state', 'no-word')
  await expect(line).toHaveAccessibleName(/No word \d+m/)
  await expect(ticket.getByTestId('work-summary').first()).toContainText(
    /Worked 40 min\s*·\s*Waited 20 min\s*·\s*On you 0/,
  )
  await expect(page.getByText('Project work, every ticket and lane:')).toBeVisible()
  await expect(page.getByText(/^1 no word$/)).toBeVisible()
  // The lane has no events but a fresh creation: it waits on nothing and is not No word.
  await expect(ticket.getByTestId('work-line').nth(1)).toHaveAccessibleName(/Working now · last word 0m/)
  await expect(ticket.getByRole('img', { name: /No word/ })).toHaveCount(1)
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
  await expectTooltip(line, /^nothing open since the build ended at /)

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
  const quiet = await quietTicket(human, agent, project)
  const turn = await reviewTicket(human, project)

  await page.goto(`/projects/${project.id}/roadmap`)
  const roadmap = page.getByTestId('roadmap')
  // Its lease ran out with the span still open: the row says the agent is gone, not that it is building.
  const lostRow = roadmap.getByRole('region', { name: `#${lost.t.id} Ship the importer` })
  const lostLine = lostRow.getByTestId('work-line').first()
  await expect(lostLine).toHaveAttribute('data-state', 'lost')
  await expect(lostLine).toHaveAccessibleName(/Lost contact/)
  // Its own row reads Lost contact, never Building (the lane under it has nothing open).
  await expect(lostRow).not.toContainText('Building')

  // The fresh one is building, with no lost contact.
  const liveRow = roadmap.getByRole('region', { name: `#${live.id} Live import` })
  const liveLine = liveRow.getByTestId('work-line').first()
  await expect(liveLine).toHaveAttribute('data-state', 'working')
  await expect(liveLine).toHaveAccessibleName(/Working now/)
  await expect(liveRow.locator('[data-state="lost"]')).toHaveCount(0)
  // A day-long silence reads Quiet, and a review ticket reads Your turn.
  const quietRow = roadmap.getByRole('region', { name: `#${quiet.t.id} Quiet importer` })
  await expect(quietRow.getByTestId('work-line').first()).toHaveAttribute('data-state', 'quiet')
  await expect(quietRow.getByTestId('work-line').first()).toHaveAccessibleName(/Quiet 1d/)
  const turnRow = roadmap.getByRole('region', { name: `#${turn.t.id} Waiting for a look` })
  await expect(turnRow.getByTestId('work-line').first()).toHaveAttribute('data-state', 'your-turn')
  await expect(turnRow.getByTestId('work-line').first()).toHaveAccessibleName(/Your turn · waiting 2d/)
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
  // The line's tooltip names the stage.
  await expectTooltip(ticket.getByTestId('work-line').first(), /in Bug Found, no agent heard from since /)
})
