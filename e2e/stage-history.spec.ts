import type { TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { expect, ok, test } from './fixtures'

/**
 * The ticket page's Stage history: each move with its stages, who made it and how, the human's
 * send-back marked with its reason (picked on the page), and the merge time once the PR was merged.
 */

test('the ticket page lists the moves with who and how, the send-back with its reason, and the merge time', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'History on the page' } }),
  )
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'in_progress' } }))
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'in_progress' } }))
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Stage history' })
  await expect(card.getByRole('heading', { name: 'Stage history' })).toBeVisible()
  await expect(card.getByTestId('send-back-count')).toHaveText('Send-backs: 1')
  const rows = card.getByRole('list', { name: 'Moves between stages' }).getByRole('listitem')
  await expect(rows).toHaveCount(6)
  await expect(rows.nth(0)).toContainText('Created in To do')
  await expect(rows.nth(0)).toContainText(/moved by \S+/)
  await expect(rows.nth(1)).toContainText('To do → In progress')
  await expect(rows.nth(1)).toContainText(/moved by the agent \S+/)
  await expect(rows.nth(3)).toContainText('In review → In progress')
  await expect(rows.nth(3)).toContainText('Sent back')
  await expect(rows.nth(5)).toContainText('In review → Approved')
  await expect(rows.nth(5)).toContainText(/by the verdict of \S+/)
  await expect(card.getByText('Sent back', { exact: true })).toHaveCount(1)
  await expect(card.getByTestId('merged-at')).toHaveCount(0)

  // The human picks the reason on the card; the ticket keeps it.
  const reason = rows.nth(3).getByRole('combobox', { name: 'Send-back reason' })
  await expect(reason).toHaveText(/No reason/)
  await reason.click()
  await page.getByRole('option', { name: 'Changed mind' }).click()
  await expect(reason).toHaveText(/Changed mind/)
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).sendBacks[0]?.reason)
    .toBe('changed-mind')

  // Merged: the time GitHub gave shows with the history.
  inDatabase((db) =>
    db.prepare('update tickets set merged_at = ? where id = ?').run('2026-10-02T08:30:00.000Z', t.id),
  )
  await page.reload()
  await expect(card.getByTestId('merged-at')).toContainText(/^Merged .*2026/)
})

test('a ticket with no recorded moves shows an empty history', async ({ page, project, human }) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'No history' } }),
  )
  inDatabase((db) => db.prepare('delete from ticket_events where ticket_id = ?').run(t.id))
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Stage history' })
  await expect(card.getByText('No stage moves recorded.')).toBeVisible()
  await expect(card.getByTestId('send-back-count')).toHaveText('Send-backs: 0')
})
