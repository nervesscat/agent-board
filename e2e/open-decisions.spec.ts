import type { APIRequestContext, Page } from '@playwright/test'

import { inDatabase } from './db'
import { expect, ok, test } from './fixtures'

/** Dates a post `hours` back (it was made just now), and gives the moment it now has. */
function postedHoursAgo(id: number, hours: number) {
  const at = new Date(Date.now() - hours * 3_600_000).toISOString()
  inDatabase((db) => db.prepare('update updates set "createdAt" = ? where id = ?').run(at, id))
  return at
}

/** A post on the ticket, from `who`, `hours` back. */
async function postAt(who: APIRequestContext, ticketId: number, body: string, hours = 0, progress = true) {
  const { id } = await ok<{ id: number }>(
    who.post(`/api/tickets/${ticketId}/updates`, { data: { body, progress } }),
  )
  return { id, at: hours ? postedHoursAgo(id, hours) : null }
}

/** An agent's question to the human, with two options, `hours` back. */
async function askAt(agent: APIRequestContext, ticketId: number, body: string, hours = 0) {
  const { id } = await ok<{ id: number }>(
    agent.post(`/api/tickets/${ticketId}/decisions`, {
      data: { body, options: [{ label: 'Keep it' }, { label: 'Drop it', recommended: true }] },
    }),
  )
  return { id, at: hours ? postedHoursAgo(id, hours) : null }
}

/** The rows of the Activity feed, top to bottom. */
const rows = (page: Page) => page.locator('ol > li:has(> time)')

/** The feed holds these posts, in this order, each row found by a piece of its text. */
const expectFeed = (page: Page, bodies: string[]) =>
  expect(rows(page)).toHaveText(bodies.map((b) => new RegExp(b.replace(/[.?]/g, '\\$&'))))

/** Opens that tab of the feed. */
const openTab = (page: Page, name: 'Main' | 'Agents') =>
  page
    .getByRole('tablist', { name: 'Feed' })
    .getByRole('tab', { name: new RegExp(`^${name}`) })
    .click()

/** Picks an option on a decision card and decides it. */
async function decide(page: Page, question: string) {
  const card = page
    .getByRole('article')
    .filter({ hasText: question })
    .getByRole('group', { name: 'Decision' })
  await card.getByRole('radio', { name: /Drop it/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(card).toContainText('decided by enrique')
}

test('an open decision is the first post of the feed, however old, with its own time', async ({
  page,
  api,
  agent,
  human,
}) => {
  const t = await api.ticket({ title: 'A question waits', status: 'in_progress' })
  await postAt(human, t.id, 'Before the question.', 72, false)
  const question = await askAt(agent, t.id, 'Should the cache go?', 48)
  await postAt(agent, t.id, 'A step after it.', 1)
  await postAt(human, t.id, 'A note since.', 0, false)

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  // Main has the human's posts and the card; the agent's progress post is in Agents.
  await expectFeed(page, ['Should the cache go?', 'A note since.', 'Before the question.'])
  const first = rows(page).first()
  await expect(first.getByRole('group', { name: 'Decision' })).toContainText('Your decision is needed')
  // Its legend says when it was asked, as any row's does, and it sits on the rail like them.
  await expect(first.locator('> time')).toHaveAttribute('datetime', question.at!)
  await expect(first.locator('> time')).toContainText('2 days ago')
  await expect(first.locator('> div').first().locator('span')).toHaveCount(2)
  await openTab(page, 'Agents')
  await expectFeed(page, ['A step after it.'])

  // The rest keep the API's order, which leaves the question where it falls in time.
  const updates = (await api.getTicket(t.id)).updates
  expect(updates.map((u) => u.body)).toEqual([
    'A note since.',
    'A step after it.',
    'Should the cache go?',
    'Before the question.',
  ])
})

test('several open decisions all come first, newest first, and each goes back to its time once decided', async ({
  page,
  api,
  agent,
  human,
}) => {
  const t = await api.ticket({ title: 'Two questions wait', status: 'in_progress' })
  await askAt(agent, t.id, 'Which parser?', 72)
  await postAt(human, t.id, 'Between them.', 48, false)
  await askAt(agent, t.id, 'Which port?', 24)
  await postAt(agent, t.id, 'The latest step.')

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await expectFeed(page, ['Which port?', 'Which parser?', 'Between them.'])

  // Decided, the newer one drops back to its day; the other still waits on top. No reload.
  await decide(page, 'Which port?')
  await expectFeed(page, ['Which parser?', 'Which port?', 'Between them.'])

  await decide(page, 'Which parser?')
  await expectFeed(page, ['Which port?', 'Between them.', 'Which parser?'])
  await openTab(page, 'Agents')
  await expectFeed(page, ['The latest step.'])
  expect((await api.getTicket(t.id)).status).toBe('in_progress')
})

test("a lane's open decision comes first when lane posts are included, and is not there without them", async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  const parent = await api.ticket({ title: 'The whole feature' })
  const lane = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'One part', parentId: parent.id } }),
  )
  await askAt(agent, lane.id, 'Split the lane?', 24)
  await postAt(agent, parent.id, 'Parent step.', 2)
  await postAt(human, parent.id, 'Parent note.', 0, false)

  await page.goto(`/projects/${project.id}/features/${parent.id}`)
  await expectFeed(page, ['Parent note.'])
  await expect(page.getByRole('group', { name: 'Decision' })).toHaveCount(0)

  await page.getByText('include lane posts').click()
  await expectFeed(page, ['Split the lane?', 'Parent note.'])
  const first = rows(page).first()
  await expect(first.getByRole('group', { name: 'Decision' })).toContainText('Your decision is needed')
  await expect(first.getByRole('link', { name: 'One part' })).toBeVisible()

  await page.getByText('include lane posts').click()
  await expectFeed(page, ['Parent note.'])
  await openTab(page, 'Agents')
  await expectFeed(page, ['Parent step.'])
})

test('a question written as a plain post keeps its place in time', async ({ page, api, human, agent }) => {
  const t = await api.ticket({ title: 'Asked in words' })
  await postAt(human, t.id, 'Should the export stay?', 3, false)
  await postAt(agent, t.id, 'Moved on since.')

  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await expectFeed(page, ['Should the export stay?'])
  await openTab(page, 'Agents')
  await expectFeed(page, ['Moved on since.'])
})
