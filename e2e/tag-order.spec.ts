import { expect, test } from './fixtures'

test('the suggested tags put the ones used this week first, and the typed text narrows them', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Q1 plan', tags: ['Roadmap'] })
  await api.ticket({ title: 'Q2 plan', tags: ['Roadmap'] })
  await api.ticket({ title: 'Feature work', tags: ['Ongoing features'] })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Stage')).toBeVisible()
  const chips = dialog.getByRole('group', { name: 'Suggested tags' }).getByRole('button')
  const field = dialog.getByLabel('Tags (optional)')

  // Roadmap on two tickets this week, Ongoing features on one, then the rest by name.
  await expect(chips).toHaveText(['Roadmap', 'Ongoing features', 'Bug', 'Implementation', 'Report', 'UI'])

  // A partial tag: only the chips it soft-matches, the letters in order in the name.
  await field.fill('rdm')
  await expect(chips).toHaveText(['Roadmap'])
  await field.fill('ogfe')
  await expect(chips).toHaveText(['Ongoing features'])
  await field.fill('zz')
  await expect(chips).toHaveCount(0)

  // Cleared: the full list is back, in the same order.
  await field.fill('')
  await expect(chips).toHaveText(['Roadmap', 'Ongoing features', 'Bug', 'Implementation', 'Report', 'UI'])
})
