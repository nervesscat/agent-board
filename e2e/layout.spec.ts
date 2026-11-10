import type { Locator, Page } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { expect, ok, seededProject, test } from './fixtures'

const MENU = [
  'Overview',
  'PR queue',
  'Ongoing features',
  'Roadmap',
  'Previews',
  'Gallery',
  'Team',
  'Daily',
  'Cleanup',
  'Repositories',
  'Instructions',
  'Settings',
]
const CARDS = ['Needs you', 'In progress', 'Done today', 'Next', 'Carrying over']

const editor = (page: Page) => page.getByRole('region', { name: 'Layout' })
const tiles = (scope: Locator, list: string) => scope.getByRole('list', { name: list }).getByRole('listitem')
const menu = (page: Page) => page.locator('aside nav').getByRole('link')
/** The Overview's card titles, in order. */
const cardTitles = (scope: Page | Locator) => scope.locator('[data-slot="card-title"]')
/** Titles matched by their start: "Next: To do" is Next, a count may follow. */
const starting = (titles: string[]) => titles.map((t) => new RegExp(`^\\s*${t}`))

test('the human hides a page and reorders the menu from the keyboard; both persist after a reload', async ({
  page,
  project,
  human,
}) => {
  const saved = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  await page.goto(`/projects/${project.id}/settings`)
  const layout = editor(page)
  const save = layout.getByRole('button', { name: 'Save' })
  const status = layout.getByText(/^(No changes|Unsaved changes)\./)
  await expect(tiles(layout, 'Project menu')).toHaveText(MENU)
  await expect(tiles(layout, 'Overview cards')).toHaveText(CARDS)
  await expect(tiles(layout, 'Ticket page, main column')).toHaveText([
    'Resume here',
    'Instructions',
    'Tasks',
    'Timeline',
    'Lanes',
    'Activity',
  ])
  await expect(tiles(layout, 'Ticket page, side column')).toHaveText([
    'Runs',
    'Details',
    'Branch',
    'Workspaces',
  ])
  await expect(status).toHaveText('No changes.')
  await expect(save).toBeDisabled()
  // The landing page, the board and this page can move but never hide.
  for (const name of ['Overview', 'Ongoing features', 'Settings'])
    await expect(layout.getByRole('switch', { name: `Show ${name} in the menu` })).toBeDisabled()
  await expect(layout.getByRole('switch', { name: 'Show Tasks on the ticket page' })).toBeDisabled()

  // Gallery hidden with Space; it stays in the editor, marked hidden.
  const gallery = layout.getByRole('switch', { name: 'Show Gallery in the menu' })
  await gallery.focus()
  await page.keyboard.press('Space')
  await expect(gallery).not.toBeChecked()
  await expect(tiles(layout, 'Project menu').filter({ hasText: 'Gallery' })).toHaveAttribute(
    'data-hidden',
    'true',
  )
  await expect(status).toHaveText('Unsaved changes. 1 hidden.')

  // Daily up twice with Enter: the focus stays on its button as it moves.
  const up = layout.getByRole('button', { name: 'Move Daily up in the menu' })
  await up.focus()
  await page.keyboard.press('Enter')
  await expect(up).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(up).toBeFocused()
  const order = [
    ...MENU.slice(0, 5),
    'Daily',
    'Gallery',
    'Team',
    'Cleanup',
    'Repositories',
    'Instructions',
    'Settings',
  ]
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  // At the top, the focus moves to its other arrow.
  const settingsUp = layout.getByRole('button', { name: 'Move Settings up in the menu' })
  await settingsUp.focus()
  for (let i = 0; i < MENU.length - 1; i++) await page.keyboard.press('Enter')
  await expect(layout.getByRole('button', { name: 'Move Settings down in the menu' })).toBeFocused()
  await page.keyboard.press('Enter')
  const reordered = ['Overview', 'Settings', ...order.slice(1, -1)]
  await expect(tiles(layout, 'Project menu')).toHaveText(reordered)

  // Saved from the keyboard too; the menu follows at once.
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  await expect(status).toHaveText('No changes. 1 hidden.')
  const shown = reordered.filter((n) => n !== 'Gallery')
  await expect(menu(page)).toHaveText(shown)
  const stored = await saved()
  expect(stored.find((it) => it.id === 'nav.gallery')).toEqual({
    id: 'nav.gallery',
    area: 'nav',
    hidden: true,
  })
  expect(stored.filter((it) => it.area === 'nav').map((it) => it.id)[1]).toBe('nav.settings')

  // After a reload: the editor and the menu as saved.
  await page.reload()
  await expect(tiles(layout, 'Project menu')).toHaveText(reordered)
  await expect(gallery).not.toBeChecked()
  await expect(menu(page)).toHaveText(shown)

  // The hidden page still opens by its URL, without coming back to the menu.
  await page.goto(`/projects/${project.id}/gallery`)
  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible()
  await expect(menu(page)).toHaveText(shown)

  // Reset to default: the defaults stored as none, everywhere at once.
  await page.goto(`/projects/${project.id}/settings`)
  await layout.getByRole('button', { name: 'Reset to default' }).click()
  await expect(menu(page)).toHaveText(MENU)
  await expect(tiles(layout, 'Project menu')).toHaveText(MENU)
  await expect(gallery).toBeChecked()
  await expect(status).toHaveText('No changes.')
  expect((await saved()).every((it) => !it.hidden)).toBe(true)
  expect((await saved()).filter((it) => it.area === 'nav').map((it) => it.id)[1]).toBe('nav.prs')
})

