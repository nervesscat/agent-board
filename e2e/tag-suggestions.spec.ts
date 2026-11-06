import type { Locator, Page } from '@playwright/test'

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
  const listed = section.getByRole('list', { name: 'Tag suggestions' }).getByRole('listitem')
  const field = section.getByRole('textbox', { name: 'New tag' })
  const save = section.getByRole('button', { name: 'Save' })
  const status = section.getByText(/^(No changes|Unsaved changes)\.$/)
  await expect(listed).toHaveText(DEFAULTS)
  await expect(field).toHaveAttribute('placeholder', 'Add a tag')
  await expect(save).toBeDisabled()
  await expect(status).toHaveText('No changes.')
  // A tag list has no order buttons.
  await expect(section.getByRole('button', { name: /^Move / })).toHaveCount(0)

  // Removed with ×, added with Enter and with +; trimmed, a repeat in another casing left out on save.
  await section.getByRole('button', { name: 'Remove Bug' }).click()
  await section.getByRole('button', { name: 'Remove Implementation' }).click()
  await section.getByRole('button', { name: 'Remove Report' }).click()
  await expect(status).toHaveText('Unsaved changes.')
  await field.fill('  Auth ')
  await field.press('Enter')
  await field.fill('auth')
  await section.getByRole('button', { name: 'Add tag' }).click()
  await expect(listed).toHaveText(['UI', 'Auth', 'auth'])
  await save.click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  expect(await saved()).toEqual(['UI', 'Auth'])
  await expect(listed).toHaveText(['UI', 'Auth'])
  await expect(status).toHaveText('No changes.')
  await page.reload()
  await expect(listed).toHaveText(['UI', 'Auth'])

  // Emptied, it stays empty; the defaults can be had back.
  await section.getByRole('button', { name: 'Remove UI' }).click()
  await section.getByRole('button', { name: 'Remove Auth' }).click()
  await expect(section.getByText('No suggestions: only the tags in use are offered.')).toBeVisible()
  await save.click()
  await expect.poll(saved).toEqual([])
  await page.reload()
  await expect(listed).toHaveCount(0)
  await section.getByRole('button', { name: 'Use the defaults' }).click()
  await expect.poll(saved).toEqual(DEFAULTS)
  await expect(listed).toHaveText(DEFAULTS)
  await expect(status).toHaveText('No changes.')
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

test('on the ticket, Enter on a chip reached by Tab adds its tag and keeps the editor open', async ({
  page,
  project,
  api,
}) => {
  const created = await api.ticket({ title: 'Keyboard', tags: ['Forms'] })
  await page.goto(`/projects/${project.id}/features/${created.id}`)
  await page.getByRole('button').filter({ hasText: 'Forms' }).click()
  const field = page.getByRole('textbox', { name: 'Tags, comma separated' })
  await expect(field).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Add tag Bug' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Remove Bug' })).toBeVisible()
  await expect(field).toBeFocused()
  await field.press('Enter')
  await expect(field).toBeHidden()
  await expect.poll(async () => (await api.getTicket(created.id)).tags).toEqual(['Forms', 'Bug'])
})

test('a chip taken from the keyboard gives the focus back to the text, so leaving the field saves', async ({
  page,
  project,
  api,
}) => {
  await page.goto(`/projects/${project.id}/features?view=board`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const field = dialog.getByLabel('Tags (optional)')
  await field.click()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Add tag Bug' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('button', { name: 'Remove Bug' })).toBeVisible()
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  const created = await api.ticket({ title: 'Keyboard', tags: ['Forms'] })
  await page.goto(`/projects/${project.id}/features/${created.id}`)
  await page.getByRole('button').filter({ hasText: 'Forms' }).click()
  const inlineField = page.getByRole('textbox', { name: 'Tags, comma separated' })
  await expect(inlineField).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Add tag Bug' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Remove Bug' })).toBeVisible()
  await expect(inlineField).toBeFocused()
  // Leaving the field for the page saves what the chip added.
  await page.mouse.click(1200, 700)
  await expect(inlineField).toBeHidden()
  await expect.poll(async () => (await api.getTicket(created.id)).tags).toEqual(['Forms', 'Bug'])
})

/** As many suggestions as a project can have (50), more than two rows of chips at any width. */
const MANY = Array.from({ length: 50 }, (_, i) => `Module ${i + 1}`)

/**
 * The suggested chips' box: its heights, its overflow, and the height two rows of its chips take with
 * the gap between them and the box's own padding.
 */
const chipBox = (group: Locator) =>
  group.evaluate((el) => {
    const style = getComputedStyle(el)
    const chip = el.querySelector('button')!.getBoundingClientRect().height
    const px = (v: string) => parseFloat(v)
    return {
      client: el.clientHeight,
      scroll: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: style.overflowY,
      twoRows: 2 * chip + px(style.rowGap) + px(style.paddingTop) + px(style.paddingBottom),
    }
  })

