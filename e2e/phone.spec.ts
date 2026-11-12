import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Page } from '@playwright/test'

import type { TicketFull } from '#/lib/api'
import { named, pushedPill, reminder, seedDailyPage, today, yesterday } from './dailyPage'
import { expect, ok, seededProject, test } from './fixtures'

// A daily report left missing shows its reminder on every later test's pages once its shift has ended,
// so each test here turns its project's reports off when it is done (as `quiet()` does in dailyPage.ts).
test.afterEach(async ({ human, project }) => {
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'off' } }))
})

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

/** Whether the page itself scrolls sideways (a board's own column scroller does not count). */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

type Box = { x: number; y: number; width: number; height: number }

/** Whether two boxes on the page share any pixels. */
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('no sideways scroll at 390px on Home, Repositories, the PR queue, the board and a ticket', async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await api.ticket({
    title: 'A ticket with a long title that has to wrap on a phone instead of widening the page',
    body: 'Instructions with a `long_inline_code_identifier_that_does_not_break_easily` and a link to https://example.com/a/very/long/path/that/goes/on/and/on',
    tags: ['High', 'Forms', 'Cosmetic'],
    status: 'in_progress',
  })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post with some progress.' } }))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/repositories`)
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/features`)
  await expect(page.locator('[data-column="in_progress"]').getByRole('link')).toHaveCount(1)
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('A post with some progress.')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
})

test("a ticket's feed tabs, a long summary with its history open and long lane chips fit 390px", async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Feed on a phone', status: 'in_progress' })
  const lane = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: {
        title: 'A lane whose title goes on and on so its chip has to be cut rather than widen the page',
        parentId: t.id,
      },
    }),
  )
  const long =
    'A summary with a `long_inline_code_identifier_that_does_not_break_easily` and https://example.com/a/very/long/path/that/goes/on/and/on'
  await ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: long } }))
  await ok(
    agent.put(`/api/tickets/${t.id}/summary`, {
      data: { body: `${long}, again`, change: 'a change line that is long enough to wrap on a phone screen' },
    }),
  )
  await ok(agent.put(`/api/tickets/${lane.id}/summary`, { data: { body: 'The lane is done.' } }))
  await ok(agent.post(`/api/tickets/${lane.id}/updates`, { data: { body: 'Lane progress.' } }))
  await ok(agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Progress of the ticket.' } }))

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const summary = page.getByRole('article', { name: 'Summary' })
  await expect(summary).toContainText('again')
  // The toggle floats in the card's top-right, clear of its title and the line under it.
  const history = summary.getByRole('button', { name: 'History (1)' })
  await expect(history).toHaveAccessibleName('History (1)')
  const historyBox = (await history.boundingBox())!
  for (const el of [
    summary.getByRole('heading', { level: 3, name: 'Summary', exact: true }),
    summary.getByText(/updated .*: a change line/),
  ]) {
    const box = await el.boundingBox()
    expect(box, await el.innerText()).not.toBeNull()
    expect(overlaps(historyBox, box!), await el.innerText()).toBe(false)
  }
  await history.tap()
  await expect(history).toHaveAttribute('aria-expanded', 'true')
  await expect(summary.getByRole('list', { name: 'Earlier versions' })).toBeVisible()
  // Its reply box, open.
  await summary
    .getByRole('group', { name: 'Summary actions' })
    .first()
    .getByRole('button', { name: 'reply' })
    .tap()
  await expect(summary.getByRole('textbox', { name: 'Reply' })).toBeVisible()
  await page.getByText('include lane posts').click()
  await expect(page.getByText('The lane is done.')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  const tabs = page.getByRole('tablist', { name: 'Feed' })
  await tabs.getByRole('tab', { name: /^Agents/ }).tap()
  await expect(page.getByText('Lane progress.', { exact: true })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  const box = (await tabs.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
})

test('no sideways scroll at 390px on the Overview, Daily (with a report), Previews, Cleanup, Connect an agent and Team pages', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const t = await api.ticket({
    title: 'A ticket with a long title that has to wrap on a phone instead of widening the page',
    status: 'in_progress',
  })
  // The day's activity quotes it: a long URL must wrap there too.
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Which one? https://example.com/a/very/long/path/that/goes/on/and/on/without/a/break',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    }),
  )
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { cadence: 'daily', prompt: 'What shipped today.' },
    }),
  )

  await page.goto(`/projects/${project.id}`)
  await expect(page.getByRole('link', { name: /^Decide: Which one\?/ })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  await page.goto(`/projects/${project.id}/daily`)
  await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).tap()
  await expect(page.getByText(/asked for a decision on/).first()).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await expect(page.getByRole('region', { name: 'Report', exact: true })).toContainText(
    'daily by 17:00, text',
  )
  await expect(page.getByRole('region', { name: 'Report calendar' }).getByRole('grid')).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  // The settings, opened: the prompt and the schedule fit too.
  const settings = page.getByRole('region', { name: 'Report settings' })
  await settings.getByRole('button', { name: /^Report settings/ }).click()
  await expect(settings.getByRole('group', { name: 'Prompt' })).toContainText('What shipped today.')
  await expect(settings.getByRole('group', { name: 'Schedule' })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  // A preview with a long branch and a long link: both must wrap or truncate.
  await ok(
    human.post(`/api/tickets/${t.id}/workspaces`, {
      data: {
        name: 'wt',
        branch: 'feature/a-very-long-branch-name-that-does-not-fit-on-a-phone-screen-at-all',
        previewUrl: 'https://example.com/a/very/long/path/that/goes/on/and/on/without/a/break/at/all',
      },
    }),
  )
  // A running link the board will not stop, with a long reason, and the limit and Stop all above.
  const live = http.createServer((_req, res) => res.end('a preview'))
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve))
  try {
    await ok(
      human.post(`/api/tickets/${t.id}/workspaces`, {
        data: {
          name: 'running',
          path: 'a-very-long-relative-worktree-path-that-does-not-fit-on-a-phone-screen-at-all',
          previewUrl: `http://127.0.0.1:${(live.address() as AddressInfo).port}`,
        },
      }),
    )
    await page.goto(`/projects/${project.id}/previews?stage=_all`)
    await expect(page.getByRole('link', { name: 'Open in browser' })).toHaveCount(2)
    await expect(page.getByText(/^The board will not stop it: a-very-long-relative/)).toBeVisible()
    await expect(page.getByLabel('Preview limit')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop all' })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    // The Stage filter, opened: All stages and every stage, each reachable, and still no sideways scroll.
    await page.getByRole('combobox', { name: 'Stage' }).tap()
    const options = page.getByRole('option')
    await expect(options).toHaveCount(8)
    for (const option of await options.all()) {
      await option.scrollIntoViewIfNeeded()
      await expect(option).toBeInViewport()
    }
    expect(await scrollsSideways(page)).toBe(false)
    // The ticket's stage (the decision asked on it may have moved it): both its previews again.
    const { status } = await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
    const stage = project.stages.find((s) => s.key === status)!
    await page.getByRole('option', { name: new RegExp(`^${stage.name} 2$`) }).tap()
    await expect(page).toHaveURL(new RegExp(`\\?stage=${status}$`))
    await expect(page.getByRole('link', { name: 'Open in browser' })).toHaveCount(2)
    expect(await scrollsSideways(page)).toBe(false)
  } finally {
    await new Promise((resolve) => live.close(resolve))
  }

  await page.goto(`/projects/${project.id}/cleanup`)
  await expect(page.getByRole('heading', { name: 'Cleanup' })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)

  for (const agents of ['/agents', `/projects/${project.id}/agents`]) {
    await page.goto(agents)
    await expect(page.getByText(/^\$t = Join-Path|^mkdir -p/).first()).toBeVisible()
    expect(await scrollsSideways(page), agents).toBe(false)
  }
})

