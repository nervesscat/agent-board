import type { Page } from '@playwright/test'

import { expect, ok, section, test } from './fixtures'
import { record, scrollsSideways, stalledTicket } from './workTimeline'

/*
 * The Overview's Agents at work strip: one tiny pet per agent on a ticket, from the live work read.
 * Its pose and its words say working, waiting, asleep or done; each is a link to its ticket; it stays
 * small, fits a phone, reads in the dark and stands still under reduced motion.
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

test('a human wait shows the waiting pose and what it waits on, and a finished ticket leaves', async ({
  page,
  project,
  api,
  agent,
  human,
}) => {
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

  // Finished: it is not working any more, and waves from the done list instead.
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
  await page.reload()
  await expect(pets(page)).toHaveCount(1)
  await expect(pets(page).first()).toHaveAttribute('data-state', 'done')
  await expect(pets(page).first()).toContainText('Done today')
  await expect(card(page).locator('[data-state="working"]')).toHaveCount(0)
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

test('more than a dozen agents show twelve and a count', async ({ page, project, api, agent }) => {
  for (let i = 1; i <= 13; i++) {
    const t = await api.ticket({ title: `Busy ${i}`, status: 'in_progress' })
    await record(agent, project, t.id, { kind: 'heartbeat' })
  }
  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(12)
  await expect(card(page)).toContainText('+1 more')
})

test('the pets move, and stand still under reduced motion', async ({ page, project, api, agent }) => {
  const t = await api.ticket({ title: 'Typing away', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  const running = () => card(page).evaluate((el) => el.getAnimations({ subtree: true }).length)

  await page.goto(`/projects/${project.id}`)
  await expect(pets(page)).toHaveCount(1)
  await expect.poll(running).toBeGreaterThan(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(running).toBe(0)
  await expect(pets(page).first()).toHaveAttribute('data-state', 'working')
})

test('on a phone the strip stays inside the page', async ({ page, project, api, agent }) => {
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
  // The title is cut with an ellipsis, not run on.
  const title = first.locator('span.truncate').first()
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await card(page).screenshot({ path: test.info().outputPath('phone.png'), animations: 'disabled' })
})

test.describe('in the dark theme', () => {
  test.use({ colorScheme: 'dark' })

  test('the strip is drawn from the theme', async ({ page, project, api, agent }) => {
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
      .locator('svg rect[fill="var(--card)"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fill)
    const cardBg = await card(page).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(plate).toBe(cardBg)
    expect(images).toEqual([])
    await card(page).screenshot({ path: test.info().outputPath('dark.png'), animations: 'disabled' })
  })
})
