import type { TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('deleting a lane asks once, and the parent it returns to asks nothing more', async ({
  page,
  project,
  human,
  api,
}) => {
  const parent: TicketFull = await api.ticket({ title: 'A parent with a lane', status: 'in_progress' })
  const lane = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'The lane', parentId: parent.id } }),
  )

  await page.goto(`/projects/${project.id}/features/${lane.id}`)
  const trash = page.locator('header').locator('button:has(svg.trash-icon)')
  await trash.click()
  const first = page.getByRole('alertdialog')
  await expect(first.getByText('Delete this ticket?')).toBeVisible()
  await first.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${parent.id}$`))
  await expect(page.getByText('A parent with a lane').first()).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})
