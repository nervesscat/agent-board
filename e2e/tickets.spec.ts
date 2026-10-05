import type { TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('creates a ticket from the New ticket dialog', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Fix the login form')
  await dialog
    .getByRole('textbox', { name: 'Instructions' })
    .fill('The submit button does nothing on Safari.')
  await dialog.getByLabel('Initial tasks, one per line').fill('Reproduce it\nFix it')
  await dialog.getByLabel('Tags (optional)').fill('High, Forms')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  // A new ticket starts in To do.
  const card = page.locator('[data-column="todo"]').getByRole('link', { name: /Fix the login form/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('High')
  await expect(card).toContainText('0/2')

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(row).toMatchObject({ title: 'Fix the login form', status: 'todo', createdBy: 'enrique' })
  expect(row!.tags.sort()).toEqual(['Forms', 'High'])
  const full = await ok<{ body: string; tasks: { text: string }[] }>(human.get(`/api/tickets/${row!.id}`))
  expect(full.body).toBe('The submit button does nothing on Safari.')
  expect(full.tasks.map((t) => t.text)).toEqual(['Reproduce it', 'Fix it'])

  await card.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${row!.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fix the login form')
})

test('edits the title, tags and instructions in place', async ({ page, api }) => {
  const t = await api.ticket({ title: 'Old title', body: 'Old instructions.' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // Title: click it, type, Enter.
  await page.getByRole('button', { name: 'Old title' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('New title')
  await page.getByRole('textbox', { name: 'Title' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('New title')

  // Tags: "+ tags", comma separated, Enter.
  await page.getByRole('button', { name: '+ tags' }).click()
  await page.getByRole('textbox', { name: 'Tags, comma separated' }).fill('Cosmetic, Forms')
  await page.getByRole('textbox', { name: 'Tags, comma separated' }).press('Enter')
  await expect(page.getByTitle('Click to edit the tags')).toContainText('Cosmetic')

  // Instructions: the rich editor, with a toolbar button, saved with Ctrl+Enter.
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await instructions.getByRole('button', { name: 'edit' }).click()
  const editor = instructions.getByRole('textbox', { name: 'Instructions' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Use the ')
  await instructions.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('new')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(editor).toBeHidden()
  await expect(instructions.locator('strong')).toHaveText('new')

  await expect
    .poll(async () => {
      const saved = await api.getTicket(t.id)
      return { title: saved.title, tags: [...saved.tags].sort(), body: saved.body }
    })
    .toEqual({ title: 'New title', tags: ['Cosmetic', 'Forms'], body: 'Use the **new**' })
})

test('steps to the previous and next ticket in a stage, by button and by [ and ]', async ({
  page,
  api,
  human,
  project,
}) => {
  for (const title of ['First', 'Second', 'Third']) {
    await api.ticket({ title, status: 'in_progress' })
    // Distinct update times, so the column's order (last updated first) is certain.
    await new Promise((r) => setTimeout(r, 20))
  }
  await api.ticket({ title: 'Elsewhere', status: 'todo' })
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const column = rows
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  expect(column.map((r) => r.title)).toEqual(['Third', 'Second', 'First'])
  const [third, second, first] = column
  const url = (id: number) => new RegExp(`/projects/${project.id}/features/${id}$`)

  await page.goto(`/projects/${project.id}/features/${second!.id}`)
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()

  await page.getByRole('link', { name: 'Next ticket in In progress' }).click()
  await expect(page).toHaveURL(url(first!.id))
  await expect(page.getByText('3 of 3 in In progress')).toBeVisible()
  // The last one has no next.
  await expect(page.getByRole('link', { name: 'Next ticket in In progress' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Previous ticket in In progress' }).click()
  await expect(page).toHaveURL(url(second!.id))

  await page.keyboard.press('[')
  await expect(page).toHaveURL(url(third!.id))
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Previous ticket in In progress' })).toHaveCount(0)

  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(second!.id))

  // While typing, [ and ] are text.
  await page.getByRole('textbox', { name: 'New post' }).click()
  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByRole('textbox', { name: 'New post' })).toHaveText(']')
})

test('the features view (board or list) survives a reload, kept in the URL and remembered', async ({
  page,
  api,
  project,
}) => {
  await api.ticket({ title: 'Seen either way' })
  const tab = (name: string) => page.getByRole('tab', { name })
  const card = page.locator('[data-column="todo"]').getByRole('link', { name: /Seen either way/ })
  const row = page.getByRole('listitem').filter({ hasText: 'Seen either way' })

  await page.goto(`/projects/${project.id}/features`)
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'true')
  await expect(card).toBeVisible()
  await tab('List').click()
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(row).toBeVisible()

  await page.reload()
  await expect(tab('List')).toHaveAttribute('aria-selected', 'true')
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'false')
  await expect(row).toBeVisible()
  await expect(page.locator('[data-column]')).toHaveCount(0)

  // Without one in the URL, the view this browser remembers comes back, and the URL says so.
  await page.goto(`/projects/${project.id}/features`)
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(tab('List')).toHaveAttribute('aria-selected', 'true')
  await expect(row).toBeVisible()

  // Archived is a visit: it is in the URL, but the next visit without one is back on the list.
  await tab('Archived').click()
  await expect(page).toHaveURL(/[?&]view=archived(&|$)/)
  await page.goto(`/projects/${project.id}/features`)
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(row).toBeVisible()

  // A link that names one wins over what is remembered.
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'true')
  await expect(card).toBeVisible()
})