test('an edit made while a Save or a Reset is on its way stays, unsaved, and a second Save keeps it', async ({
  page,
  project,
  human,
}) => {
  const saved = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  const hiddenIds = async () => (await saved()).filter((it) => it.hidden).map((it) => it.id)
  // The project's saves wait until released, to edit while one is on its way.
  let release = () => {}
  let hold = Promise.resolve()
  const holdNext = () => (hold = new Promise<void>((r) => (release = r)))
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await hold
    await route.fallback()
  })
  await page.goto(`/projects/${project.id}/settings`)
  const layout = editor(page)
  const save = layout.getByRole('button', { name: 'Save' })
  const saving = layout.getByRole('button', { name: 'Saving…' })
  const status = layout.getByText(/^(No changes|Unsaved changes)\./)
  const gallery = layout.getByRole('switch', { name: 'Show Gallery in the menu' })
  const roadmap = layout.getByRole('switch', { name: 'Show Roadmap in the menu' })

  // Gallery off and saved; Roadmap off and Daily up while that save is on its way.
  holdNext()
  await gallery.click()
  await save.click()
  await expect(saving).toBeDisabled()
  await roadmap.click()
  await layout.getByRole('button', { name: 'Move Daily up in the menu' }).click()
  const order = [...MENU.slice(0, 6), 'Daily', 'Team', 'Cleanup', 'Repositories', 'Instructions', 'Settings']
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  await expect(status).toHaveText('Unsaved changes. 2 hidden.')
  release()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  // The save brought Gallery only; the edits made meanwhile are still there, still to save.
  expect(await hiddenIds()).toEqual(['nav.gallery'])
  await expect(roadmap).not.toBeChecked()
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  await expect(status).toHaveText('Unsaved changes. 2 hidden.')
  await expect(save).toBeEnabled()

  // A second Save keeps them, after a reload too.
  await save.click()
  await expect(status).toHaveText('No changes. 2 hidden.')
  expect((await hiddenIds()).sort()).toEqual(['nav.gallery', 'nav.roadmap'])
  await page.reload()
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  await expect(gallery).not.toBeChecked()
  await expect(roadmap).not.toBeChecked()
  await expect(status).toHaveText('No changes. 2 hidden.')

  // Reset the same way: Roadmap switched back on while the defaults are on their way.
  holdNext()
  await layout.getByRole('button', { name: 'Reset to default' }).click()
  await expect(saving).toBeDisabled()
  await roadmap.click()
  await expect(roadmap).toBeChecked()
  release()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' }).last()).toBeVisible()
  expect(await hiddenIds()).toEqual([])
  // Kept as edited: the saved order with Roadmap shown, Gallery still off, unsaved against the defaults.
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  await expect(gallery).not.toBeChecked()
  await expect(roadmap).toBeChecked()
  await expect(status).toHaveText('Unsaved changes. 1 hidden.')
  await save.click()
  await expect(status).toHaveText('No changes. 1 hidden.')
  await page.reload()
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  await expect(gallery).not.toBeChecked()
  await expect(roadmap).toBeChecked()
})

