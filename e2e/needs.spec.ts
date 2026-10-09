import type { Locator, Page } from '@playwright/test'

import type { TicketFull, TicketGit } from '#/lib/api'
import { commitFile, git } from './env'
import { expect, ok, test } from './fixtures'

/**
 * Drags a board card onto a column: the drag events a browser sends, with one DataTransfer (the Done
 * column sits beyond the edge of the board's sideways scroller, out of the mouse's reach).
 */
async function drag(page: Page, card: Locator, column: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await card.dispatchEvent('dragstart', { dataTransfer })
  await column.dispatchEvent('dragenter', { dataTransfer })
  await column.dispatchEvent('dragover', { dataTransfer })
  await column.dispatchEvent('drop', { dataTransfer })
  await card.dispatchEvent('dragend', { dataTransfer })
}

test('a ticket that needs another one merged first is held out of Done; the human can mark it done anyway', async ({
  page,
  api,
  project,
}) => {
  const base = await api.ticket({ title: 'Foundation', status: 'todo' })
  const t = await api.ticket({ title: 'Built on it', status: 'in_progress' })
  await page.goto(`/projects/${project.id}/features/${t.id}`)

  // Add the need in Details.
  const details = page.getByRole('region', { name: 'Details' })
  await details.locator('#needs').click()
  await page.getByRole('option', { name: `#${base.id} Foundation` }).click()
  await expect(details.getByRole('listitem').filter({ hasText: `#${base.id} Foundation` })).toBeVisible()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · not merged yet` })).toBeVisible()
  await expect
    .poll(async () => (await api.getTicket(t.id)).needs)
    .toMatchObject([{ id: base.id, merged: false }])

  // The board card says what it waits on.
  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Built on it/ })
  await expect(card).toContainText(`needs #${base.id}`)

  // Dragged to Done, it is refused and goes back to its column.
  await drag(page, card, page.locator('[data-column="done"]'))
  const refusal = page.locator('[data-sonner-toast]').filter({ hasText: `needs #${base.id}` })
  await expect(refusal).toBeVisible()
  await expect(refusal.getByRole('button', { name: 'Mark done anyway' })).toBeVisible()
  await expect(card).toBeVisible()
  await expect(page.locator('[data-column="done"]').getByRole('link', { name: /Built on it/ })).toHaveCount(0)
  expect((await api.getTicket(t.id)).status).toBe('in_progress')

  // On its page (loaded afresh, so the board's toast is gone), moving it to Done is refused the same
  // way, and the human can mark it done anyway.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'Done', exact: true }).click()
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: `needs #${base.id}` })
  await expect(toast).toBeVisible()
  expect((await api.getTicket(t.id)).status).toBe('in_progress')
  await toast.getByRole('button', { name: 'Mark done anyway' }).click()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('done')
  await expect(page.getByRole('combobox').filter({ hasText: 'Done' })).toBeVisible()
})

test('an agent cannot move a ticket past what it needs, with force or without', async ({
  api,
  human,
  agent,
}) => {
  const base = await api.ticket({ title: 'Foundation', status: 'todo' })
  const t = await api.ticket({ title: 'Built on it', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { needs: [base.id] } }))

  const refused = await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } })
  expect(refused.status()).toBe(409)
  expect(await refused.json()).toMatchObject({ code: 'needs' })
  const forced = await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done', force: true } })
  expect(forced.status()).toBe(403)
  expect((await api.getTicket(t.id)).status).toBe('in_progress')

  // Once what it needs is done (it has no branch to merge), the move goes through.
  await ok(human.patch(`/api/tickets/${base.id}`, { data: { status: 'done' } }))
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
})

test('a branch that holds another ticket’s unmerged work suggests the need; once merged, it is met', async ({
  page,
  project,
  human,
  agent,
}) => {
  // In the run's repo: a base for B, A's branch one commit past main, and B's branch built on A's.
  const name = (what: string) => `e2e-${project.id}-${what}`
  git('branch', name('base'), 'main')
  const a = commitFile('main', 'foundation.txt', 'the foundation\n', 'the foundation')
  git('update-ref', `refs/heads/${name('a')}`, a)
  git(
    'update-ref',
    `refs/heads/${name('b')}`,
    commitFile(a, 'foundation.txt', 'built on it\n', 'built on it'),
  )
  const ticket = (data: Record<string, unknown>) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { status: 'in_progress', ...data } }),
    )
  const base = await ticket({ title: 'Foundation', branch: name('a') })
  const t = await ticket({ title: 'Built on it', branch: name('b'), baseBranch: name('base') })
  // The board reads the checkout's refs a few seconds at a time: wait until it sees these branches.
  await expect
    .poll(async () => (await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))).includes)
    .toEqual([base.id])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  const suggestion = details.getByText('Includes unmerged work from').locator('..').locator('..')
  await expect(suggestion.getByRole('link', { name: `#${base.id} Foundation` })).toBeVisible()
  await suggestion.getByRole('button', { name: 'Add as a need' }).click()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · not merged yet` })).toBeVisible()
  await expect(details.getByText('Includes unmerged work from')).toHaveCount(0)
  expect((await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } })).status()).toBe(409)

  // A's work lands in B's base: the need is met.
  git('update-ref', `refs/heads/${name('base')}`, a)
  await page.reload()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · merged` })).toBeVisible()
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(
    page.locator('[data-column="in_progress"]').getByRole('link', { name: /Built on it/ }),
  ).not.toContainText('needs #')
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
})
