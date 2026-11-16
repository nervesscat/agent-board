import { expect, ok, test } from './fixtures'

/**
 * Approved is a default stage, right after In review: the human approved the ticket and the merge is
 * left. The board draws it like any column, and the human's approval moves a ticket there; taking the
 * call back returns it to In review.
 */
test('the board has an Approved column after In review, and the human approval moves a ticket there and back', async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await api.ticket({ title: 'Ship the copy', status: 'review' })

  await page.goto(`/projects/${project.id}/features`)
  const approved = page.locator('[data-column="approved"]')
  await expect(approved).toBeVisible()
  const columns = await page
    .locator('[data-column]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-column')))
  expect(columns.indexOf('approved')).toBe(columns.indexOf('review') + 1)

  // The human's approval moves it, without a drag or an agent.
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  await page.reload()
  await expect(approved.getByRole('link', { name: /Ship the copy/ })).toBeVisible()
  await expect(page.locator('[data-column="review"]').getByText('Ship the copy')).toHaveCount(0)

  // The ticket page names the stage, and taking the approval back returns it to In review.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByRole('combobox').filter({ hasText: 'Approved' })).toBeVisible()
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: null } }))
  await page.reload()
  await expect(page.getByRole('combobox').filter({ hasText: 'In review' })).toBeVisible()
})
