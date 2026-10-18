import type { Page } from '@playwright/test'

import type { UpdateRow } from '#/lib/api'
import { expect, expectTooltip, ok, test } from './fixtures'

/** The feed's tabs, and the posts shown under the one that is open, in order. */
const tab = (page: Page, name: 'Main' | 'Agents') =>
  page.getByRole('tablist', { name: 'Feed' }).getByRole('tab', { name: new RegExp(`^${name}`) })
const posts = (page: Page) => page.locator('ol > li article')

test('Main opens first; agents posts wait in Agents with a count of the new ones', async ({
  page,
  api,
  human,
  agent,
}) => {
  const t = await api.ticket({ title: 'Two tabs' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Can it do x?', progress: false } }))
  const step = await ok<UpdateRow>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Built step one.' } }),
  )
  expect(step.tab).toBe('agents')

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true')
  await expect(posts(page)).toHaveCount(1)
  await expect(posts(page).first()).toContainText('Can it do x?')
  // Posted after the human's last post: new, until the tab is opened.
  await expect(tab(page, 'Agents')).toHaveText('Agents1')
  await expectTooltip(tab(page, 'Agents'), /working record/)

  await tab(page, 'Agents').click()
  await expect(posts(page)).toHaveCount(1)
  await expect(posts(page).first()).toContainText('Built step one.')
  await expect(tab(page, 'Agents')).toHaveText('Agents')

  // Seen: after a reload Main opens again, with no count; a newer agent post counts again.
  await page.reload()
  await expect(tab(page, 'Main')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Agents')).toHaveText('Agents')
  await ok(agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Built step two.' } }))
  await page.reload()
  await expect(tab(page, 'Agents')).toHaveText('Agents1')

  // The box posts in the tab that is open.
  await tab(page, 'Agents').click()
  await page.getByRole('textbox', { name: 'New post' }).fill('A note for the agents')
  await page.getByRole('button', { name: 'Post in Agents' }).click()
  await expect(posts(page).first()).toContainText('A note for the agents')
  const full = await api.getTicket(t.id)
  expect(full.updates.find((u) => u.body.includes('A note for the agents'))?.tab).toBe('agents')
})

test("a reply under the human's post brings it to the top of Main", async ({ page, api, human, agent }) => {
  const t = await api.ticket({ title: 'Replies on top' })
  const older = await ok<UpdateRow>(
    human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'First question', progress: false } }),
  )
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Second question', progress: false } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await expect(posts(page).first()).toContainText('Second question')

  // The plan, under the older post: nothing new at the top level.
  await ok(
    agent.post('/api/comments', {
      data: { parentType: 'ticket', parentId: t.id, replyTo: older.id, body: 'Plan: do it this way.' },
    }),
  )
  await page.reload()
  await expect(posts(page)).toHaveCount(2)
  await expect(posts(page).first()).toContainText('First question')
  await expect(posts(page).first().getByRole('button', { name: '1 reply' })).toBeVisible()
})

test('the summary sits on top of Main with its history, and stands in with the latest progress post until written', async ({
  page,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Summed up' })
  await ok(agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'An old hand-off: PR and preview.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const card = page.getByRole('article', { name: 'Summary' })
  await expect(card).toContainText('An old hand-off: PR and preview.')
  await expect(card).toContainText('No summary yet')

  const summary = (body: string, change?: string) =>
    ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body, change } }))
  await summary('Adds x. In review.')
  await summary('Adds x. Round 1 survived.', 'round 1 verdict')
  await summary('Adds x. Preview running.', 'the preview')
  await page.reload()
  await expect(card).toContainText('Adds x. Preview running.')
  await expect(card).not.toContainText('No summary yet')
  await expect(card).toContainText(/updated .*: the preview/)
  await expectTooltip(card.getByText(/updated .*: the preview/), /\d/)
  // It is not repeated in the feed below it.
  await expect(page.locator('ol > li article').filter({ hasText: 'Adds x.' })).toHaveCount(0)

  await card.getByRole('button', { name: 'history (2)' }).click()
  const earlier = card.getByRole('list', { name: 'Earlier versions' }).getByRole('listitem')
  await expect(earlier).toHaveCount(2)
  await expect(earlier.nth(0)).toContainText('round 1 verdict')
  await expect(earlier.nth(0)).toContainText('Adds x. Round 1 survived.')
  await expect(earlier.nth(1)).toContainText('the first version')
  await expect(earlier.nth(1)).toContainText('Adds x. In review.')
  await page
    .locator('section')
    .filter({ has: page.getByRole('tablist', { name: 'Feed' }) })
    .last()
    .screenshot({ path: test.info().outputPath('summary-history.png') })
})

