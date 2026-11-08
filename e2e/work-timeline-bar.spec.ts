import { expect, test } from './fixtures'
import { create, errorsOn, age, record } from './workTimeline'

/**
 * The chart's insides: the spans, waits and overlays drawn on a delegated build's bar.
 */

test('a delegated build reads as working: the builder’s span under the orchestrator’s wait on it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await create(human, project, { title: 'Delegated build', status: 'in_progress' })
  // The orchestrator hands the build to its builder and waits on it; the builder works the whole time.
  await record(agent, project, t.id, { kind: 'handoff', from: 'orchestrator', to: 'builder-sub-1' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'builder', agent: 'orchestrator' })
  age(t.id, 30)
  await record(agent, project, t.id, { kind: 'heartbeat', agent: 'builder-sub-1' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const bar = card.getByTestId('work-timeline')
  await expect(card.getByLabel('Totals')).toContainText('Working 30m · Waiting 0m · Blocked on human 0m')
  // The build is drawn as work, the wait on its own row, and nothing hatches the span.
  await expect(bar.getByRole('group', { name: 'Spans' }).locator('[data-kind="span"]')).toHaveText('build')
  await expect(bar.getByRole('group', { name: 'Waits' }).locator('[data-kind="wait"]')).toHaveAttribute(
    'data-reason',
    'builder',
  )
  await expect(bar.locator('[data-kind="human-overlay"]')).toHaveCount(0)
  await card.screenshot({ path: test.info().outputPath('delegated-build-timeline.png') })

  // A wait on the human still wins over the work under it, and is hatched over the span.
  const { waitId } = await record(agent, project, t.id, {
    kind: 'wait_start',
    reason: 'human',
    agent: 'orchestrator',
  })
  age(t.id, 10)
  await record(agent, project, t.id, { kind: 'wait_end', waitId, agent: 'orchestrator' })
  await page.reload()
  await expect(card.getByLabel('Totals')).toContainText('Working 30m · Waiting 0m · Blocked on human 10m')
  await expect(bar.getByRole('group', { name: 'Spans' }).locator('[data-kind="human-overlay"]')).toHaveCount(
    1,
  )
  expect(errors).toEqual([])
})
