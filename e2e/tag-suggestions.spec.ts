import type { Page } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

const DEFAULTS = ['Bug', 'UI', 'Implementation', 'Report']

/** Whether the page itself scrolls sideways (a board's own column scroller does not count). */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

test('the human edits the tag suggestions on the Settings page, and they persist', async ({
  page,
  project,
  human,
}) => {
  const saved = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).tagSuggestions
  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Tag suggestions' })
  const field = section.getByRole('textbox', { name: 'Tag suggestions, one per line' })
  const save = section.getByRole('button', { name: 'Save' })
  await expect(field).toHaveValue(DEFAULTS.join('\n'))
  await expect(save).toBeDisabled()

  // Renamed, removed and added; trimmed, a repeat in another casing left out.
  await field.fill('Defect\n  UI \nAuth\nauth')
  await save.click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  expect(await saved()).toEqual(['Defect', 'UI', 'Auth'])
  await page.reload()
  await expect(field).toHaveValue('Defect\nUI\nAuth')

  // Emptied, it stays empty; the defaults can be had back.
  await field.fill('')
  await save.click()
  await expect.poll(saved).toEqual([])
  await page.reload()
  await expect(field).toHaveValue('')
  await section.getByRole('button', { name: 'Use the defaults' }).click()
  await expect.poll(saved).toEqual(DEFAULTS)
  await expect(field).toHaveValue(DEFAULTS.join('\n'))
})

test('chips under the Tags field offer the suggestions and the tags in use, in the casing in use', async ({
  page,
  project,
  api,
  human,
}) => {
  await api.ticket({ title: 'Styled', tags: ['ui', 'Forms'] })
  await api.ticket({ title: 'Styled again', tags: ['ui'] })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Stage')).toBeVisible()
  const chips = dialog.getByRole('group', { name: 'Suggested tags' }).getByRole('button')
  // The suggestions first (UI in the casing the tickets use), then the other tags in use; no "UI" twice.
  await expect(chips).toHaveText(['Bug', 'ui', 'Implementation', 'Report', 'Forms'])

  await dialog.getByRole('button', { name: 'Add tag ui' }).click()
  await dialog.getByRole('button', { name: 'Add tag Forms' }).click()
  await expect(chips).toHaveText(['Bug', 'Implementation', 'Report'])
  await expect(dialog.getByRole('button', { name: 'Remove ui' })).toBeVisible()
  await dialog.getByLabel('Title').fill('Chips')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const created = (await ok<TicketFull[]>(human.get(`/api/projects/${project.id}/tickets`))).find(
    (t) => t.title === 'Chips',
  )!
  expect(created.tags).toEqual(['ui', 'Forms'])

  // On the ticket, editing its tags offers the same chips, those it carries left out.
  await page.goto(`/projects/${project.id}/features/${created.id}`)
  await page.getByRole('button').filter({ hasText: 'Forms' }).filter({ hasText: 'ui' }).click()
  const inline = page.getByRole('group', { name: 'Suggested tags' }).getByRole('button')
  await expect(inline).toHaveText(['Bug', 'Implementation', 'Report'])
  await page.getByRole('button', { name: 'Add tag Bug' }).click()
  await expect(inline).toHaveText(['Implementation', 'Report'])
  await page.getByRole('textbox', { name: 'Tags, comma separated' }).press('Enter')
  await expect.poll(async () => (await api.getTicket(created.id)).tags).toEqual(['ui', 'Forms', 'Bug'])
})

test('the board filter by tag lives in ?tag=, matches any casing, and clears', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Tagged todo', status: 'todo', tags: ['Auth'] })
  await api.ticket({ title: 'Tagged review', status: 'review', tags: ['auth', 'UI'] })
  await api.ticket({ title: 'Untagged', status: 'todo' })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(page.getByText('Untagged')).toBeVisible()

  await page.getByRole('combobox', { name: 'Filter by tag' }).click()
  await page.getByRole('option', { name: 'Auth' }).click()
  await expect(page).toHaveURL(/[?&]tag=Auth/)
  await expect(page.getByText('Tagged todo')).toBeVisible()
  await expect(page.getByText('Tagged review')).toBeVisible()
  await expect(page.getByText('Untagged')).toHaveCount(0)

  // A link in another casing restores it.
  await page.goto(`/projects/${project.id}/features?view=board&tag=AUTH`)
  await expect(page.getByText('Tagged review')).toBeVisible()
  await expect(page.getByText('Untagged')).toHaveCount(0)
  // The List keeps it too.
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByText('Tagged todo')).toBeVisible()
  await expect(page.getByText('Untagged')).toHaveCount(0)

  await page.getByRole('button', { name: 'Clear the tag filter' }).click()
  await expect(page).not.toHaveURL(/[?&]tag=/)
  await expect(page.getByText('Untagged')).toBeVisible()
})

test('the tag count is the rows shown, the search on the List included', async ({ page, project, api }) => {
  await api.ticket({ title: 'Header layout', status: 'todo', tags: ['UI'] })
  await api.ticket({ title: 'Footer spacing', status: 'todo', tags: ['ui'] })
  await api.ticket({ title: 'Button colors', status: 'review', tags: ['UI'] })
  await api.ticket({ title: 'Menu icons', status: 'todo', tags: ['UI', 'Bug'] })
  await api.ticket({ title: 'Header cache', status: 'todo', tags: ['Backend'] })
  const count = page.getByText(/^\d+ tickets?$/)

  await page.goto(`/projects/${project.id}/features?view=list&tag=UI&q=Footer`)
  await expect(page.getByText('Footer spacing')).toBeVisible()
  await expect(page.getByText('Header layout')).toHaveCount(0)
  await expect(count).toHaveText('1 ticket')

  // Another search, the same tag: one of the two it finds carries it.
  await page.getByRole('searchbox', { name: 'Search tickets' }).fill('Header')
  await expect(page).toHaveURL(/[?&]q=Header/)
  await expect(page.getByText('Header layout')).toBeVisible()
  await expect(page.getByText('Header cache')).toHaveCount(0)
  await expect(count).toHaveText('1 ticket')

  // Cleared, the List shows every ticket with the tag; so does the Board, which ignores the search.
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByText('Button colors')).toBeVisible()
  await expect(count).toHaveText('4 tickets')
  await page.goto(`/projects/${project.id}/features?view=board&tag=UI&q=Footer`)
  await expect(page.getByText('Header layout')).toBeVisible()
  await expect(count).toHaveText('4 tickets')
})

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the tag filter and the chips fit without a sideways scroll', async ({ page, project, api }) => {
    await api.ticket({ title: 'Narrow', status: 'todo', tags: ['A rather long module name', 'Auth'] })
    await page.goto(`/projects/${project.id}/features?view=board&tag=auth`)
    const filter = page.getByRole('combobox', { name: 'Filter by tag' })
    await expect(filter).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Clear the tag filter' })).toBeInViewport()
    expect(await scrollsSideways(page)).toBe(false)

    await page.getByRole('button', { name: 'New ticket' }).click()
    const dialog = page.getByRole('dialog')
    const chip = dialog.getByRole('button', { name: 'Add tag A rather long module name' })
    await chip.scrollIntoViewIfNeeded()
    await expect(chip).toBeInViewport()
    await chip.tap()
    await expect(dialog.getByRole('button', { name: 'Remove A rather long module name' })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
  })
})
