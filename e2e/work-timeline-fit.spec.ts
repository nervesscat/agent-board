import type { Locator } from '@playwright/test'

import { expect, ok, test } from './fixtures'
import { age, create, errorsOn, record, scrollsSideways } from './workTimeline'

/**
 * The work timeline never scrolls sideways: the chart is drawn to the width of its card, on the ticket page
 * and on the Roadmap, whatever the length of the work or of the time spent blocked and in review.
 */

/** Where the chart overflows: a scroller of its own, content wider than it, or a part drawn outside it. */
const overflow = (chart: Locator) =>
  chart.evaluate((root) => {
    const box = root.getBoundingClientRect()
    const outside = [...root.querySelectorAll('[data-kind], [data-testid="agent-label"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1)
      })
      .map((el) => el.getAttribute('data-kind') ?? 'label')
    const scrollers = [root, ...root.querySelectorAll('*')].filter((el) =>
      ['auto', 'scroll'].includes(getComputedStyle(el).overflowX),
    ).length
    return {
      outside,
      scrollers,
      wider: root.scrollWidth > root.clientWidth,
      width: box.width,
      chips: [...root.querySelectorAll('[data-kind="blocked"], [data-kind="review"]')].map(
        (el) => el.getBoundingClientRect().width,
      ),
    }
  })

/** Whether an axis label touches another label, a break mark or the now label. */
const crowded = (chart: Locator) =>
  chart.evaluate((root) => {
    const marks = [
      ...root.querySelectorAll('span.tabular-nums:not([class*="pointer"]), [data-kind="axis-break"]'),
      ...[...root.querySelectorAll('span[aria-hidden]')].filter((el) => el.textContent === 'now'),
    ]
      .map((el) => el.getBoundingClientRect())
      .sort((a, b) => a.left - b.left)
    return marks.some((r, i) => i > 0 && r.left < marks[i - 1]!.right)
  })

/** Work, blocked for days, work again, then days in review: both kinds of block in the middle of the work. */
async function longTicket(
  human: Parameters<typeof create>[0],
  agent: Parameters<typeof record>[0],
  project: Parameters<typeof create>[1],
) {
  const t = await create(human, project, { title: 'A long ticket', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
  age(t.id, 90)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'builder' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'blocked' } }))
  age(t.id, 3 * 24 * 60)
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'in_progress' } }))
  await record(agent, project, t.id, { kind: 'span_start', phase: 'verify', agent: 'builder' })
  age(t.id, 40)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'builder' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'blocked' } }))
  age(t.id, 2 * 24 * 60)
  return t
}

const WIDTHS = [320, 390, 768, 1280]

test('a ticket with days blocked fits the card at any width, on the ticket page and the Roadmap', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await longTicket(human, agent, project)
  // A short ticket beside it: a few minutes of work, nothing collapsed.
  const short = await create(human, project, { title: 'A short ticket', status: 'in_progress' })
  await record(agent, project, short.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
  age(short.id, 6)
  await record(agent, project, short.id, { kind: 'span_end', agent: 'builder' })

  const chips: Record<number, number[]> = {}
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    for (const id of [t.id, short.id]) {
      await page.goto(`/projects/${project.id}/features/${id}`)
      const chart = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
      await expect(chart.locator('[data-kind="span"]').first()).toBeVisible()
      const o = await overflow(chart)
      expect(o, `ticket ${id} at ${width}px`).toMatchObject({ outside: [], scrollers: 0, wider: false })
      expect(await crowded(chart), `axis labels of ticket ${id} at ${width}px`).toBe(false)
      expect(await scrollsSideways(page), `page at ${width}px`).toBe(false)
      if (id === t.id) {
        expect(o.chips.length).toBe(2)
        chips[width] = o.chips
      }
    }
    await page.goto(`/projects/${project.id}/roadmap`)
    // The Roadmap's window: the week this ticket's work is in.
    await page.getByRole('tab', { name: '7 d' }).click()
    const row = page.getByRole('region', { name: `#${t.id} A long ticket` })
    const chart = row.getByTestId('work-timeline').first()
    await expect(chart.locator('[data-kind="span"]').first()).toBeVisible()
    expect(await overflow(chart), `Roadmap at ${width}px`).toMatchObject({
      outside: [],
      scrollers: 0,
      wider: false,
    })
    // (The Roadmap's own filter tabs are 1 px wider than a 320 px screen, whatever the chart does.)
    if (width > 320) expect(await scrollsSideways(page), `Roadmap page at ${width}px`).toBe(false)
  }
  // The blocks stay small and fixed: at most 72 px, and the same at every wide width.
  for (const width of WIDTHS) for (const w of chips[width]!) expect(w).toBeLessThanOrEqual(73)
  expect(chips[1280]).toEqual(chips[768])
  // A phone shrinks them rather than let them take the track.
  expect(chips[320]![0]!).toBeLessThan(chips[1280]![0]!)
  expect(errors).toEqual([])
})

test('the ticket page and the Roadmap have no horizontal scrollbar on a long live ticket', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Hours of work', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
  await record(agent, project, t.id, { kind: 'wait_start', reason: 'human', agent: 'builder' })
  age(t.id, 6 * 60)
  // A hand-off at the very end of the axis: its line and arrow stay inside the track too.
  await record(agent, project, t.id, { kind: 'handoff', from: 'builder', to: 'verifier' })
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const chart = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
    await expect(chart.locator('[data-kind="now"]').first()).toBeAttached()
    expect(await overflow(chart), `${width}px`).toMatchObject({ outside: [], scrollers: 0, wider: false })
    // The labels on the axis are few enough not to touch: no two of them overlap.
    const touching = await chart.evaluate((root) => {
      const labels = [...root.querySelectorAll('span.tabular-nums:not([class*="pointer"])')]
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => a.left - b.left)
      return labels.some((r, i) => i > 0 && r.left < labels[i - 1]!.right)
    })
    expect(touching, `axis labels at ${width}px`).toBe(false)
  }
})

test('a ticket that was only ever blocked shows a small fixed block, not a bar over the whole track', async ({
  page,
  project,
  human,
}) => {
  const t = await create(human, project, { title: 'Only blocked', status: 'blocked' })
  age(t.id, 3 * 24 * 60)
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const chart = page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')
    await expect(chart.locator('[data-kind="blocked"]')).toBeVisible()
    const o = await overflow(chart)
    expect(o, `${width}px`).toMatchObject({ outside: [], scrollers: 0, wider: false })
    expect(o.chips).toHaveLength(1)
    expect(o.chips[0]!).toBeLessThanOrEqual(73)
    expect(o.chips[0]!).toBeLessThan(o.width)
    // Now is where the block ends, not at the far end of the empty track.
    const [block, now] = await Promise.all([
      chart.locator('[data-kind="blocked"]').boundingBox(),
      chart.getByText('now', { exact: true }).boundingBox(),
    ])
    expect(Math.abs(block!.x + block!.width - (now!.x + now!.width)), `${width}px`).toBeLessThan(3)
  }
})
