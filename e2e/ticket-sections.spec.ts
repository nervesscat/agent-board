import type { Locator, Page } from '@playwright/test'

import type { PrRow, Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { expect, ok, test } from './fixtures'
import { addPosts, box, coveredAt, longTicket, openLong, scrollTo, ticketHeader } from './scrolling'

/**
 * The sections of a ticket (Summary, Tasks, Timeline, Lanes, Activity) share the row of the prev/next
 * step control, inside the ticket's stuck header: they stay in view while the page scrolls, each one
 * still jumps to its section, which lands below the header rather than behind it, and the selected one
 * follows the page as it is scrolled.
 */

const sections = (page: Page) => ticketHeader(page).getByRole('tablist', { name: 'Ticket sections' })
const sectionTab = (page: Page, name: string) => sections(page).getByRole('tab', { name, exact: true })
const selectedTab = (page: Page) => sections(page).locator('[role="tab"][aria-selected="true"]')
const headerBox = (page: Page) => box(ticketHeader(page))
const nextTicket = (page: Page) => ticketHeader(page).getByRole('link', { name: /^Next ticket in / })

/** How many lines the element's own text is drawn on: one per top its text nodes sit at. */
const textLines = (l: Locator) =>
  l.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
  })

/**
 * How far below the stuck header's bottom a section counts as the one being read: a tab's jump leaves
 * its section 1rem (16px) down, so the selector's line reaches a little further.
 */
const SPY_LINE = 24

/**
 * Scrolls the window so the section's top is `past` pixels past the stuck header's bottom edge (above
 * it when negative), the way a hand's scroll would.
 */
const scrollSection = (page: Page, id: string, past: number) =>
  page.evaluate(
    ({ id, past }) => {
      const header = document.querySelector('main header')!
      // --ticket-header is where the header's bottom sits once it sticks: the reference a section's
      // top has to cross. Without it, the header's place before sticking is used.
      const stuck = parseFloat(getComputedStyle(header.parentElement!).getPropertyValue('--ticket-header'))
      const bottom = Number.isFinite(stuck) ? stuck : header.getBoundingClientRect().bottom
      const section = document.getElementById(id)!
      window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - bottom + past)
    },
    { id, past },
  )

/**
 * The tab the page is at, read off the DOM: the last section whose top is at or above the header's
 * bottom (plus the landing room a jump leaves), and the last tab at the page's end. Null when the
 * strip has no tabs.
 */
const tabAtTheHeader = (page: Page) =>
  page.evaluate((line) => {
    const header = document.querySelector('main header')
    if (!header) return null
    const at = header.getBoundingClientRect().bottom + line
    const tabs = [...document.querySelectorAll<HTMLElement>('[aria-label="Ticket sections"] [role="tab"]')]
    const keys = tabs.map((tab) => (tab.textContent ?? '').trim().toLowerCase())
    if (keys.length === 0) return null
    let current = keys[0]!
    for (const key of keys) {
      const section = document.getElementById(key)
      if (section && section.getBoundingClientRect().top <= at) current = key
    }
    const document_ = document.documentElement
    if (
      document_.scrollHeight > window.innerHeight + 2 &&
      window.scrollY + window.innerHeight >= document_.scrollHeight - 2
    )
      current = keys[keys.length - 1]!
    return current
  }, SPY_LINE)

/** A stage name at the length a project takes it (40 characters), in capitals: the widest it gets. */
const LONG_STAGE = "WAITING FOR THE CLIENT'S FINAL APPROVAL"

/** A stage name at that same limit with nothing in it to break on: one unbreakable word. */
const UNBROKEN_STAGE = 'WAITING_FOR_CLIENT_APPROVAL_BEFORE_MERGE'

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
  // A short label stays on one line: wrapping only when it has to does not break the row at a desk.
  expect(await textLines(ticketHeader(page).getByText(/\d+ of \d+ in /))).toBe(1)
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
    'Lanes',
    'Activity',
  ])
  // With no Summary tab, the first section is the one the strip starts on, not none at all.
  await expect(selectedTab(page)).toHaveText('Tasks')

  const written = await longTicket(api, human, 'With a summary')
  await ok(agent.put(`/api/tickets/${written.id}/summary`, { data: { body: 'What it does.' } }))
  await openLong(page, `/projects/${written.projectId}/features/${written.id}`)
  expect(await sections(page).getByRole('tab').allInnerTexts()).toEqual([
    'Summary',
    'Tasks',
    'Timeline',
    'Lanes',
    'Activity',
  ])
  await expect(selectedTab(page)).toHaveText('Summary')

  await scrollTo(page, 'bottom')
  await sectionTab(page, 'Summary').click()
  await expect(sectionTab(page, 'Summary')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#summary'))
})

