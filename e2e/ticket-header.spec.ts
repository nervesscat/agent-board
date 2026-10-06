import type { APIRequestContext, Locator, Page } from '@playwright/test'

import { startedAt, yesterdayNoon } from './db'
import { type Api, expect, ok, section, test } from './fixtures'

const POSTS = 20

/** A ticket with a feed several screens long, so the page scrolls well past its header. */
async function longTicket(api: Api, human: APIRequestContext, title: string, status = 'in_progress') {
  const t = await api.ticket({
    title,
    status,
    body: Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of the instructions.`).join('\n\n'),
  })
  for (let i = 1; i <= POSTS; i++) {
    const body = `Post ${i}.\n\n${'Some progress on the work, said at some length. '.repeat(6)}\n\nMore.`
    await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body } }))
  }
  return t
}

/** Waits for the feed to be drawn: its posts all come in one read. */
const feedDrawn = (page: Page) =>
  expect(page.getByRole('article').filter({ hasText: 'Post 1.' })).toHaveCount(1)

/** The ticket page, with the whole feed drawn and the page several screens long. */
async function openLong(page: Page, path: string) {
  await page.goto(path)
  await feedDrawn(page)
  const { height, screen } = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    screen: window.innerHeight,
  }))
  expect(height).toBeGreaterThan(3 * screen)
}

const ticketHeader = (page: Page) => page.getByRole('main').locator('header')
const title = (page: Page) => page.getByRole('heading', { level: 1 })

async function box(l: Locator) {
  const b = await l.boundingBox()
  expect(b, 'drawn on the page').not.toBeNull()
  return b!
}

const scrollTo = (page: Page, y: number | 'bottom') =>
  page.evaluate((y) => {
    window.scrollTo(0, y === 'bottom' ? document.documentElement.scrollHeight : y)
    return window.scrollY
  }, y)

/**
 * Points spread over the element's box that hit something other than the element or what is in it:
 * whatever is drawn over it there. Empty when the element is on top all over.
 */
const coveredAt = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const covered: string[] = []
    for (let i = 0; i <= 10; i++)
      for (let j = 0; j <= 4; j++) {
        const x = r.left + 1 + ((r.width - 2) * i) / 10
        const y = r.top + 1 + ((r.height - 2) * j) / 4
        const hit = document.elementFromPoint(x, y)
        if (!hit || !el.contains(hit))
          covered.push(`${Math.round(x)},${Math.round(y)}: ${hit?.outerHTML.slice(0, 80)}`)
      }
    return covered
  })

/** Whether the page's own content (the feed, the side cards) is right under the header's middle. */
const contentUnder = (header: Locator) =>
  header.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const body = el.nextElementSibling!
    return document
      .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .some((hit) => hit !== body && body.contains(hit))
  })

/** The header's background and the page's own (opaque): the header must match it, not show through. */
const backgrounds = (header: Locator) =>
  header.evaluate((el) => ({
    header: getComputedStyle(el).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor,
  }))

/** Asserts the ticket's title is in view, under the top bar, and drawn over whatever scrolls under it. */
async function expectStuck(page: Page) {
  const banner = await box(page.getByRole('banner'))
  const header = await box(ticketHeader(page))
  await expect(title(page)).toBeInViewport()
  expect(Math.abs(header.y - (banner.y + banner.height))).toBeLessThanOrEqual(1)
  expect((await box(title(page))).y).toBeGreaterThanOrEqual(banner.y + banner.height)
  expect(await contentUnder(ticketHeader(page))).toBe(true)
  expect(await coveredAt(ticketHeader(page))).toEqual([])
  // Below the header the page is the page's again: the header takes no clicks it does not show.
  const below = await ticketHeader(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom + 4)
    return !!hit && !el.contains(hit)
  })
  expect(below).toBe(true)
}

test('the ticket header sticks under the top bar once scrolled to it, over the feed', async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Keep the title in view')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  // At rest it is where it always was: under the breadcrumb, and the page's only heading.
  await expect(title(page)).toHaveCount(1)
  await expect(title(page)).toContainText(`#${t.id} Keep the title in view`)
  const breadcrumb = await box(page.getByRole('main').locator('section nav').first())
  const rest = await box(title(page))
  expect(rest.y).toBeGreaterThanOrEqual(breadcrumb.y + breadcrumb.height)

  // It goes up with the page until it reaches the top bar.
  const banner = await box(page.getByRole('banner'))
  expect(rest.y - 10).toBeGreaterThan(banner.y + banner.height)
  expect(await scrollTo(page, 10)).toBe(10)
  expect(Math.abs((await box(title(page))).y - (rest.y - 10))).toBeLessThanOrEqual(1)

  // From there on it stays, halfway down the feed and at the very end.
  const end = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
  expect(await scrollTo(page, Math.round(end / 2))).toBeGreaterThan(rest.y)
  await expectStuck(page)
  expect(await scrollTo(page, 'bottom')).toBe(end)
  await expectStuck(page)
})

test('the stuck header has the page background, light and dark', async ({ page, api, human }) => {
  const t = await longTicket(api, human, 'Readable in both themes')
  const seen: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await scrollTo(page, 'bottom')
    await expectStuck(page)
    const bg = await backgrounds(ticketHeader(page))
    expect(bg.header, colorScheme).toBe(bg.page)
    seen.push(bg.header)
  }
  expect(seen[0]).not.toBe(seen[1])
})