/** Many chips: two rows of them show, no more, and the rest scroll. */
async function expectTwoRowsThatScroll(group: Locator) {
  const box = await chipBox(group)
  expect(box.overflowY).toBe('auto')
  expect(box.client).toBeLessThanOrEqual(Math.ceil(box.twoRows))
  expect(box.client).toBeGreaterThanOrEqual(Math.floor(box.twoRows))
  expect(box.scroll).toBeGreaterThan(box.client)
}

/** Scrolls the group to its last chip and presses it: its tag is added and the focus stays in `field`. */
async function addLastChip(group: Locator, field: Locator, scope: Page | Locator) {
  const last = group.getByRole('button').last()
  const name = (await last.getAttribute('aria-label'))!.replace(/^Add tag /, '')
  await last.scrollIntoViewIfNeeded()
  expect((await chipBox(group)).scrollTop).toBeGreaterThan(0)
  await expect(last).toBeInViewport()
  await last.click()
  await expect(scope.getByRole('button', { name: `Remove ${name}` })).toBeVisible()
  await expect(group.getByRole('button', { name: `Add tag ${name}` })).toHaveCount(0)
  await expect(field).toBeFocused()
}

test('many suggested chips stay two rows tall and scroll, in the New ticket dialog and on the ticket', async ({
  page,
  project,
  api,
  human,
}) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
  const created = await api.ticket({ title: 'Untagged' })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const group = dialog.getByRole('group', { name: 'Suggested tags' })
  await expect(group.getByRole('button')).toHaveCount(50)
  await expectTwoRowsThatScroll(group)
  const field = dialog.getByLabel('Tags (optional)')
  await field.click()
  await addLastChip(group, field, dialog)
  await expect(group.getByRole('button')).toHaveCount(49)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.goto(`/projects/${project.id}/features/${created.id}`)
  await page.getByRole('button', { name: '+ tags' }).click()
  const inline = page.getByRole('group', { name: 'Suggested tags' })
  const inlineField = page.getByRole('textbox', { name: 'Tags, comma separated' })
  await expect(inline.getByRole('button')).toHaveCount(50)
  await expectTwoRowsThatScroll(inline)
  await expect(inlineField).toBeFocused()
  await addLastChip(inline, inlineField, page)
  await inlineField.press('Enter')
  await expect.poll(async () => (await api.getTicket(created.id)).tags).toEqual(['Module 50'])
})

test('a few suggested chips take their own height, with no scroll', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features?view=board`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const group = page.getByRole('dialog').getByRole('group', { name: 'Suggested tags' })
  await expect(group.getByRole('button')).toHaveText(DEFAULTS)
  const box = await chipBox(group)
  expect(box.scroll).toBe(box.client)
  // As tall as the rows its chips take and its padding, no room left empty.
  const rows = await group.evaluate((el) => {
    const style = getComputedStyle(el)
    const rects = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
    const top = Math.min(...rects.map((r) => r.top))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    return bottom - top + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  })
  expect(Math.abs(box.client - rows)).toBeLessThanOrEqual(1)
  expect(box.client).toBeLessThanOrEqual(Math.ceil(box.twoRows))
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

test('a tag spelled like a placeholder value is filtered on as any other', async ({ page, project, api }) => {
  await api.ticket({ title: 'Odd tag', status: 'todo', tags: ['__all__'] })
  await api.ticket({ title: 'Plain', status: 'todo' })
  await page.goto(`/projects/${project.id}/features?view=list`)
  const filter = page.getByRole('combobox', { name: 'Filter by tag' })
  const shown = filter.locator('[data-slot="combobox-value"]')
  await expect(shown).toHaveText('All tags')
  await filter.click()
  await page.getByRole('option', { name: '__all__' }).click()
  await expect(page).toHaveURL(/[?&]tag=__all__/)
  await expect(shown).toHaveText('__all__')
  await expect(page.getByText('Plain')).toHaveCount(0)
  await expect(page.getByText('Odd tag')).toBeVisible()

  await filter.click()
  await page.getByRole('option', { name: 'All tags' }).click()
  await expect(page).not.toHaveURL(/[?&]tag=/)
  await expect(shown).toHaveText('All tags')
  await expect(page.getByText('Plain')).toBeVisible()
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

  test('many suggested chips stay two rows tall and scroll, without a sideways scroll', async ({
    page,
    project,
    human,
  }) => {
    await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: MANY } }))
    await page.goto(`/projects/${project.id}/features?view=board`)
    await page.getByRole('button', { name: 'New ticket' }).click()
    const dialog = page.getByRole('dialog')
    const group = dialog.getByRole('group', { name: 'Suggested tags' })
    await expect(group.getByRole('button')).toHaveCount(50)
    await expectTwoRowsThatScroll(group)
    expect(await scrollsSideways(page)).toBe(false)
    const last = group.getByRole('button').last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    await last.tap()
    await expect(dialog.getByRole('button', { name: 'Remove Module 50' })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
  })
})
