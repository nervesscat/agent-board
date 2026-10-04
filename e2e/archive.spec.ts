import type { TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('archives every ticket in Done, lists them under Archived, restores one', async ({
  page,
  api,
  human,
  project,
}) => {
  const shipped = await api.ticket({ title: 'Shipped one', status: 'done' })
  await api.ticket({ title: 'Shipped two', status: 'done' })
  await api.ticket({ title: 'Still open', status: 'todo' })

  await page.goto(`/projects/${project.id}/features`)
  const done = page.locator('[data-column="done"]')
  await expect(done.getByRole('link')).toHaveCount(2)

  await page.getByRole('button', { name: 'Archive all' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Archive 2 tickets?')
  await confirm.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByText('Archived 2 tickets')).toBeVisible()
  await expect(done.getByRole('link')).toHaveCount(0)
  await expect(page.locator('[data-column="todo"]').getByRole('link', { name: /Still open/ })).toBeVisible()

  await page.getByRole('tab', { name: /Archived/ }).click()
  await expect(page.getByRole('tab', { name: /Archived/ })).toContainText('(2)')
  const row = page.getByRole('listitem').filter({ hasText: 'Shipped one' })
  await expect(row).toContainText('archived')
  await expect(row).toContainText('enrique')
  await expect(page.getByRole('listitem').filter({ hasText: 'Shipped two' })).toBeVisible()

  await row.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText(`Restored #${shipped.id} to the board`)).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /Archived/ })).toContainText('(1)')

  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(done.getByRole('link', { name: /Shipped one/ })).toBeVisible()
  await expect(done.getByRole('link')).toHaveCount(1)

  const archived = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?archived=only`))
  expect(archived.map((t) => t.title)).toEqual(['Shipped two'])
})

test('archiving is the human’s: an agent gets 403', async ({ api, agent, project }) => {
  const t = await api.ticket({ title: 'Done by an agent', status: 'done' })
  expect((await agent.post(`/api/tickets/${t.id}/archive`)).status()).toBe(403)
  expect(
    (await agent.post(`/api/projects/${project.id}/tickets/archive`, { data: { status: 'done' } })).status(),
  ).toBe(403)
})