test("a project's whole Daily page and the reports-due banner fit 390px and answer taps", async ({
  page,
  human,
  agent,
}, info) => {
  const { project, due, ticket, quiet } = await seedDailyPage(
    human,
    agent,
    `A project with a long name to show on a phone ${info.workerIndex}.${info.repeatEachIndex}`,
  )
  try {
    await page.goto(`/projects/${project.id}/daily`)
    // The header: what was pushed today and today's shift.
    await expect(pushedPill(page)).toHaveAttribute('data-pushed', 'yes')
    await expect(page.getByRole('img', { name: /^Shift / })).toBeVisible()
    await expect(reminder(page, due)).toBeVisible()
    await expect(page.getByRole('region', { name: 'Changes by agents to review' })).toContainText(
      'changed by claude',
    )
    const card = page.getByRole('region', { name: 'Report', exact: true })
    await expect(card.getByRole('heading', { name: 'Done' })).toBeVisible()
    await expect(card).toContainText('2 versions')
    await expect(card.getByRole('button', { name: 'Generate with claude' })).toBeEnabled()
    const calendar = page.getByRole('region', { name: 'Report calendar' })
    await expect(calendar.getByRole('button', { name: `${named(today)}: done` })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)

    // Each part opened by a tap: the pill's breakdown, the earlier version, the hours, the settings.
    await pushedPill(page).tap()
    await expect(page.getByRole('list', { name: 'Pushed today by repo' })).toContainText(ticket.title)
    expect(await scrollsSideways(page)).toBe(false)
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'History (1)' }).tap()
    await expect(card.getByRole('list', { name: 'Earlier versions' })).toContainText('first pass')
    await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).tap()
    await expect(page.getByText('posted the daily report').first()).toBeVisible()
    const settings = page.getByRole('region', { name: 'Report settings' })
    await settings.getByRole('button', { name: /^Report settings/ }).tap()
    await expect(settings.getByRole('group', { name: 'Template' })).toBeVisible()
    for (const name of ['Shift start', 'Shift end'])
      await expect(settings.getByRole('slider', { name })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    await page.screenshot({
      path: info.outputPath('daily-project-phone.png'),
      fullPage: true,
      style: 'body header { position: static !important }',
    })

    // A day picked on the calendar opens that day.
    await calendar.getByRole('button', { name: `${named(yesterday)}: done` }).tap()
    await expect(card).toContainText('The parser')
    expect(await scrollsSideways(page)).toBe(false)

    // The banner, on a ticket page.
    await page.goto(`/projects/${project.id}/features/${ticket.id}`)
    await expect(reminder(page, due)).toBeVisible()
    await expect(reminder(page, due)).toBeInViewport()
    expect(await scrollsSideways(page)).toBe(false)
    await page.screenshot({ path: info.outputPath('banner-ticket-phone.png') })
    await reminder(page, due).tap()
    await expect(page).toHaveURL(new RegExp(`/projects/${due.id}/daily$`))
  } finally {
    await quiet()
  }
})