test('the strip and the page draw the sections in one order, Activity last', async ({ page, api, agent }) => {
  const t = await api.ticket({ title: 'Sections in the page order', status: 'in_progress' })
  await ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'What it does.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  const strip = sections(page).getByRole('tab')
  await expect(strip).toHaveCount(5)
  expect(await strip.allInnerTexts()).toEqual(['Summary', 'Tasks', 'Timeline', 'Lanes', 'Activity'])
  await expect(strip.last()).toHaveText('Activity')

  // The page draws them in that same order down the main column: Activity after Lanes, nowhere else.
  const ids = ['summary', 'tasks', 'timeline', 'lanes', 'activity']
  const ys: number[] = []
  for (const id of ids) ys.push((await box(page.locator(`#${id}`))).y)
  for (let i = 1; i < ys.length; i++)
    expect(ys[i]!, `#${ids[i]} is drawn below #${ids[i - 1]}`).toBeGreaterThan(ys[i - 1]!)
})

test('scrolling selects the section it brings under the header, and the page end the last one', async ({
  page,
  api,
  human,
}) => {
  const t = await longTicket(api, human, 'Sections that follow the scroll')
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  // No click: each section's top crossing the header's bottom picks its tab, one at a time.
  for (const name of ['Tasks', 'Timeline', 'Lanes', 'Activity']) {
    await scrollSection(page, name.toLowerCase(), 6)
    await expect(sectionTab(page, name)).toHaveAttribute('aria-selected', 'true')
    await expect(selectedTab(page)).toHaveText(name)
    await expect(selectedTab(page)).toHaveCount(1)
  }

  // The end of the page is its last section: Activity is selected there and is in view, so a scroll to
  // the end never leaves the strip on the section before it.
  await scrollTo(page, 'bottom')
  await expect(selectedTab(page)).toHaveText('Activity')
  await expect(page.locator('#activity')).toBeInViewport()
  const header = await headerBox(page)
  expect((await box(page.locator('#activity'))).y).toBeLessThanOrEqual(header.y + header.height)
})

test('the selected tab is the section at the header at every stop, down and back up', async ({
  page,
  api,
  human,
  agent,
}) => {
  const t = await longTicket(api, human, 'Sections that stay truthful while scrolled')
  await ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'What it does.' } }))
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)

  // Nothing has passed the header yet: the first tab, rather than none selected.
  await scrollTo(page, 0)
  await expect(selectedTab(page)).toHaveText('Summary')

  const stops = await page.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight
    return Array.from({ length: 8 }, (_, i) => Math.round((max * i) / 7))
  })
  for (const y of [...stops, ...[...stops].reverse().slice(1)]) {
    await scrollTo(page, y)
    const expected = await tabAtTheHeader(page)
    await expect
      .poll(async () => (await selectedTab(page).textContent())?.trim().toLowerCase(), {
        timeout: 2_000,
        message: `the tab of the section at the header, scrolled to ${y}px`,
      })
      .toBe(expected)
    await expect(selectedTab(page)).toHaveCount(1)
  }
})

