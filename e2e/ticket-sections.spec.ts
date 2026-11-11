import type { Locator, Page } from '@playwright/test'

import type { PrRow, Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { expect, ok, test } from './fixtures'
import { addPosts, box, coveredAt, longTicket, openLong, scrollTo, ticketHeader } from './scrolling'

/**
 * The sections of a ticket (Summary, Tasks, Timeline, Activity, Lanes) share the row of the prev/next
 * step control, inside the ticket's stuck header: they stay in view while the page scrolls, and each
 * one still jumps to its section, which lands below the header rather than behind it.
 */

const sections = (page: Page) => ticketHeader(page).getByRole('tablist', { name: 'Ticket sections' })
const sectionTab = (page: Page, name: string) => sections(page).getByRole('tab', { name, exact: true })
const headerBox = (page: Page) => box(ticketHeader(page))
const nextTicket = (page: Page) => ticketHeader(page).getByRole('link', { name: /^Next ticket in / })

/** Points over the target's top strip: what a jump brings just under the header. */
const coveredAtTop = (l: Locator, height = 24) =>
  l.evaluate((el, height) => {
    const r = el.getBoundingClientRect()
    const covered: string[] = []
    for (let i = 0; i <= 10; i++) {
      // 10px in from the edges: a rounded card does not take the clicks just inside its corners.
      const x = r.left + 10 + ((r.width - 20) * i) / 10
      for (const y of [r.top + 10, r.top + height - 6]) {
        const hit = document.elementFromPoint(x, Math.min(y, window.innerHeight - 2))
        if (!hit || !el.contains(hit))
          covered.push(`${Math.round(x)},${Math.round(y)}: ${hit?.outerHTML.slice(0, 80)}`)
      }
    }
    return covered
  }, height)

/** The target was jumped to: its top sits below the stuck header, with nothing drawn over it. */
async function expectLanded(page: Page, target: Locator) {
  await expect(target).toBeInViewport()
  await expect
    .poll(
      async () => {
        const top = await headerBox(page)
        const y = (await box(target)).y
        return y >= top.y + top.height - 1 && y <= top.y + top.height + 64
      },
      { timeout: 5_000, message: 'the section lands below the stuck header' },
    )
    .toBe(true)
  expect(await coveredAtTop(target)).toEqual([])
}

test('the section selector shares the header row with the stage steps, before them', async ({
  page,
  api,
  human,
}) => {
  await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
  const t = await longTicket(api, human, 'Sections beside the steps')
  await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  const tabs = sections(page)
  const next = nextTicket(page)
  await expect(tabs).toBeVisible()
  await expect(next).toHaveCount(1)

  // Both are drawn in the header, on one line: no viewport below the header, no second row.
  const header = await headerBox(page)
  const tabsBox = await box(tabs)
  const nextBox = await box(next)
  expect(tabsBox.y).toBeGreaterThanOrEqual(header.y)
  expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(header.y + header.height + 1)
  expect(nextBox.y).toBeGreaterThanOrEqual(header.y)
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(header.y + header.height + 1)
  expect(Math.abs(tabsBox.y - nextBox.y)).toBeLessThanOrEqual(8)
  // The selector is left of the steps, and the steps still close the row on the right.
  expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(nextBox.x)
  expect(nextBox.x + nextBox.width / 2).toBeGreaterThan(header.x + header.width / 2)
})

test('the selector stays in the stuck header at the bottom, and its tabs land below it', async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Sections in reach while scrolled')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  const tabs = sections(page)

  await scrollTo(page, 'bottom')
  await expect(tabs).toBeInViewport()
  const header = await headerBox(page)
  const tabsBox = await box(tabs)
  expect(tabsBox.y).toBeGreaterThanOrEqual(header.y)
  expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(header.y + header.height + 1)
  expect(await coveredAt(tabs, 6)).toEqual([])
  for (const tab of await tabs.getByRole('tab').all()) {
    await expect(tab).toBeVisible()
    await expect(tab).toBeEnabled()
  }

  // A tab still jumps to its section, below the stuck header, and becomes the selected one.
  await sectionTab(page, 'Tasks').click()
  await expect(sectionTab(page, 'Tasks')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#tasks'))

  await sectionTab(page, 'Timeline').click()
  await expect(sectionTab(page, 'Timeline')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#timeline'))
})

test('a lane page keeps the selector beside the lane steps and in view at the bottom', async ({
  page,
  api,
  human,
}) => {
  const parent = await longTicket(api, human, 'Parent of the lane being read')
  const lane = await ok<TicketFull>(
    human.post(`/api/projects/${parent.projectId}/tickets`, {
      data: { title: 'The lane with a long feed', parentId: parent.id },
    }),
  )
  await ok(
    human.post(`/api/projects/${parent.projectId}/tickets`, {
      data: { title: 'The lane after it', parentId: parent.id },
    }),
  )
  await addPosts(human, lane.id)
  await openLong(page, `/projects/${lane.projectId}/features/${lane.id}`)

  const tabs = sections(page)
  const next = ticketHeader(page).getByRole('link', { name: /^Next lane/ })
  await expect(tabs).toBeVisible()
  await expect(next).toHaveCount(1)
  // The lane step control, not the stage one, shares the row with the selector.
  await expect(page.getByText(/\d+ of \d+ in /)).toHaveCount(0)

  const tabsBox = await box(tabs)
  const nextBox = await box(next)
  expect(Math.abs(tabsBox.y - nextBox.y)).toBeLessThanOrEqual(8)

  await scrollTo(page, 'bottom')
  await expect(tabs).toBeInViewport()
  const header = await headerBox(page)
  const atBottom = await box(tabs)
  expect(atBottom.y).toBeGreaterThanOrEqual(header.y)
  expect(atBottom.y + atBottom.height).toBeLessThanOrEqual(header.y + header.height + 1)
  expect(await coveredAt(tabs, 6)).toEqual([])
})

test('Summary is offered only when the ticket has one, and lands on its card', async ({
  page,
  api,
  human,
  agent,
}) => {
  const plain = await longTicket(api, human, 'No summary yet')
  await openLong(page, `/projects/${plain.projectId}/features/${plain.id}`)
  expect(await sections(page).getByRole('tab').allInnerTexts()).toEqual([
    'Tasks',
    'Timeline',
    'Activity',
    'Lanes',
  ])

  const written = await longTicket(api, human, 'With a summary')
  await ok(agent.put(`/api/tickets/${written.id}/summary`, { data: { body: 'What it does.' } }))
  await openLong(page, `/projects/${written.projectId}/features/${written.id}`)
  expect(await sections(page).getByRole('tab').allInnerTexts()).toEqual([
    'Summary',
    'Tasks',
    'Timeline',
    'Activity',
    'Lanes',
  ])

  await scrollTo(page, 'bottom')
  await sectionTab(page, 'Summary').click()
  await expect(sectionTab(page, 'Summary')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#summary'))
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the selector scrolls within its row and still jumps to a section', async ({ page, api, human }) => {
    await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
    const t = await longTicket(api, human, 'Sections on a phone')
    await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

    await scrollTo(page, 'bottom')
    const lanes = sectionTab(page, 'Lanes')
    await lanes.scrollIntoViewIfNeeded()
    await lanes.click()
    await expect(lanes).toHaveAttribute('aria-selected', 'true')
    await expectLanded(page, page.locator('#lanes'))

    // The step control keeps its end of the row, and the strip does not widen the page.
    const next = nextTicket(page)
    await expect(next).toBeInViewport()
    expect(await coveredAt(next, 6)).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true)
    expect((await headerBox(page)).height).toBeLessThan(page.viewportSize()!.height / 3)
  })
})

