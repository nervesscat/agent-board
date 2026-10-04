import { expect, ok, test } from './fixtures'

interface Inbox {
  count: number
  cursor: string | null
  threads: { ticketId: number | null; parentType: string; parentId: number; lastAuthor: string }[]
}

test('an agent polls its inbox with a cursor: a new comment shows once, then not again', async ({
  api,
  human,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Agent works it', status: 'todo' })
  await ok(agent.post(`/api/tickets/${t.id}/claim`, { data: {} }))
  const inbox = (since: string | null) =>
    ok<Inbox>(
      agent.get(`/api/projects/${project.id}/inbox${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    )

  const first = await inbox(null)
  expect(first.count).toBe(0)
  // Nothing seen yet: the cursor starts now, so only what comes after counts.
  const start = first.cursor ?? new Date().toISOString()

  await ok(
    human.post('/api/comments', { data: { parentType: 'ticket', parentId: t.id, body: 'Use the v2 API.' } }),
  )
  const news = await inbox(start)
  expect(news.count).toBe(1)
  expect(news.threads).toMatchObject([{ ticketId: t.id, parentType: 'ticket', lastAuthor: 'enrique' }])
  expect(news.cursor).not.toBeNull()
  expect(news.cursor! > start).toBe(true)

  // With the cursor it handed out, the same comment is not news again, and the cursor stays.
  const again = await inbox(news.cursor)
  expect(again).toMatchObject({ count: 0, threads: [], cursor: news.cursor })

  // The agent answers: nothing waits on it. The human speaks again: news again, from the same cursor.
  await ok(agent.post('/api/comments', { data: { parentType: 'ticket', parentId: t.id, body: 'On it.' } }))
  expect((await inbox(news.cursor)).count).toBe(0)
  await ok(human.post('/api/comments', { data: { parentType: 'ticket', parentId: t.id, body: 'Thanks.' } }))
  const later = await inbox(news.cursor)
  expect(later.count).toBe(1)
  expect(later.cursor! > news.cursor!).toBe(true)
  expect((await inbox(later.cursor)).count).toBe(0)

  // A cursor that is not a time is refused.
  expect((await agent.get(`/api/projects/${project.id}/inbox?since=yesterday`)).status()).toBe(400)
})