test('a link to a post in Agents opens that tab', async ({ page, api, agent }) => {
  const t = await api.ticket({ title: 'Linked' })
  const step = await ok<UpdateRow>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Deep in agents.' } }),
  )
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${step.id}`)
  await expect(tab(page, 'Agents')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`#post-${step.id}`)).toBeInViewport()
})

test('the summary takes replies like a post: shown on its card, opened by a link, answered from it', async ({
  page,
  api,
  agent,
  human,
}) => {
  const t = await api.ticket({ title: 'Answer the summary' })
  type Summary = { postId: number }
  const first = await ok<Summary>(
    agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'Version one.' } }),
  )
  const old = await ok<{ id: number }>(
    human.post('/api/comments', {
      data: { parentType: 'update', parentId: first.postId, body: 'On version one.' },
    }),
  )
  const now = await ok<Summary>(
    agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'Version two.', change: 'the second' } }),
  )
  const reply = await ok<{ id: number }>(
    agent.post('/api/comments', {
      data: { parentType: 'update', parentId: now.postId, body: 'Why the change?' },
    }),
  )

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const card = page.getByRole('article', { name: 'Summary' })
  const actions = card.getByRole('group', { name: 'Summary actions' }).first()
  await expect(actions.getByRole('button', { name: '1 reply', exact: true })).toBeVisible()
  await expectTooltip(actions.getByRole('button', { name: '1 reply', exact: true }), 'Show 1 reply')
  await actions.getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card.getByText('Why the change?')).toBeVisible()

  // Answered from the card: the reply stays under this version.
  await card.getByRole('textbox', { name: 'Reply' }).fill('Because of the review.')
  await card.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(card.getByText('Because of the review.')).toBeVisible()
  const thread = await ok<{ body: string }[]>(
    human.get(`/api/comments?parentType=update&parentId=${now.postId}`),
  )
  expect(thread.map((c) => c.body)).toEqual(['Why the change?', 'Because of the review.'])

  // A link to a reply opens its thread on the card; one under an earlier version opens the history.
  // Each opened afresh, as a link from another page is.
  await page.goto(`/projects/${t.projectId}/features`)
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${now.postId}-reply-${reply.id}`)
  await expect(card.getByText('Why the change?')).toBeVisible()
  await page.goto(`/projects/${t.projectId}/features`)
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${first.postId}-reply-${old.id}`)
  const earlier = card.getByRole('list', { name: 'Earlier versions' })
  await expect(earlier.getByText('On version one.')).toBeVisible()
  await expect(card.getByText('On version one.')).toBeInViewport()
})

test('a rewrite of the summary drops a reply begun under the old version: nothing goes to the new one by mistake', async ({
  page,
  api,
  agent,
  human,
}) => {
  const t = await api.ticket({ title: 'Rewritten while typing' })
  type Summary = { postId: number }
  const v1 = await ok<Summary>(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'Version one.' } }))
  await ok(
    agent.post('/api/comments', { data: { parentType: 'update', parentId: v1.postId, body: 'Agent note.' } }),
  )
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const card = page.getByRole('article', { name: 'Summary' })
  await card.getByRole('group', { name: 'Summary actions' }).getByRole('button', { name: '1 reply' }).click()
  await card.getByRole('group', { name: 'Reply actions' }).getByRole('button', { name: 'reply' }).click()
  await expect(card.getByText(/^replying to claude/)).toBeVisible()
  await card.getByRole('textbox', { name: 'Reply' }).fill('Begun under version one.')

  // The agent rewrites it while the human types.
  const v2 = await ok<Summary>(
    agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'Version two.', change: 'rewritten' } }),
  )
  // The ticket page polls every 10 s: the card takes the new version on the next one.
  await expect(card).toContainText('Version two.', { timeout: 15_000 })

  // The draft and its reply-to were v1's: the card holds neither, and a reply from it goes under v2.
  await expect(card.getByText(/^replying to/)).toHaveCount(0)
  await card.getByRole('group', { name: 'Summary actions' }).getByRole('button', { name: 'reply' }).click()
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveText('')
  await card.getByRole('textbox', { name: 'Reply' }).fill('Under version two.')
  await card.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(card.getByText('Under version two.')).toBeVisible()
  const under2 = await ok<{ body: string; replyTo: number | null }[]>(
    human.get(`/api/comments?parentType=update&parentId=${v2.postId}`),
  )
  expect(under2.map((c) => [c.body, c.replyTo])).toEqual([['Under version two.', null]])
})
