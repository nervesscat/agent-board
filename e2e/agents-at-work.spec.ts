import type { Page } from '@playwright/test'

import { expect, ok, section, test } from './fixtures'
import { record, scrollsSideways, stalledTicket } from './workTimeline'

/*
 * The Overview's Agents at work card: one tiny pixel-art pet per agent on a ticket, from the live work
 * read. Its pose and its words say working, waiting or asleep; a ticket in Done, Approved or Cancelled
 * has none; each is a link to its ticket; a grid on a wide screen and a column on a phone; it reads in
 * the dark and stands still under reduced motion.
 */

const card = (page: Page) => section(page, 'Agents at work')
const pets = (page: Page) => card(page).getByTestId('agent-pet')

test('with nobody working it says so, with a sleeping pet', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}`)
  const empty = card(page).getByTestId('agents-empty')
  await expect(empty).toContainText('No agents working')
  await expect(empty.locator('svg[data-pet="asleep"]')).toBeVisible()
  await expect(pets(page)).toHaveCount(0)
})

test('an agent on a ticket shows as a typing pet that opens its ticket', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Ship the importer', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'review', round: 2 })
  await record(agent, project, t.id, {
    kind: 'span_start',
    phase: 'review',
    round: 2,
    agent: 'claude/helper',
  })
  await page.goto(`/projects/${project.id}`)

  const pet = card(page).getByRole('link', { name: /agent claude, Reviewing round 2/ })
  await expect(pet).toBeVisible()
  await expect(pet).toHaveAttribute('data-state', 'working')
  await expect(pet).toHaveAccessibleName(
    new RegExp(
      `^#${t.id} Ship the importer — agent claude, Reviewing round 2, last heard just now, working$`,
    ),
  )
  await expect(pet).toContainText(`#${t.id} Ship the importer`)
  // Its subagent follows it, smaller.
  const helper = card(page).getByRole('link', { name: /agent claude\/helper/ })
  await expect(helper).toBeVisible()
  const big = (await pet.locator('svg').boundingBox())!
  const little = (await helper.locator('svg').boundingBox())!
  expect(little.width).toBeLessThan(big.width)
  expect((await pet.boundingBox())!.x).toBeLessThan((await helper.boundingBox())!.x)
  // Small, and a tap target.
  expect((await pet.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  expect((await card(page).boundingBox())!.height).toBeLessThan(150)
  // Both are one character each, and the art is inline: nothing was fetched for it.
  await expect(pets(page)).toHaveCount(2)

  // The keyboard reaches it and opens the ticket.
  await pet.focus()
  await expect(pet).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}$`))
})

test('a human wait shows the waiting pose and what it waits on', async ({ page, project, api, agent }) => {
  const t = await api.ticket({ title: 'Pick a colour', status: 'in_progress' })
  const { waitId } = await record(agent, project, t.id, {
    kind: 'wait_start',
    reason: 'human',
    note: 'which blue?',
  })
  // The page's own clock runs on, so the 30-second refresh can be brought forward below.
  await page.clock.install()
  await page.goto(`/projects/${project.id}`)
  const pet = pets(page).first()
  await expect(pet).toHaveAttribute('data-state', 'waiting')
  await expect(pet).toContainText('Waiting: which blue?')
  await expect(pet.locator('svg[data-pet="waiting"]')).toBeVisible()

  // Answered: the strip's own refresh (every 30 seconds) shows it working again, with no reload.
  await record(agent, project, t.id, { kind: 'wait_end', waitId })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await page.clock.fastForward(31_000)
  await expect(pet).toHaveAttribute('data-state', 'working')
  await expect(pet).toContainText('Building')
})

for (const stage of ['done', 'approved', 'cancelled']) {
  test(`an agent on a ticket in ${stage} is not shown`, async ({ page, project, api, agent, human }) => {
    const shown = await api.ticket({ title: 'Still going', status: 'in_progress' })
    const gone = await api.ticket({ title: `Finished as ${stage}`, status: 'in_progress' })
    await record(agent, project, shown.id, { kind: 'span_start', phase: 'build' })
    await record(agent, project, gone.id, { kind: 'span_start', phase: 'build' })
    await page.goto(`/projects/${project.id}`)
    await expect(pets(page)).toHaveCount(2)

    // The agent's span is still open when the ticket moves: the stage decides, not the span.
    await ok(human.patch(`/api/tickets/${gone.id}`, { data: { status: stage } }))
    await page.reload()
    await expect(pets(page)).toHaveCount(1)
    await expect(pets(page).first()).toContainText(`#${shown.id}`)
    await expect(card(page)).not.toContainText(`#${gone.id}`)
    await expect(card(page)).not.toContainText('Done today')
  })
}

