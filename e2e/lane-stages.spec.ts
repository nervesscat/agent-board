import type { TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('a lane is judged by its stage: no approve or disapprove on it or on its parent’s Lanes card', async ({
  page,
  project,
  human,
  api,
}) => {
  const parent: TicketFull = await api.ticket({ title: 'Parent with lanes', status: 'in_progress' })
  const lane = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Judged lane', parentId: parent.id, status: 'review' },
    }),
  )

  await page.goto(`/projects/${project.id}/features/${parent.id}?verdict=approved`)
  await expect(page.getByRole('heading', { name: 'Lanes' })).toBeVisible()
  await expect(page.getByText('Judged lane')).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Approve|Disapprove)/ })).toHaveCount(0)
  await expect(page.getByText(/\d+ approved|disapproved|No call/)).toHaveCount(0)

  await page.goto(`/projects/${project.id}/features/${lane.id}`)
  await expect(page.getByText('Judged lane').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Approve|Disapprove)/ })).toHaveCount(0)

  // The server refuses a call on it as well.
  const res = await human.put(`/api/tickets/${lane.id}/approval`, { data: { verdict: 'approved' } })
  expect(res.status()).toBe(409)
})