test('dragging reorders the Overview and moves a ticket section to the other column; both persist', async ({
  page,
  project,
  api,
}) => {
  const ticket = await api.ticket({ title: 'Arranged' })
  await page.goto(`/projects/${project.id}/settings`)
  const layout = editor(page)
  const overview = tiles(layout, 'Overview cards')
  const main = tiles(layout, 'Ticket page, main column')
  const side = tiles(layout, 'Ticket page, side column')

  // Carrying over dropped on the left half of Needs you: first.
  await overview
    .filter({ hasText: 'Carrying over' })
    .dragTo(overview.filter({ hasText: 'Needs you' }), { targetPosition: { x: 10, y: 10 } })
  await expect(overview).toHaveText(['Carrying over', ...CARDS.slice(0, 4)])
  await layout.getByRole('switch', { name: 'Show Done today on the Overview' }).click()

  // Details dropped on the top half of Resume here, in the main column: first there.
  await side
    .filter({ hasText: 'Details' })
    .dragTo(main.filter({ hasText: 'Resume here' }), { targetPosition: { x: 10, y: 3 } })
  await expect(main).toHaveText([
    'Details',
    'Resume here',
    'Instructions',
    'Tasks',
    'Timeline',
    'Lanes',
    'Activity',
  ])
  await expect(side).toHaveText(['Runs', 'Branch', 'Workspaces'])
  // And Workspaces to the main column with its button, hidden there.
  await layout.getByRole('button', { name: 'Move Workspaces to the main column' }).click()
  await expect(layout.getByRole('button', { name: 'Move Workspaces to the side column' })).toBeFocused()
  await layout.getByRole('switch', { name: 'Show Workspaces on the ticket page' }).click()
  await expect(main.last()).toHaveText('Workspaces')
  await layout.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()

  await page.reload()
  await expect(overview).toHaveText(['Carrying over', ...CARDS.slice(0, 4)])
  await expect(layout.getByRole('switch', { name: 'Show Done today on the Overview' })).not.toBeChecked()
  await expect(main).toHaveText([
    'Details',
    'Resume here',
    'Instructions',
    'Tasks',
    'Timeline',
    'Lanes',
    'Activity',
    'Workspaces',
  ])

  // The Overview: in that order, Done today gone.
  await page.goto(`/projects/${project.id}`)
  await expect(cardTitles(page)).toHaveText(starting(['Carrying over', 'Needs you', 'In progress', 'Next']))

  // Home: this project's block follows its layout, another's keeps every card.
  await page.goto('/')
  const block = (name: string) =>
    page.getByRole('heading', { level: 2, name, exact: true }).locator('xpath=ancestor::section[1]')
  await expect(cardTitles(block(project.name))).toHaveText(
    starting(['Carrying over', 'Needs you', 'In progress', 'Next']),
  )
  await expect(cardTitles(block(seededProject().name))).toHaveText(starting(CARDS))

  // The ticket page: Details first in the main column, Workspaces nowhere.
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  const mainColumn = page.locator('[data-ticket-column="main"]')
  await expect(mainColumn.getByRole('region', { name: 'Details' })).toBeVisible()
  await expect(
    page.locator('[data-ticket-column="side"]').getByRole('region', { name: 'Details' }),
  ).toHaveCount(0)
  const first = await mainColumn.evaluate((el) =>
    el.querySelector(':scope > [aria-label]')?.getAttribute('aria-label'),
  )
  expect(first).toBe('Details')
  await expect(page.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Workspaces' })).toHaveCount(0)
})

test('every Overview card hidden leaves a note that leads to the layout', async ({
  page,
  project,
  human,
}) => {
  const layout = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout.map((it) =>
    it.area === 'overview' ? { ...it, hidden: true } : it,
  )
  await ok(human.patch(`/api/projects/${project.id}`, { data: { layout } }))
  await page.goto(`/projects/${project.id}`)
  await expect(page.locator('[data-slot="card"]')).toHaveCount(0)
  await page.getByRole('link', { name: 'Show them again in the layout settings' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/settings#layout$`))
  // Followed in the app, not loaded afresh: the page still lands on the Layout section below the others.
  await expect(editor(page)).toBeInViewport()
})

test('the layout editor fits a phone: no sideways scroll, the columns one above the other', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project.id}/settings`)
  const layout = editor(page)
  await layout.scrollIntoViewIfNeeded()
  await expect(tiles(layout, 'Project menu')).toHaveCount(MENU.length)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  const main = await layout.getByRole('list', { name: 'Ticket page, main column' }).boundingBox()
  const side = await layout.getByRole('list', { name: 'Ticket page, side column' }).boundingBox()
  expect(side!.y).toBeGreaterThan(main!.y + main!.height - 1)
})

/** The ticket page's columns: their widths, and the width of the grid they sit in. */
const columns = async (page: Page) => {
  const grid = page.locator('[data-ticket-column]').first().locator('xpath=..')
  return {
    grid: (await grid.boundingBox())!.width,
    main: page.locator('[data-ticket-column="main"]'),
    side: page.locator('[data-ticket-column="side"]'),
  }
}

test('a ticket column with nothing to show on this ticket is not drawn; the other takes the width', async ({
  page,
  project,
  human,
  api,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const base = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  // Sent as is: the server checks it.
  const arrange = (layout: unknown) => ok(human.patch(`/api/projects/${project.id}`, { data: { layout } }))
  // A new ticket: no runs, still open.
  const ticket = await api.ticket({ title: 'Nothing on the side' })
  const url = `/projects/${project.id}/features/${ticket.id}`

  // Details, Branch and Workspaces hidden: Runs is left there, with nothing to show.
  const hidden = ['ticket.details', 'ticket.branch', 'ticket.workspaces']
  await arrange(base.map((it) => (hidden.includes(it.id) ? { ...it, hidden: true } : it)))
  await page.goto(url)
  let { grid, main, side } = await columns(page)
  await expect(main.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible()
  await expect(side).toHaveCount(0)
  expect((await main.boundingBox())!.width).toBeCloseTo(grid, 0)

  // Runs hidden too: nothing left there at all.
  await arrange(base.map((it) => ([...hidden, 'ticket.runs'].includes(it.id) ? { ...it, hidden: true } : it)))
  await page.reload()
  ;({ grid, main, side } = await columns(page))
  await expect(main.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible()
  await expect(side).toHaveCount(0)
  expect((await main.boundingBox())!.width).toBeCloseTo(grid, 0)

  // The other way: on a cancelled ticket, a main column left with only Resume here (shown on open
  // tickets alone) is not drawn, and the side column takes the width.
  await arrange(
    base.map((it) =>
      it.area === 'ticket.main' && it.id !== 'ticket.resume' ? { ...it, area: 'ticket.side' as const } : it,
    ),
  )
  await ok(human.patch(`/api/tickets/${ticket.id}`, { data: { status: 'cancelled' } }))
  await page.reload()
  ;({ grid, main, side } = await columns(page))
  await expect(side.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible()
  await expect(main).toHaveCount(0)
  expect((await side.boundingBox())!.width).toBeCloseTo(grid, 0)
})

/** The project's layout with one ticket section put last in a column. */
const putLast = (layout: Project['layout'], id: string, area: 'ticket.main' | 'ticket.side') => [
  ...layout.filter((it) => it.id !== id),
  { ...layout.find((it) => it.id === id)!, area },
]

test('a #link into a section the layout moves lands on it when the project loads after the ticket', async ({
  page,
  project,
  human,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const base = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  // Tasks last in the main column, after a long feed: far from where it is by default.
  await ok(
    human.patch(`/api/projects/${project.id}`, {
      data: { layout: putLast(base, 'ticket.tasks', 'ticket.main') },
    }),
  )
  const ticket = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Moved tasks', tasks: ['Deploy'], defaultPhases: false },
    }),
  )
  for (let i = 1; i <= 25; i++)
    await ok(
      human.post(`/api/tickets/${ticket.id}/updates`, {
        data: {
          body: `Post ${i}.

${'A line. '.repeat(40)}`,
        },
      }),
    )
  const task = (await ok<TicketFull>(human.get(`/api/tickets/${ticket.id}`))).tasks[0]!

  // The project answers only once the ticket has, and a while after.
  const ticketLoaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/tickets/${ticket.id}` && r.request().method() === 'GET',
  )
  let held = false
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() === 'GET') {
      held = true
      await ticketLoaded
      await new Promise((r) => setTimeout(r, 1500))
    }
    await route.fallback()
  })
  const projectLoaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/projects/${project.id}` && r.request().method() === 'GET',
  )
  await page.goto(`/projects/${project.id}/features/${ticket.id}#task-${task.id}`)
  await projectLoaded
  expect(held).toBe(true)
  // Tasks drawn where the layout has it, after the feed, and the page brought there.
  const tasks = page.getByRole('region', { name: 'Tasks' })
  const composer = page.getByRole('textbox', { name: 'New post', exact: true })
  await expect
    .poll(async () => (await tasks.boundingBox())!.y - (await composer.boundingBox())!.y)
    .toBeGreaterThan(0)
  const row = page.locator(`#task-${task.id}`)
  await expect(row).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(2000)
  // And it stays there: nothing moves under the reader once in view.
  await page.waitForTimeout(1000)
  await expect(row).toBeInViewport()
})