test('a clicked tab stays selected once its smooth scroll settles', async ({ page, api, human, agent }) => {
  const t = await longTicket(api, human, 'Sections that do not fight a click')
  await ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'What it does.' } }))
  await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
  await expect(selectedTab(page)).toHaveText('Summary')

  await sectionTab(page, 'Lanes').click()
  await expect(sectionTab(page, 'Lanes')).toHaveAttribute('aria-selected', 'true')
  await expectLanded(page, page.locator('#lanes'))

  // Well after the scroll has passed Timeline on its way: the tab the human picked is still the one
  // shown, and its section still sits below the header.
  await page.waitForTimeout(1_500)
  await expect(selectedTab(page)).toHaveText('Lanes')
  await expectLanded(page, page.locator('#lanes'))
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

  test('a stage name at the character limit wraps in the steps instead of widening the page', async ({
    page,
    api,
    human,
    project,
  }) => {
    await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
    const t = await longTicket(api, human, 'Sections beside a long stage name')
    await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
    // As long as a stage name may be, in capitals: wide letters, with no room to spare in the row.
    const stage = project.stages.find((s) => s.kind === 'active')!
    await ok(human.patch(`/api/projects/${t.projectId}/stages/${stage.id}`, { data: { name: LONG_STAGE } }))

    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    const label = ticketHeader(page).getByText(/of \d+ in WAITING FOR THE CLIENT'S FINAL APPROVAL/)
    const tabs = sections(page)
    const next = nextTicket(page)
    await expect(label).toBeVisible()
    await expect(tabs).toBeVisible()
    await expect(next).toBeInViewport()

    // The row wraps its label rather than pushing the step control past the page's edge.
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(widths.scroll).toBe(widths.client)

    // Both stay in the header's step row, inside the page, with the selector still left of the steps.
    const header = await headerBox(page)
    const tabsBox = await box(tabs)
    const nextBox = await box(next)
    for (const b of [tabsBox, nextBox]) {
      expect(b.y).toBeGreaterThanOrEqual(header.y)
      expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 1)
      expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width)
    }
    expect(Math.abs(tabsBox.y - nextBox.y)).toBeLessThanOrEqual(8)
    expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(nextBox.x)
    // The label gives way, not the buttons: they keep a full tap target beside it.
    expect(nextBox.width).toBeGreaterThanOrEqual(24)
    expect(nextBox.height).toBeGreaterThanOrEqual(24)

    // The strip is still usable: it scrolls to a tab, which lands on its section.
    const tasks = sectionTab(page, 'Tasks')
    await tasks.scrollIntoViewIfNeeded()
    await tasks.click()
    await expect(tasks).toHaveAttribute('aria-selected', 'true')
    await expectLanded(page, page.locator('#tasks'))
  })

  test('a stage name with nothing to break on still leaves the sections usable', async ({
    page,
    api,
    human,
    project,
  }) => {
    await api.ticket({ title: 'An earlier ticket in the same stage', status: 'in_progress' })
    const t = await longTicket(api, human, 'Sections beside an unbroken stage name')
    await api.ticket({ title: 'A later ticket in the same stage', status: 'in_progress' })
    // Forty characters of capitals with no space in them: the step label cannot break, and the strip
    // beside it can shrink to nothing unless the label gives way inside the word.
    const stage = project.stages.find((s) => s.kind === 'active')!
    await ok(
      human.patch(`/api/projects/${t.projectId}/stages/${stage.id}`, { data: { name: UNBROKEN_STAGE } }),
    )

    await openLong(page, `/projects/${t.projectId}/features/${t.id}`)
    const label = ticketHeader(page).getByText(new RegExp(`of \\d+ in ${UNBROKEN_STAGE}`))
    const tabs = sections(page)
    const next = nextTicket(page)
    await expect(label).toBeVisible()
    await expect(tabs).toBeVisible()
    await expect(next).toBeInViewport()

    // The label takes more than one line: it wrapped inside the word rather than keeping its width.
    expect(await textLines(label)).toBeGreaterThan(1)

    // The strip keeps a real share of the row, and the steps still close the row on the right.
    const strip = await tabs.evaluate((list) => {
      let el: HTMLElement | null = list.parentElement
      while (el && getComputedStyle(el).overflowX !== 'auto') el = el.parentElement
      const r = el?.getBoundingClientRect()
      return { width: el?.clientWidth ?? 0, left: r?.left ?? 0, right: r?.right ?? 0 }
    })
    expect(strip.width).toBeGreaterThan(0)
    expect(strip.right).toBeLessThanOrEqual((await box(next)).x + 0.5)

    // Nothing widens the page, the buttons keep a full tap target, and the header stays short.
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(widths.scroll).toBe(widths.client)
    const nextBox = await box(next)
    expect(nextBox.width).toBeGreaterThanOrEqual(24)
    expect(nextBox.height).toBeGreaterThanOrEqual(24)
    expect((await headerBox(page)).height).toBeLessThan(page.viewportSize()!.height / 3)

    // And a tab, brought into the strip, is whole inside it and still jumps to its section.
    const tasks = sectionTab(page, 'Tasks')
    await tasks.scrollIntoViewIfNeeded()
    const taskBox = await box(tasks)
    expect(taskBox.x).toBeGreaterThanOrEqual(strip.left - 0.5)
    expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(strip.right + 0.5)
    await tasks.click()
    await expect(tasks).toHaveAttribute('aria-selected', 'true')
    await expectLanded(page, page.locator('#tasks'))
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
