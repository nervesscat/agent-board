import { expect, test } from './fixtures'
import { age, create, errorsOn, record, scrollsSideways } from './workTimeline'

/**
 * The chart's insides: a row per agent, the key, the details popover, the live now line, and the phone layout.
 */

test('the chart has a row per agent, its work and waits on its own row, and the key under it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await create(human, project, { title: 'Rows of work', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'lock', agent: 'orchestrator' })
  age(t.id, 30)
  await record(agent, project, t.id, { kind: 'heartbeat', agent: 'builder-sub-1' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const bar = card.getByTestId('work-timeline')
  // One row per agent with a span or a wait, named by the agent.
  await expect(bar.getByText('builder-sub-1', { exact: true })).toBeVisible()
  await expect(bar.getByText('orchestrator', { exact: true })).toBeVisible()
  const build = bar.locator('[data-kind="span"][data-phase="build"]')
  const lock = bar.locator('[data-kind="wait"][data-reason="lock"]')
  await expect(build).toHaveText('build')
  await expect(lock).toHaveText('lock')
  // The span and the wait are on different rows: they are not siblings in one track.
  expect(
    await build.evaluate((el, other) => el.parentElement === other.parentElement, await lock.elementHandle()),
  ).toBe(false)
  await card.screenshot({ path: test.info().outputPath('work-timeline-rows.png') })
  expect(errors).toEqual([])
})

test('a delegated build: the builder on its own row, the orchestrator’s wait drawn as a connector, no second bar', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await create(human, project, { title: 'Delegated build', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'handoff', from: 'orchestrator', to: 'builder-sub-1' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
  // The delegation needs the server to keep a wait's `on`. Until it does, this test skips.
  const waited = await agent.post(`/api/projects/${project.id}/tickets/${t.id}/events`, {
    data: { kind: 'wait_start', reason: 'builder', agent: 'orchestrator', on: 'builder-sub-1' },
  })
  const read = (await (await human.get(`/api/tickets/${t.id}/events`)).json()) as {
    timeline: { waits: { on?: string }[] }
  }
  test.skip(
    !waited.ok() || read.timeline.waits[0]?.on !== 'builder-sub-1',
    'needs the server to keep a wait’s `on`',
  )
  age(t.id, 30)
  await record(agent, project, t.id, { kind: 'heartbeat', agent: 'builder-sub-1' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const bar = card.getByTestId('work-timeline')
  await expect(card.getByLabel('Totals')).toContainText('Working 30m · Waiting 0m · Blocked on human 0m')
  const span = bar.locator('[data-kind="span"][data-phase="build"]')
  await expect(span).toHaveText('build')
  // The delegation is a connector on the orchestrator’s row, not a second bar over the builder’s.
  const delegation = bar.locator('[data-kind="delegation"][data-on="builder-sub-1"]')
  await expect(delegation).toHaveCount(1)
  await expect(delegation).toContainText('delegated to builder-sub-1')
  await expect(bar.locator('[data-kind="wait"]')).toHaveCount(0)
  expect(
    await span.evaluate(
      (el, other) => el.parentElement === other.parentElement,
      await delegation.elementHandle(),
    ),
  ).toBe(false)
  await expect(bar.locator('[data-kind="human-overlay"]')).toHaveCount(0)
  await card.screenshot({ path: test.info().outputPath('delegated-build-timeline.png') })
  expect(errors).toEqual([])
})

test('a human wait is amber and filled on the waiting agent’s row, not hatched over the work', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Waiting on a person', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
  const { waitId } = await record(agent, project, t.id, {
    kind: 'wait_start',
    reason: 'human',
    agent: 'orchestrator',
  })
  age(t.id, 10)
  await record(agent, project, t.id, { kind: 'wait_end', waitId, agent: 'orchestrator' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const bar = card.getByTestId('work-timeline')
  await expect(card.getByLabel('Totals')).toContainText('Blocked on human 10m')
  const humanWait = bar.locator('[data-kind="wait"][data-reason="human"]')
  await expect(humanWait).toHaveText('human')
  await expect(humanWait).toHaveClass(/bg-amber-500/)
  expect(await humanWait.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none')
  await expect(bar.locator('[data-kind="human-overlay"]')).toHaveCount(0)
})

test('a segment opens its details in a popover by click, and by Enter from the keyboard', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Details on demand', status: 'in_progress' })
  await record(agent, project, t.id, {
    kind: 'span_start',
    phase: 'review',
    round: 2,
    agent: 'reviewer-sub-1',
  })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'reviewer-sub-1' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const bar = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
  const span = bar.locator('[data-kind="span"][data-phase="review"]')
  await expect(span).toHaveText('review r2')
  await span.click()
  const details = page.getByRole('dialog')
  await expect(details).toBeVisible()
  await expect(details).toContainText('reviewer-sub-1')
  await expect(details).toContainText('via')
  await expect(details).toContainText('review round 2')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)

  // From the keyboard: the segment takes focus, and Enter opens the same details.
  await span.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Duration')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a live ticket draws its open segment growing to a now line at the right edge', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Still going', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
  age(t.id, 15)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const bar = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
  await expect(bar).toHaveAttribute('data-live', 'true')
  const span = bar.locator('[data-kind="span"][data-phase="build"]')
  await expect(span).toHaveAttribute('data-open', 'true')
  const now = bar.locator('[data-kind="now"]').first()
  await expect(now).toBeAttached()
  // The open span runs to the now line, the line at the track’s right edge.
  const spanBox = (await span.boundingBox())!
  const nowBox = (await now.boundingBox())!
  expect(Math.abs(spanBox.x + spanBox.width - nowBox.x)).toBeLessThan(4)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the labels sit above their rows, the track scrolls sideways, and now is in view', async ({
    page,
    project,
    human,
    agent,
  }) => {
    const t = await create(human, project, { title: 'A long ticket', status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder-sub-1' })
    age(t.id, 200)

    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const bar = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
    await expect(bar.locator('[data-kind="span"]')).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    // All the geometry is read in one go, so the page cannot scroll between the boxes.
    const geometry = await bar.evaluate((root) => {
      const box = (el: Element | null) => {
        const r = el!.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      const scroller = root.querySelector('[data-testid="work-timeline-scroll"]')!
      const label = [...root.querySelectorAll('span.truncate')].find(
        (el) => el.textContent === 'builder-sub-1',
      )
      return {
        scroller: { ...box(scroller), scrollable: scroller.scrollWidth > scroller.clientWidth },
        now: box(root.querySelector('[data-kind="now"]')),
        label: box(label ?? null),
        span: box(root.querySelector('[data-kind="span"]')),
      }
    })
    // The track is wider than the phone, so it scrolls, and it opened on now at its right end.
    expect(geometry.scroller.scrollable).toBe(true)
    expect(geometry.now.x).toBeGreaterThanOrEqual(geometry.scroller.x - 1)
    expect(geometry.now.right).toBeLessThanOrEqual(geometry.scroller.right + 1)
    // The row's label sits above its track, and the segment is inside the scroller, with height.
    expect(geometry.label.bottom).toBeLessThanOrEqual(geometry.span.y + 1)
    expect(geometry.span.y).toBeGreaterThanOrEqual(geometry.scroller.y)
    expect(geometry.span.bottom).toBeLessThanOrEqual(geometry.scroller.bottom + 1)
    await bar.screenshot({ path: test.info().outputPath('work-timeline-390.png') })
  })
})