test('agents on tickets in other stages stay', async ({ page, project, api, agent, human }) => {
  const stages = ['blocked', 'review']
  for (const status of stages) {
    const t = await api.ticket({ title: `In ${status}`, status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
    await ok(human.patch(`/api/tickets/${t.id}`, { data: { status } }))
  }
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(stages.length)
})

test('a stalled ticket sleeps', async ({ page, project, human, agent }) => {
  const { t } = await stalledTicket(human, agent, project)
  await page.goto(`/projects/${project.id}`)
  const sleeper = pets(page)
    .filter({ hasText: `#${t.id}` })
    .first()
  await expect(sleeper).toHaveAttribute('data-state', 'asleep')
  await expect(sleeper).toHaveAccessibleName(/quiet/)
  await expect(sleeper.locator('svg[data-pet="asleep"]')).toBeVisible()
})

test('more than two dozen agents show twenty-four and a count', async ({ page, project, api, agent }) => {
  for (let i = 1; i <= 25; i++) {
    const t = await api.ticket({ title: `Busy ${i}`, status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'heartbeat' })
  }
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(24)
  await expect(card(page)).toContainText('+1 more')
})

test('the pets move frame by frame, and stand still under reduced motion', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Typing away', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  const running = () => card(page).evaluate((el) => el.getAnimations({ subtree: true }).length)

  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(1)
  await expect.poll(running).toBeGreaterThan(0)
  // Pixel art: crisp edges, no smoothing, two frames flipped in whole steps.
  const art = pets(page).first().locator('svg')
  await expect(art).toHaveAttribute('shape-rendering', 'crispEdges')
  expect(await art.locator('g').count()).toBe(2)
  const steps = await art
    .locator('g')
    .first()
    .evaluate((el) => getComputedStyle(el).animationTimingFunction)
  expect(steps).toMatch(/^steps\(1/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(running).toBe(0)
  // It holds its first frame: one frame shows, the other is hidden.
  const visible = await art.locator('g').evaluateAll((gs) => gs.map((g) => getComputedStyle(g).visibility))
  expect(visible).toEqual(['visible', 'hidden'])
  await expect(pets(page).first()).toHaveAttribute('data-state', 'working')
})

test('on a phone the pets stack one under another, each with its line beside it', async ({
  page,
  project,
  api,
  agent,
}) => {
  for (let i = 1; i <= 6; i++) {
    const t = await api.ticket({
      title: `A rather long title for ticket number ${i} that must be cut`,
      status: 'in_progress',
    })
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  }
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(6)
  expect(await scrollsSideways(page)).toBe(false)
  const box = (await card(page).boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  const first = pets(page).first()
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  // Vertical: each is under the one before, at the same left edge, and all inside the card.
  const boxes = await pets(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.x).toBe(boxes[0]!.x)
    expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.h - 1)
    expect(boxes[i]!.x + boxes[i]!.w).toBeLessThanOrEqual(375)
  }
  // The art is beside its ticket line, not above it.
  const art = (await first.locator('svg').boundingBox())!
  const line = (await first.locator('span.truncate').first().boundingBox())!
  expect(line.x).toBeGreaterThanOrEqual(art.x + art.width)
  expect(Math.abs(line.y + line.height / 2 - (art.y + art.height / 2))).toBeLessThan(art.height)
  // A long title is cut with an ellipsis and stays inside its row, not run on.
  const title = first.locator('span.truncate').first()
  await expect(title).toContainText('…')
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await card(page).screenshot({ path: test.info().outputPath('phone.png'), animations: 'disabled' })
})

/** The pets' boxes, in order, and the distinct rows (top edges) and columns (left edges) they sit on. */
async function layout(page: Page) {
  const boxes = await pets(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: Math.round(r.y), w: r.width, h: r.height }
    }),
  )
  const rows = [...new Set(boxes.map((b) => b.y))]
  const cols = [...new Set(boxes.map((b) => Math.round(b.x)))]
  return { boxes, rows, cols }
}