test('a layout saved while a ticket is open keeps the page as drawn: an unsent post stays', async ({
  page,
  project,
  human,
  api,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const ticket = await api.ticket({ title: 'Draft kept' })
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  const main = page.locator('[data-ticket-column="main"]')
  const side = page.locator('[data-ticket-column="side"]')
  const composer = page.getByRole('textbox', { name: 'New post', exact: true })
  await expect(main.locator(composer)).toBeVisible()
  await composer.click()
  await page.keyboard.type('Half a thought')
  await expect(composer).toContainText('Half a thought')

  // Activity moved to the side column elsewhere, and the page refetches the project (back to the tab).
  const base = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  await ok(
    human.patch(`/api/projects/${project.id}`, {
      data: { layout: putLast(base, 'ticket.activity', 'ticket.side') },
    }),
  )
  await expect(async () => {
    const fetched = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/projects/${project.id}` && r.request().method() === 'GET',
      { timeout: 2000 },
    )
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    const layout = ((await (await fetched).json()) as Project).layout
    expect(layout.find((it) => it.id === 'ticket.activity')!.area).toBe('ticket.side')
  }).toPass({ timeout: 20_000 })
  await page.waitForTimeout(500)

  // The page keeps what it drew: the draft is where it was, as typed.
  await expect(main.locator(composer)).toBeVisible()
  await expect(composer).toContainText('Half a thought')
  await expect(side.locator(composer)).toHaveCount(0)

  // The next visit draws the new layout.
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  await expect(side.locator(composer)).toBeVisible()
  await expect(main.locator(composer)).toHaveCount(0)
})

test('a layout saved with the Hand-off card still loads, without it', async ({ page, project, human }) => {
  const base = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  // As a board saved it while the card was there: Hand-off first in the side column.
  const saved = [
    ...base.filter((it) => it.area !== 'ticket.side'),
    { id: 'ticket.handoff', area: 'ticket.side', hidden: false },
    ...base.filter((it) => it.area === 'ticket.side'),
  ]
  const res = await human.patch(`/api/projects/${project.id}`, { data: { layout: saved } })
  expect(res.status()).toBe(200)
  const stored = (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout
  expect(stored.map((it) => it.id)).not.toContain('ticket.handoff')
  expect(stored).toEqual(base)
  await page.goto(`/projects/${project.id}/settings`)
  await expect(tiles(editor(page), 'Ticket page, side column')).toHaveText([
    'Runs',
    'Details',
    'Branch',
    'Workspaces',
  ])
})

test('Daily is in the project menu, never the top bar, and the old /daily opens the last project', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/daily`)
  await expect(page.getByRole('heading', { level: 1, name: 'Daily' })).toBeVisible()
  await expect(page.getByRole('banner').getByRole('link', { name: 'Daily' })).toHaveCount(0)
  // In the project's menu, highlighted while its page shows. The router marks the current link
  // `aria-current="page"`, not only with a class.
  const daily = page.locator('aside nav').getByRole('link', { name: 'Daily' })
  await expect(daily).toHaveAttribute('aria-current', 'page')
  // The old board-wide address opens this browser's current project.
  await page.goto('/daily')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/daily$`))
  await expect(page.locator('aside nav').getByRole('link', { name: 'Daily' })).toHaveAttribute(
    'aria-current',
    'page',
  )

  // At 390 the project's pages are a picker, Daily among them, and the top bar still has none.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('banner').getByRole('link', { name: 'Daily' })).toHaveCount(0)
  const picker = page.getByRole('combobox', { name: 'Project page' })
  await expect(picker).toContainText('Daily')
  await picker.click()
  await page.getByRole('option', { name: 'Daily' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/daily$`))
  await expect(picker).toContainText('Daily')

  // With no project known, it lands on Home, where a project is picked.
  await page.evaluate(() => localStorage.clear())
  await page.goto('/daily')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()

  // The project list failing is the same dead end as an empty one: Home, never stuck on "Opening
  // Daily…". (The review found /daily depended on this call only since Daily became project-only.)
  await page.route(
    (url) => url.pathname === '/api/projects',
    (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"restarting"}' }),
  )
  await page.goto('/daily')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByText('Opening Daily…')).toHaveCount(0)
})
