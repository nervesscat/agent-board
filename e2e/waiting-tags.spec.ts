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

test('a ticket tag sits on the same row as its work-state icon, on an Ongoing features card and in a list row', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({
    title: 'Tag beside the icon',
    status: 'in_progress',
    tags: ['Ongoing features'],
  })
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Which tag?',
        options: [
          { label: 'Yes', detail: 'Keep it', recommended: true },
          { label: 'No', detail: 'Drop it' },
        ],
      },
    }),
  )
  const named = new RegExp(`#${t.id} Tag beside the icon`)
  const sameRow = async (name: string) => {
    const card = page.getByRole('link', { name: named })
    const icon = card.getByTestId('work-line')
    const tag = card.getByText('Ongoing features', { exact: true })
    await expect(icon).toHaveAttribute('data-state', 'waiting')
    const [i, g] = [await icon.boundingBox(), await tag.boundingBox()]
    expect(i && g, name).toBeTruthy()
    // The tag's middle is level with the icon's, and it sits to the icon's right.
    expect(Math.abs(g!.y + g!.height / 2 - (i!.y + i!.height / 2)), name).toBeLessThan(i!.height)
    expect(g!.x, name).toBeGreaterThan(i!.x + i!.width - 1)
  }

  await page.goto(`/projects/${project.id}/features`)
  await sameRow('card')
  await page.getByRole('tab', { name: 'List' }).click()
  await sameRow('list row')
})
