import { AGENT, HUMAN } from './env'
import { expect, expectTooltip, ok, test } from './fixtures'

test("the orchestrator relays the human's chat answer, and the card shows it as decided in chat", async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Pick a storage', status: 'in_progress' })
  const asked = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Where should uploads live?',
        options: [
          { label: 'Local disk', detail: 'Nothing to run' },
          { label: 'MinIO', detail: 'Survives a reinstall', recommended: true },
        ],
      },
    }),
  )

  // The human answered in the chat, and the orchestrator records it with their words as they gave them.
  const words = 'MinIO, and **not bold** here'
  const relayed = await ok<{ decidedBy: string; relayedBy: string; relayedText: string }>(
    agent.post(`/api/updates/${asked.id}/decision/relay`, { data: { option: 1, words } }),
  )
  expect(relayed).toMatchObject({ decidedBy: '', relayedBy: AGENT, relayedText: words })
  expect((await api.getTicket(t.id)).status).toBe('in_progress')

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  await expect(card).toContainText('Decided in chat by you')
  await expect(card).toContainText(`relayed by ${AGENT}`)
  // The words exactly as given: plain text, so the Markdown marks show as they are.
  await expect(card).toContainText(`“${words}”`)
  await expect(card.locator('strong')).toHaveCount(0)
  // Nothing without a name: no "decided by" line, no admin badge.
  await expect(card).not.toContainText('decided by')
  await expect(card.getByText('admin', { exact: true })).toHaveCount(0)
  await expectTooltip(
    card.getByText('relayed', { exact: true }),
    'The orchestrator recorded your answer from the chat. Nothing was clicked on the card.',
  )

  // The reply under the card says what was decided, by the orchestrator.
  const replies = await ok<{ author: string; body: string }[]>(
    agent.get(`/api/comments?parentType=update&parentId=${asked.id}`),
  )
  expect(replies).toEqual([
    expect.objectContaining({ author: AGENT, body: `Decided in chat: **MinIO**\n\n${words}` }),
  ])

  // The human changes the answer on the card: the card then shows only their own decision.
  await card.getByRole('button', { name: 'change' }).click()
  await card.getByRole('radio', { name: /Local disk/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(card).toContainText(`decided by ${HUMAN}`)
  await expect(card).not.toContainText('relayed')
  await expect(card).not.toContainText('What you said in chat')
  const after = (await api.getTicket(t.id)).updates.find((u) => u.decision)!
  expect(after).toMatchObject({ decidedOption: 0, decidedBy: HUMAN, relayedBy: '', relayedText: '' })
})

test('a relayed answer with one long run of characters wraps inside the decision card on a phone', async ({
  page,
  api,
  agent,
  project,
}) => {
  const width = 360
  await page.setViewportSize({ width, height: 800 })
  const t = await api.ticket({ title: 'Pick a commit to ship', status: 'in_progress' })
  const asked = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Which commit should ship?',
        options: [
          { label: 'The last commit', detail: 'The newest on the branch' },
          { label: 'Wait', detail: 'Keep the branch as it is' },
        ],
      },
    }),
  )
  // A full commit SHA: 40 characters with no space, so no line can break at a space.
  const words = '4f1c9a7d2e8b0c6a3f5d9e1b7c2a8f0d6e4b3a91'
  await ok(agent.post(`/api/updates/${asked.id}/decision/relay`, { data: { option: 1, words } }))

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  const relayed = card.getByText(`“${words}”`, { exact: true })
  await expect(relayed).toBeVisible()

  // The page does not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  // The words stay inside the card's box on every side.
  const cardBox = await card.boundingBox()
  const wordsBox = await relayed.boundingBox()
  expect(cardBox).not.toBeNull()
  expect(wordsBox).not.toBeNull()
  expect(wordsBox!.x).toBeGreaterThanOrEqual(cardBox!.x)
  expect(wordsBox!.x + wordsBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width)
  expect(wordsBox!.y).toBeGreaterThanOrEqual(cardBox!.y)
  expect(wordsBox!.y + wordsBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height)
})