// --- a ticket that draws no step controls ---

let prNumbers = 7000

/** An open PR row as a refresh from GitHub would leave it (the e2e repos have no GitHub slug). */
function seedPr(project: Project, title: string) {
  const number = ++prNumbers
  const now = new Date().toISOString()
  const id = inDatabase(
    (db) =>
      (
        db
          .prepare(
            `insert into prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha,
               waiting_on, review_stage, updated_at, fetched_at)
             values (?, ?, ?, ?, ?, 'someone', ?, 'main', 'abcdef1234567', 'me', 'pending', ?, ?) returning id`,
          )
          .get(
            project.id,
            project.repos[0]!.id,
            number,
            title,
            `https://github.com/example/repo/pull/${number}`,
            `branch-${number}`,
            now,
            now,
          ) as { id: number }
      ).id,
  )
  return { id, number }
}

test("a PR's ticket has the selector in its header, with no stage steps", async ({
  page,
  project,
  human,
}) => {
  const pr = seedPr(project, 'A PR with a ticket of its own')
  const rows = await ok<PrRow[]>(human.get(`/api/projects/${project.id}/prs?refresh=1`))
  const ticket = rows.find((r) => r.id === pr.id)!.ticket!
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)

  const tabs = sections(page)
  await expect(tabs).toBeVisible()
  await expect(page.getByText(/\d+ of \d+ in /)).toHaveCount(0)
  expect(await nextTicket(page).count()).toBe(0)

  await sectionTab(page, 'Tasks').click()
  await expect(sectionTab(page, 'Tasks')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#tasks'))
})
