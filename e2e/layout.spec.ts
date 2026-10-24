import type { Locator, Page } from '@playwright/test'

import type { Project } from '#/lib/api'
import { expect, ok, seededProject, test } from './fixtures'

const MENU = [
  'Overview',
  'PR queue',
  'Ongoing features',
  'Roadmap',
  'Previews',
  'Gallery',
  'Agents',
  'Daily',
  'Cleanup',
  'Instructions',
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
    'Lanes',
    'Activity',
  ])
  await expect(tiles(layout, 'Ticket page, side column')).toHaveText([
    'Hand-off',
    'Preview',
    'Details',
    'Branch',
    'Workspaces',
  ])
  await expect(status).toHaveText('No changes.')
  await expect(save).toBeDisabled()
  // The landing page, the board and this page can move but never hide.
  for (const name of ['Overview', 'Ongoing features', 'Instructions'])
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
  const order = [...MENU.slice(0, 5), 'Daily', 'Gallery', 'Agents', 'Cleanup', 'Instructions']
  await expect(tiles(layout, 'Project menu')).toHaveText(order)
  // At the top, the focus moves to its other arrow.
  const settingsUp = layout.getByRole('button', { name: 'Move Instructions up in the menu' })
  await settingsUp.focus()
  for (let i = 0; i < 9; i++) await page.keyboard.press('Enter')
  await expect(layout.getByRole('button', { name: 'Move Instructions down in the menu' })).toBeFocused()
  await page.keyboard.press('Enter')
  const reordered = ['Overview', 'Instructions', ...order.slice(1, -1)]
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
  await expect(main).toHaveText(['Details', 'Resume here', 'Instructions', 'Tasks', 'Lanes', 'Activity'])
  await expect(side).toHaveText(['Hand-off', 'Preview', 'Branch', 'Workspaces'])
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
  const first = await mainColumn.evaluate((el) => el.firstElementChild?.getAttribute('aria-label'))
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
  await expect(editor(page)).toBeVisible()
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
  // A new ticket: no hand-off, no preview, still open.
  const ticket = await api.ticket({ title: 'Nothing on the side' })
  const url = `/projects/${project.id}/features/${ticket.id}`

  // Details, Branch and Workspaces hidden: Hand-off and Preview are left there, with nothing to show.
  const hidden = ['ticket.details', 'ticket.branch', 'ticket.workspaces']
  await arrange(base.map((it) => (hidden.includes(it.id) ? { ...it, hidden: true } : it)))
  await page.goto(url)
  let { grid, main, side } = await columns(page)
  await expect(main.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible()
  await expect(side).toHaveCount(0)
  expect((await main.boundingBox())!.width).toBeCloseTo(grid, 0)

  // Preview hidden too: Hand-off alone, still nothing.
  await arrange(
    base.map((it) => ([...hidden, 'ticket.preview'].includes(it.id) ? { ...it, hidden: true } : it)),
  )
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
