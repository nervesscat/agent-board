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

test('on an Ongoing features card the time shares the icon and tags row, with no row below it', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({
    title: 'Time on the icon row',
    status: 'in_progress',
    tags: ['Ongoing features', 'UI'],
  })
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Which row?',
        options: [
          { label: 'Yes', detail: 'Keep it', recommended: true },
          { label: 'No', detail: 'Drop it' },
        ],
      },
    }),
  )
  await page.goto(`/projects/${project.id}/features`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Time on the icon row`) })
  const icon = card.getByTestId('work-line')
  const tag = card.getByText('Ongoing features', { exact: true })
  const time = card.getByTestId('card-time')
  await expect(icon).toHaveAttribute('data-state', 'waiting')
  const [i, g, m] = [await icon.boundingBox(), await tag.boundingBox(), await time.boundingBox()]
  expect(i && g && m).toBeTruthy()
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2
  // The time is level with the icon and the tag, and to the tag's right.
  expect(Math.abs(mid(m!) - mid(i!))).toBeLessThan(i!.height)
  expect(Math.abs(mid(m!) - mid(g!))).toBeLessThan(g!.height)
  expect(m!.x).toBeGreaterThan(g!.x + g!.width - 1)
  // One row holds the icon, the tags and the time: the time's own row is the icon's.
  const row = time.locator('xpath=..')
  await expect(row.getByTestId('work-line')).toHaveCount(1)
  // No empty row under it: the next thing on the card (its progress bar) starts right below that row.
  const [r, next] = [
    await row.boundingBox(),
    await row.locator('xpath=following-sibling::*[1]').boundingBox(),
  ]
  expect(r && next).toBeTruthy()
  expect(next!.y - (r!.y + r!.height)).toBeLessThan(i!.height)
})