test('the top bar and the page paint the theme background, so the phone status bar is not white', async ({
  page,
}) => {
  // The phone paints the strip behind its status icons (and the overscroll area) from the page when
  // viewport-fit=cover is set, so every one of these has to be the theme's background: an opaque bar,
  // a matching root canvas and body, and a theme-colour per scheme for the browsers that use it.
  await page.goto('/')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
  const themeColors = await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) => metas.map((m) => [m.getAttribute('content'), m.getAttribute('media')]))
  expect(themeColors).toEqual([
    ['#ffffff', '(prefers-color-scheme: light)'],
    ['#0a0a0a', '(prefers-color-scheme: dark)'],
  ])

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    const colors = await page.evaluate(() => {
      const header = document.querySelector('header')!
      return {
        root: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        bar: getComputedStyle(header).backgroundColor,
      }
    })
    expect(colors.root, colorScheme).toBe(colors.body)
    expect(colors.bar, colorScheme).toBe(colors.body)
    // Opaque: a translucent bar leaves the canvas behind it to show through.
    expect(colors.bar, colorScheme).not.toMatch(/\//)
  }
})

test('the top bar folds its pages into a menu that opens, and Daily is not one of them', async ({ page }) => {
  await page.goto(`/projects/${seededProject().id}/prs`)
  await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
  // Daily is a project's page now: it is in the project's menu, never in the top bar.
  await expect(page.getByRole('banner').getByRole('link', { name: 'Daily' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Pages' }).click()
  const menu = page.getByRole('dialog')
  await expect(menu.getByRole('link', { name: 'Daily' })).toHaveCount(0)
  for (const name of ['Connect', 'Settings']) await expect(menu.getByRole('link', { name })).toBeVisible()
  await menu.getByRole('link', { name: 'Connect' }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await expect(menu).toBeHidden()
})

test('the CrossBoard lockup stays on one row beside the test mode badge, and the menu stays on screen', async ({
  page,
}) => {
  for (const width of [390, 400]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/projects/${seededProject().id}/prs`)
    await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
    const bar = page.getByRole('banner')
    const badge = bar.getByText('test mode')
    await expect(badge).toBeVisible()
    const home = bar.getByRole('link', { name: 'CrossBoard', exact: true })
    const [mark, word, link, tag] = await Promise.all(
      [home.locator('svg'), home.getByText('CrossBoard', { exact: true }), home, badge].map((l) =>
        l.boundingBox(),
      ),
    )
    // One line of 17px type, to the right of the 22px mark and level with it, with nothing cut off.
    expect(mark!.width, `${width}px`).toBeCloseTo(22, 0)
    expect(word!.height, `${width}px`).toBeLessThanOrEqual(17 * 1.4)
    expect(word!.x, `${width}px`).toBeGreaterThanOrEqual(mark!.x + mark!.width)
    expect(
      Math.abs(word!.y + word!.height / 2 - (mark!.y + mark!.height / 2)),
      `${width}px`,
    ).toBeLessThanOrEqual(1.5)
    expect(await home.evaluate((e) => e.scrollWidth <= e.clientWidth), `${width}px`).toBe(true)
    expect(tag!.x, `${width}px`).toBeGreaterThanOrEqual(link!.x + link!.width)
    const menu = page.getByRole('button', { name: 'Pages' })
    await expect(menu).toBeInViewport({ ratio: 1 })
    const m = await menu.boundingBox()
    expect(m!.x + m!.width, `${width}px`).toBeLessThanOrEqual(width)
    expect(await scrollsSideways(page), `${width}px`).toBe(false)
  }
})

test('on a 375 and a 440px phone the PR queue fits without sideways scroll, and every tab answers a tap', async ({
  page,
  project,
}) => {
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  for (const width of [375, 440]) {
    await page.setViewportSize({ width, height: 844 })
    // The filter picked at the width before is remembered: start from To review.
    await page.goto(`/projects/${project.id}/prs?filter=me`)
    await expect(page.getByText('Nothing pending to review.'), `${width}px`).toBeVisible()
    expect(await scrollsSideways(page), `${width}px`).toBe(false)
    // The To review switch fits beside the filters, and answers a tap.
    await tab('Just me as reviewer').tap()
    await expect(tab('Just me as reviewer'), `${width}px`).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Nothing pending to review.'), `${width}px`).toBeVisible()
    expect(await scrollsSideways(page), `${width}px`).toBe(false)
    await tab('All PRs').tap()
    await expect(tab('All PRs'), `${width}px`).toHaveAttribute('aria-selected', 'true')
    for (const stage of ['Reviewed', 'On hold', 'Done']) {
      await tab(stage).tap()
      await expect(tab(stage), `${width}px`).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText(`Nothing ${stage.toLowerCase()} to review.`), `${width}px`).toBeVisible()
    }
    await tab('Waiting on others').tap()
    await expect(tab('Waiting on others'), `${width}px`).toHaveAttribute('aria-selected', 'true')
    await expect(tab('To review'), `${width}px`).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByText('Nothing done waiting on others.'), `${width}px`).toBeVisible()
    await tab('Pending').tap()
    await expect(page.getByText('Nothing pending waiting on others.'), `${width}px`).toBeVisible()
    expect(await scrollsSideways(page), `${width}px`).toBe(false)
  }
})
