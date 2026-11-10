import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const box = (page: Page) => page.getByRole('combobox', { name: 'Search the board' })
const searchButton = (page: Page) => page.getByRole('button', { name: 'Search the board' })

/** Opens the palette from the keyboard, as Ctrl+F does on every board page. */
async function openPalette(page: Page) {
  await page.keyboard.press('Control+f')
  await expect(box(page)).toBeVisible()
  await expect(box(page)).toBeFocused()
}

test('Ctrl+F opens the palette, a ticket number finds its ticket, Enter opens it, Esc gives the focus back', async ({
  page,
  api,
  project,
}) => {
  const ticket = await api.ticket({ title: 'Kiwi release checklist', status: 'in_progress' })
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByRole('heading', { name: 'Ongoing features' })).toBeVisible()

  // From the header button's focus, Ctrl+F opens over the page instead of the browser's find.
  await searchButton(page).focus()
  await openPalette(page)
  await expect(page.getByRole('dialog', { name: 'Search the board' })).toBeVisible()

  await box(page).fill(`#${ticket.id}`)
  const found = page.getByRole('option').filter({ hasText: `#${ticket.id}` })
  await expect(found).toContainText('Kiwi release checklist')
  // The ticket's stage comes with it.
  await expect(found).toContainText('In progress')
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${ticket.id}$`))
  await expect(page.getByRole('heading', { name: /Kiwi release checklist/ })).toBeVisible()

  // Escape closes and hands the focus back where it was.
  await searchButton(page).focus()
  await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(box(page)).toBeHidden()
  await expect(searchButton(page)).toBeFocused()
})

test('pages, settings and actions are searchable, recents come back when the box is empty, and no match says so', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await openPalette(page)

  // A settings section deep-links to its place on the Settings page.
  await box(page).fill('stages')
  const stages = page.getByRole('option').filter({ hasText: 'Stages' }).first()
  await expect(stages).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/settings#stages$`))
  await expect(page.locator('#stages')).toBeInViewport()

  // Opened again with nothing typed, the last pick is first.
  await openPalette(page)
  await expect(page.getByText('Recent', { exact: true })).toBeVisible()
  await expect(page.getByRole('option').first()).toContainText('Stages')
  await page.keyboard.press('Escape')

  // An action: New ticket opens the dialog the button opens.
  await openPalette(page)
  await box(page).fill('new ticket')
  await expect(page.getByRole('option').filter({ hasText: 'New ticket' }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'New ticket' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'New ticket' })).toBeHidden()

  // Nothing found is said, not an empty box.
  await openPalette(page)
  await box(page).fill('zzqq no such thing')
  await expect(page.getByText('No matches for “zzqq no such thing”.')).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the header button opens the palette and a ticket number lands on its ticket', async ({
    page,
    api,
    project,
  }) => {
    const ticket = await api.ticket({ title: 'Phone palette ticket', status: 'todo' })
    await page.goto(`/projects/${project.id}/features`)
    await searchButton(page).tap()

    await expect(box(page)).toBeVisible()
    await box(page).fill(String(ticket.id))
    const found = page.getByRole('option').filter({ hasText: `#${ticket.id}` })
    await expect(found).toContainText('Phone palette ticket')
    await expect(found).toHaveAttribute('aria-selected', 'true')
    await box(page).press('Enter')

    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${ticket.id}$`))
    await expect(page.getByRole('heading', { name: /Phone palette ticket/ })).toBeVisible()
  })
})
