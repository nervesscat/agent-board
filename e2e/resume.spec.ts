import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { startedAt, yesterdayNoon } from './db'
import { expect, ok, section, test } from './fixtures'

test('writes a resume note from the template; it shows with who and when, and posts a handoff', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Parse the config', status: 'in_progress' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  await page.getByRole('button', { name: /^Leave a resume note/ }).click()
  const card = page.getByRole('region', { name: 'Resume here' })
  const editor = card.getByRole('textbox', { name: 'Resume note' })
  await expect(editor).toBeFocused()
  for (const heading of ['State:', 'Done so far:', 'Next steps:', 'Open questions / blockers:'])
    await expect(editor.locator('strong', { hasText: heading })).toBeVisible()

  // The template as it comes is not a note.
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('fill in the template before saving it')).toBeVisible()
  await expect(editor).toBeVisible()

  // Fill in the first line: "(one line)" becomes where the work stands.
  await editor.getByText('(one line)').click()
  await page.keyboard.press('End')
  for (let i = 0; i < '(one line)'.length; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('parser done, tests next')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(editor).toBeHidden()

  await expect(card).toContainText('State: parser done, tests next')
  await expect(card.getByText(/^by enrique/)).toContainText('just now')
  // Saving it also posted it to the feed, marked as a resume note.
  const handoff = page.getByRole('article').filter({ hasText: 'resume note' })
  await expect(handoff).toHaveCount(1)
  await expect(handoff).toContainText('State: parser done, tests next')

  const saved = await api.getTicket(t.id)
  expect(saved.resume).toMatchObject({ by: 'enrique', noHandoff: false, stale: false })
  expect(saved.resume.note).toMatch(/^\*\*State:\*\* parser done, tests next/)
  expect(saved.updates).toMatchObject([{ handoff: true, author: 'enrique', progress: true }])
})

test('an agent writes the resume note as one of the project agents; the human cannot use as', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const as = DEFAULT_AGENT_NAMES[0]
  const t = await api.ticket({ title: 'Handed over by an agent', status: 'in_progress' })

  const refused = await human.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Mine', as } })
  expect(refused.status()).toBe(403)

  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: '**State:** migrations written', as } }))
  const saved = await api.getTicket(t.id)
  expect(saved.resume).toMatchObject({ by: as, note: '**State:** migrations written' })
  expect(saved.updates).toMatchObject([{ handoff: true, author: as, via: 'claude' }])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Resume here' })
  await expect(card).toContainText('State: migrations written')
  await expect(card.getByText(/^by /)).toContainText(as)
})

test('a ticket carried over from yesterday without a note shows no handoff until one is written', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Carried over', status: 'in_progress' })
  startedAt(t.id, yesterdayNoon())
  expect((await api.getTicket(t.id)).resume).toMatchObject({ noHandoff: true, day: 2, at: null })

  await page.goto(`/projects/${project.id}/features?view=board`)
  const boardCard = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Carried over/ })
  await expect(boardCard).toContainText('no handoff')
  await expect(boardCard).toContainText('day 2')

  await boardCard.click()
  const card = page.getByRole('region', { name: 'Resume here' })
  await expect(card).toContainText('No handoff yet')
  await expect(card).toContainText('day 2 in progress')

  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Halfway through the parser' } }))
  await page.reload()
  await expect(card).toContainText('Halfway through the parser')
  await expect(card).not.toContainText('No handoff yet')

  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(boardCard).not.toContainText('no handoff')
  await expect(boardCard).toContainText('day 2')
  // The Overview's Carrying over shows the note where the last session left off.
  await page.goto(`/projects/${project.id}`)
  const carried = section(page, 'Carrying over').getByRole('listitem').filter({ hasText: 'Carried over' })
  await expect(carried).toContainText('Halfway through the parser — claude')
  await expect(carried.getByText('no handoff')).toHaveCount(0)
})
