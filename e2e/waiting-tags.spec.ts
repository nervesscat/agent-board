import { expect, ok, test } from './fixtures'

test('an open decision on an Ongoing features card shows the waiting-on-you state, not a decision badge', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Pick a cache', status: 'in_progress' })
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Which cache should it use?',
        options: [
          { label: 'Memory', detail: 'Lost on restart' },
          { label: 'Disk', detail: 'Survives restart', recommended: true },
        ],
      },
    }),
  )
  expect((await api.getTicket(t.id)).status).toBe('blocked')

  await page.goto(`/projects/${project.id}/features`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Pick a cache`) })
  // The hand icon's state stays on the card (icon only, no text); the decision badge is gone.
  await expect(card.getByTestId('work-line')).toHaveAttribute('data-state', 'waiting')
  await expect(card).not.toContainText('decision needed')
  await expect(card).not.toContainText('decisions needed')
})