test('on a wide screen the pets are a grid: several per row, wrapping onto more rows', async ({
  page,
  project,
  api,
  agent,
}) => {
  for (let i = 1; i <= 9; i++) {
    const t = await api.ticket({ title: `Grid ${i} with a title that is rather long`, status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(9)
  const { boxes, rows, cols } = await layout(page)
  // Several columns, and more than one row: nine pets do not fit on one line, and they are not a column.
  expect(cols.length).toBeGreaterThanOrEqual(3)
  expect(rows.length).toBeGreaterThanOrEqual(2)
  expect(rows.length).toBeLessThan(9)
  // Every cell is aligned to a column and none is cut off by the card.
  const card1 = (await card(page).boundingBox())!
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(card1.x)
    expect(b.x + b.w).toBeLessThanOrEqual(card1.x + card1.width)
  }
  expect(await scrollsSideways(page)).toBe(false)
  // No horizontal scroll inside the card either.
  expect(await card(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The art is still beside its ticket line, and a long title is cut inside its cell.
  const first = pets(page).first()
  const title = first.locator('span.truncate').first()
  await expect(title).toContainText('…')
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await card(page).screenshot({ path: test.info().outputPath('wide.png'), animations: 'disabled' })
})

test('the grid takes as many columns as the card is wide, and none sideways', async ({
  page,
  project,
  api,
  agent,
}) => {
  for (let i = 1; i <= 8; i++) {
    const t = await api.ticket({ title: `Fit ${i}`, status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  }
  const columns: number[] = []
  for (const width of [1600, 1280, 700]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/projects/${project.id}`)
    await expect(pets(page)).toHaveCount(8)
    const { cols } = await layout(page)
    columns.push(cols.length)
    expect(await scrollsSideways(page)).toBe(false)
    expect(await card(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  // Wider means at least as many columns, and the narrowest desktop width still has more than one.
  expect(columns[0]!).toBeGreaterThanOrEqual(columns[1]!)
  expect(columns[1]!).toBeGreaterThanOrEqual(columns[2]!)
  expect(columns[2]!).toBeGreaterThanOrEqual(2)
  expect(columns[0]!).toBeGreaterThan(columns[2]!)
  await card(page).screenshot({ path: test.info().outputPath('narrow.png'), animations: 'disabled' })
})

test('in the grid a subagent sits right after its parent', async ({ page, project, api, agent }) => {
  const a = await api.ticket({ title: 'Parent ticket', status: 'in_progress' })
  await record(agent, project, a.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, a.id, { kind: 'span_start', phase: 'build', agent: 'claude/helper' })
  const b = await api.ticket({ title: 'Other ticket', status: 'in_progress' })
  await record(agent, project, b.id, { kind: 'span_start', phase: 'build' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(3)
  const names = await pets(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
  const parent = names.findIndex((n) => n.includes('Parent ticket') && !n.includes('claude/helper'))
  const child = names.findIndex((n) => n.includes('claude/helper'))
  expect(parent).toBeGreaterThanOrEqual(0)
  expect(child).toBe(parent + 1)
  const { boxes } = await layout(page)
  // Next to it: on the parent's row, in the next column.
  expect(boxes[child]!.y).toBe(boxes[parent]!.y)
  expect(boxes[child]!.x).toBeGreaterThan(boxes[parent]!.x)
})

test.describe('in the dark theme', () => {
  test.use({ colorScheme: 'dark' })

  test('the grid is drawn from the theme', async ({ page, project, api, agent }) => {
    const t = await api.ticket({ title: 'Night shift', status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'wait_start', reason: 'human', note: 'a question' })
    const s = await api.ticket({ title: 'Napping', status: 'in_progress' })
    await record(agent, project, s.id, { kind: 'heartbeat' })
    const images: string[] = []
    page.on('request', (r) => r.resourceType() === 'image' && images.push(r.url()))
    await page.goto(`/projects/${project.id}`)
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(pets(page)).toHaveCount(2)
    // The paint is the theme's variables: in the dark the face plate is the dark card, not a fixed white.
    const plate = await card(page)
      .locator('svg path[fill="var(--card)"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fill)
    const cardBg = await card(page).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(plate).toBe(cardBg)
    expect(images).toEqual([])
    await card(page).screenshot({ path: test.info().outputPath('dark.png'), animations: 'disabled' })
  })
})
