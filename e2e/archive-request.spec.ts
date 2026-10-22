import type { TicketRow } from '#/lib/api'
import { HUMAN } from './env'
import { expect, ok, test } from './fixtures'

test('an agent asks to archive, the human answers Archive on the card, and the tickets come off the board', async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  const shipped = await api.ticket({ title: 'Shipped feature', status: 'done' })
  const lane = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Shipped lane', parentId: shipped.id, status: 'done' },
    }),
  )
  const dropped = await api.ticket({ title: 'Dropped idea', status: 'cancelled' })
  await ok(
    agent.post(`/api/projects/${project.id}/tickets/archive-request`, {
      data: { ticketIds: [shipped.id, dropped.id] },
    }),
  )
  // Asking alone archives nothing.
  expect((await api.getTicket(shipped.id)).archivedAt).toBeNull()

  await page.goto(`/projects/${project.id}/features/${shipped.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  await expect(card).toContainText('Your decision is needed')
  await expect(page.getByText(`Archive #${shipped.id}, #${dropped.id}?`)).toBeVisible()
  await card.getByRole('radio', { name: /^Archive/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(
    page.getByText(`Archived #${shipped.id}, #${dropped.id}: off the board, under Archived`),
  ).toBeVisible()
  await expect(card).toContainText(`decided by ${HUMAN}`)
  // The page shows the ticket as archived, with the human's Restore.
  await expect(page.getByText('Archived', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible()

  for (const id of [shipped.id, lane.id, dropped.id])
    expect(await api.getTicket(id)).toMatchObject({ archivedAt: expect.any(String), archivedBy: HUMAN })
  expect((await api.getTicket(shipped.id)).status).toBe('done')
  const archived = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?archived=only`))
  expect(archived.map((t) => t.id).sort()).toEqual([shipped.id, lane.id, dropped.id].sort())

  await page.goto(`/projects/${project.id}/features`)
  await expect(page.locator('[data-column="done"]').getByRole('link')).toHaveCount(0)
})

test('an agent asks to archive, the human answers Keep, and nothing changes', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Keep this one', status: 'done' })
  await ok(agent.post(`/api/projects/${project.id}/tickets/archive-request`, { data: { ticketIds: [t.id] } }))

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  await card.getByRole('radio', { name: /^Keep/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(card).toContainText(`decided by ${HUMAN}`)
  expect(await api.getTicket(t.id)).toMatchObject({ archivedAt: null, status: 'done' })

  await page.goto(`/projects/${project.id}/features`)
  await expect(
    page.locator('[data-column="done"]').getByRole('link', { name: /Keep this one/ }),
  ).toBeVisible()
})

test('an agent cannot archive without the human confirming', async ({ api, agent, project }) => {
  const t = await api.ticket({ title: 'Finished', status: 'done' })
  const open = await api.ticket({ title: 'Still going', status: 'in_progress' })
  const asked = await ok<{ id: number }>(
    agent.post(`/api/projects/${project.id}/tickets/archive-request`, { data: { ticketIds: [t.id] } }),
  )
  expect((await agent.post(`/api/tickets/${t.id}/archive`)).status()).toBe(403)
  expect(
    (await agent.post(`/api/projects/${project.id}/tickets/archive`, { data: { status: 'done' } })).status(),
  ).toBe(403)
  expect((await agent.put(`/api/updates/${asked.id}/decision`, { data: { option: 0 } })).status()).toBe(403)
  expect((await api.getTicket(t.id)).archivedAt).toBeNull()

  // A ticket that is not finished is refused, and the error says why.
  const refused = await agent.post(`/api/projects/${project.id}/tickets/archive-request`, {
    data: { ticketIds: [open.id] },
  })
  expect(refused.status()).toBe(409)
  expect(((await refused.json()) as { error: string }).error).toContain(`#${open.id} is in In progress`)
})