test('renames the ticket from the stuck title, and the status changes from the stuck header', async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await longTicket(api, human, 'Name it later')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  const end = await scrollTo(page, 'bottom')

  await page.getByRole('button', { name: 'Name it later' }).click()
  const field = page.getByRole('textbox', { name: 'Title' })
  await expect(field).toBeFocused()
  await expect(field).toBeInViewport()
  await field.fill('Named while stuck')
  await field.press('Enter')
  await expect(title(page)).toContainText('Named while stuck')
  await expect.poll(async () => (await api.getTicket(t.id)).title).toBe('Named while stuck')

  // Esc leaves it as it was.
  await page.getByRole('button', { name: 'Named while stuck' }).click()
  await field.fill('Not this one')
  await field.press('Escape')
  await expect(field).toBeHidden()
  await expect(title(page)).toContainText('Named while stuck')
  expect(await page.evaluate(() => window.scrollY)).toBe(end)
  await expectStuck(page)

  const blocked = project.stages.find((s) => s.kind === 'blocked')!
  await ticketHeader(page).getByRole('combobox').click()
  const option = page.getByRole('option', { name: blocked.name })
  await expect(option).toBeInViewport()
  await option.click()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe(blocked.key)
  expect(await page.evaluate(() => window.scrollY)).toBe(end)
})

/** Asserts "Resume here" was scrolled to, and shows below the stuck header rather than under it. */
async function expectResumeInView(page: Page) {
  const heading = page
    .getByRole('region', { name: 'Resume here' })
    .getByRole('heading', { name: 'Resume here' })
  await expect(heading).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  const header = await box(ticketHeader(page))
  expect((await box(heading)).y).toBeGreaterThanOrEqual(header.y + header.height)
  expect(await coveredAt(heading)).toEqual([])
}

test('a link to #resume shows the resume note below the stuck header', async ({
  page,
  api,
  human,
  agent,
}) => {
  const t = await longTicket(api, human, 'Pick it up tomorrow')
  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: '**State:** halfway there' } }))
  await openLong(page, `/projects/${t.projectId}/features/${t.id}#resume`)
  await expectResumeInView(page)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a long title wraps and stays in view, and the page does not scroll sideways', async ({
    page,
    api,
    human,
  }) => {
    const t = await longTicket(
      api,
      human,
      'A ticket with a long title that has to wrap on a phone instead of widening the page',
    )
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    await scrollTo(page, 'bottom')
    await expectStuck(page)
    // It keeps most of the screen for the page.
    expect((await box(ticketHeader(page))).height).toBeLessThan(page.viewportSize()!.height / 3)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
  })

  test('the Overview resume link shows the note below the stuck header', async ({
    page,
    api,
    human,
    agent,
    project,
  }) => {
    const t = await longTicket(api, human, 'Carried over with a long feed')
    startedAt(t.id, yesterdayNoon())
    await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Halfway through the parser' } }))

    await page.goto(`/projects/${project.id}`)
    await section(page, 'Carrying over').getByTitle('Its resume note: open it on the ticket').click()
    await expect(page).toHaveURL(new RegExp(`/features/${t.id}#resume$`))
    await feedDrawn(page)
    await expectResumeInView(page)
  })
})
