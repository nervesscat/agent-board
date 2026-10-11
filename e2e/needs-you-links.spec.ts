import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Project } from '#/lib/api'
import { inDatabase } from './db'
import { HUMAN } from './env'
import { type Api, expect, ok, section, test } from './fixtures'
import { box, coveredAt, feedDrawn, longTicket, scrollTo, ticketHeader } from './scrolling'

/**
 * Each entry of Needs you links to the thing waiting on the human: a post, a reply in its thread, the
 * hand-off, a PR's card or a reply under it. The page brings it into view below its stuck header once
 * its data is drawn, and marks it for a moment (data-revealed).
 */

type Row = { id: number }

const needsYou = (page: Page) => section(page, 'Needs you')
const overview = (page: Page, project: Project) => page.goto(`/projects/${project.id}`)
const scrollY = (page: Page) => page.evaluate(() => window.scrollY)
const post = (page: Page, id: number) => page.locator(`#post-${id}`)
const reply = (page: Page, id: number) => page.locator(`#reply-${id}`)
const threadToggle = (article: Locator) =>
  // The first of a post's actions opens and closes its replies.
  article.getByRole('group', { name: 'Post actions' }).getByRole('button').first()

/** A question for the human on the ticket, as an agent asks it: a decision with two options. */
const askDecision = (agent: APIRequestContext, ticketId: number, body: string) =>
  ok<Row>(
    agent.post(`/api/tickets/${ticketId}/decisions`, {
      data: { body, options: [{ label: 'One way' }, { label: 'The other' }] },
    }),
  )

/** The human's own post (not progress) and an agent's reply under it: a thread waiting on the human. */
async function answeredPost(
  human: APIRequestContext,
  agent: APIRequestContext,
  ticketId: number,
  text: string,
) {
  const p = await ok<Row>(
    human.post(`/api/tickets/${ticketId}/updates`, { data: { body: `${text}?`, progress: false } }),
  )
  const r = await ok<Row>(
    agent.post('/api/comments', { data: { parentType: 'update', parentId: p.id, body: `${text}: done` } }),
  )
  return { post: p.id, reply: r.id }
}

/**
 * The target was just brought into view: marked, and only it, below the stuck header (or the top bar),
 * with nothing drawn over it, after the page scrolled to it.
 */
async function expectRevealed(page: Page, target: Locator, under: Locator = ticketHeader(page)) {
  await expect(target).toHaveAttribute('data-revealed', '')
  await expect(page.locator('[data-revealed]')).toHaveCount(1)
  await expectInView(target, under)
}

async function expectInView(target: Locator, under: Locator) {
  await expect(target).toBeInViewport()
  const top = await box(under)
  expect((await box(target)).y).toBeGreaterThanOrEqual(top.y + top.height - 1)
  // Cards are rounded: their very corners are not theirs to hit.
  expect(await coveredAt(target, 6)).toEqual([])
}

/** The mark fades and goes within a few seconds, from any element. */
async function expectMarkGone(page: Page) {
  await expect(page.locator('[data-revealed]')).toHaveCount(0, { timeout: 5_000 })
}

/** The link as a shared one: opened in a tab of its own, with nothing of this one's in memory. */
async function openFresh(page: Page, href: string) {
  const fresh = await page.context().newPage()
  await fresh.goto(href)
  // Its buttons work once React has taken the page over.
  await fresh.waitForFunction(() => Object.keys(document.body).some((k) => k.startsWith('__reactFiber')))
  return fresh
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test('a decision lands on its post, marked for a moment; Back is the Overview again, Forward the post', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let decision = 0
  const t = await longTicket(api, human, 'Decide deep in the feed', 'in_progress', async (id) => {
    decision = (await askDecision(agent, id, 'Which way should the parser go')).id
  })

  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: 'Decide: Which way should the parser go' })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/features/${t.id}#post-${decision}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}#post-${decision}$`))
  await feedDrawn(page)
  await expectRevealed(page, post(page, decision))
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  await expectInView(post(page, decision).getByRole('group', { name: 'Decision' }), ticketHeader(page))
  // The tint is drawn, then fades: gone within a few seconds.
  expect(await post(page, decision).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
  await expectMarkGone(page)

  // The reveal added no step to the history.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await expect(
    needsYou(page).getByRole('link', { name: 'Decide: Which way should the parser go' }),
  ).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}#post-${decision}$`))
  await expectInView(post(page, decision), ticketHeader(page))
})

test('a question on the ticket lands on the post that asks it, also opened fresh from the link', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let question = 0
  const t = await longTicket(api, human, 'Asked about early on', 'in_progress', async (id) => {
    question = (
      await ok<Row>(
        agent.post('/api/comments', {
          data: { parentType: 'ticket', parentId: id, body: 'Should the parser keep comments?' },
        }),
      )
    ).id
  })

  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: `#${t.id} Asked about early on`, exact: true })
  const href = await link.getAttribute('href')
  expect(href).toBe(`/projects/${project.id}/features/${t.id}#post-${question}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`#post-${question}$`))
  await expectRevealed(page, post(page, question))
  await expect(post(page, question)).toContainText('Should the parser keep comments?')

  // The same URL, loaded on its own: the ticket is read after the page is up, and still lands there.
  const fresh = await openFresh(page, href!)
  await feedDrawn(fresh)
  await expectRevealed(fresh, post(fresh, question))
  await expect.poll(() => scrollY(fresh)).toBeGreaterThan(0)
})

test('a reply lands inside its opened thread, its replies read after the ticket; fresh too', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Reply buried in a thread', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Is the cache warm')
  })

  await overview(page, project)
  const entry = needsYou(page).getByRole('listitem').filter({ hasText: 'Is the cache warm: done' })
  const link = entry.getByRole('link')
  const href = `/projects/${project.id}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`
  await expect(link).toHaveAttribute('href', href)
  await link.click()
  await expect(threadToggle(post(page, thread.post))).toHaveAttribute('aria-expanded', 'true')
  await expectRevealed(page, reply(page, thread.reply))
  await expect(reply(page, thread.reply)).toContainText('Is the cache warm: done')
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0)

  const fresh = await openFresh(page, href)
  await expect(threadToggle(post(fresh, thread.post))).toHaveAttribute('aria-expanded', 'true')
  await expectRevealed(fresh, reply(fresh, thread.reply))
})

test('a reply to a reply lands on itself, marked alone', async ({ page, project, api, human, agent }) => {
  let ids = { post: 0, first: 0, nested: 0 }
  await longTicket(api, human, 'Nested replies', 'in_progress', async (id) => {
    const p = await ok<Row>(
      human.post(`/api/tickets/${id}/updates`, { data: { body: 'Where do logs go?', progress: false } }),
    )
    const first = await ok<Row>(
      human.post('/api/comments', { data: { parentType: 'update', parentId: p.id, body: 'Maybe stdout.' } }),
    )
    const nested = await ok<Row>(
      agent.post('/api/comments', {
        data: {
          parentType: 'update',
          parentId: p.id,
          replyTo: first.id,
          body: 'Stdout it is, rotated daily.',
        },
      }),
    )
    ids = { post: p.id, first: first.id, nested: nested.id }
  })

  await overview(page, project)
  await needsYou(page)
    .getByRole('listitem')
    .filter({ hasText: 'Stdout it is, rotated daily.' })
    .getByRole('link')
    .click()
  await expect(page).toHaveURL(new RegExp(`#post-${ids.post}-reply-${ids.nested}$`))
  await expectRevealed(page, reply(page, ids.nested))
  await expect(reply(page, ids.first)).not.toHaveAttribute('data-revealed')
  await expect(post(page, ids.post)).not.toHaveAttribute('data-revealed')
})

test('a ticket in review lands on its hand-off card', async ({ page, project, api, human }) => {
  const t = await longTicket(api, human, 'Ready for a look', 'review')
  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: `#${t.id} Ready for a look`, exact: true })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/features/${t.id}#handoff`)
  await link.click()
  const card = page.getByRole('region', { name: 'Hand-off' })
  await expect(card).toHaveAttribute('id', 'handoff')
  await expectRevealed(page, card)
})

test('a second entry on a ticket already loaded lands on its own target', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let decision = 0
  let thread = { post: 0, reply: 0 }
  await longTicket(api, human, 'Two things waiting', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Which port')
    decision = (await askDecision(agent, id, 'Keep the old flag')).id
  })

  await overview(page, project)
  await needsYou(page).getByRole('link', { name: 'Decide: Keep the old flag' }).click()
  await expectRevealed(page, post(page, decision))
  await page.goBack()
  await needsYou(page).getByRole('listitem').filter({ hasText: 'Which port: done' }).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`#post-${thread.post}-reply-${thread.reply}$`))
  await expectRevealed(page, reply(page, thread.reply))
})

test('the page is the reader’s after landing: refetches neither scroll back nor close the thread', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  test.slow()
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Stay where I scrolled', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Ship it today')
  })
  await page.goto(`/projects/${project.id}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`)
  await expectRevealed(page, reply(page, thread.reply))

  expect(await scrollTo(page, 0)).toBe(0)
  // Something new in the feed and in the thread: drawn by the 10 s refetches of each.
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Fresh on top.' } }))
  await ok(
    agent.post('/api/comments', {
      data: { parentType: 'update', parentId: thread.post, body: 'One more thing.' },
    }),
  )
  await expect(page.getByRole('article').filter({ hasText: 'Fresh on top.' })).toHaveCount(1, {
    timeout: 15_000,
  })
  await expect(post(page, thread.post)).toContainText('One more thing.', { timeout: 15_000 })
  expect(await scrollY(page)).toBe(0)
  await expect(threadToggle(post(page, thread.post))).toHaveAttribute('aria-expanded', 'true')
})

test('a #link on an open ticket lands on its post; back and forward return to where the reader was', async ({
  page,
  api,
  human,
}) => {
  let older = 0
  let newer = 0
  const t = await longTicket(api, human, 'Linked posts', 'in_progress', async (id) => {
    older = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, { data: { body: 'The first finding.', progress: false } }),
      )
    ).id
    newer = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, {
          data: { body: `Follows [the first finding](#post-${older}).`, progress: false },
        }),
      )
    ).id
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${newer}`)
  await expectRevealed(page, post(page, newer))
  await expectMarkGone(page)

  const link = post(page, newer).getByRole('link', { name: 'the first finding' })
  await link.scrollIntoViewIfNeeded()
  const leftNewer = await scrollY(page)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`#post-${older}$`))
  await expectRevealed(page, post(page, older))
  await expectMarkGone(page)
  // The reader moves on from it.
  const leftOlder = await scrollTo(page, 2000)

  // Back and Forward go to where the reader was on each, unmarked: not to the anchor again.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#post-${newer}$`))
  await expect.poll(() => scrollY(page)).toBe(leftNewer)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(leftNewer)
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`#post-${older}$`))
  await expect.poll(() => scrollY(page)).toBe(leftOlder)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(leftOlder)
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

/** Two posts on a long ticket, the newer one linking to the older one: `#link` steps on one page. */
async function linkedPosts(api: Api, human: APIRequestContext, title: string) {
  let older = 0
  let newer = 0
  const t = await longTicket(api, human, title, 'in_progress', async (id) => {
    older = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, { data: { body: 'The first finding.', progress: false } }),
      )
    ).id
    newer = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, {
          data: { body: `Follows [the first finding](#post-${older}).`, progress: false },
        }),
      )
    ).id
  })
  return { t, older, newer }
}

/**
 * The reader's last scroll, not yet told when the history moves: the browser tells of a scroll on its
 * next frame, and Back or Forward can be taken before that. Here the window scrolls to `y` as the
 * history moves, before the page hears of the move, so no scroll event can come in between. The
 * listener that does it is the page's first (see scrollingAsHistoryMoves).
 */
const scrollAsHistoryMoves = (page: Page, y: number) =>
  page.evaluate((y) => {
    ;(window as unknown as { scrollOnPop: number }).scrollOnPop = y
  }, y)

/** Put before the page's own scripts: scrolls the window on the next history move, when asked to. */
const scrollingAsHistoryMoves = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { scrollOnPop?: number }
    window.addEventListener('popstate', () => {
      if (w.scrollOnPop === undefined) return
      window.scrollTo(0, w.scrollOnPop)
      w.scrollOnPop = undefined
    })
  })

test('Back and Forward return to a place scrolled to right before them', async ({ page, api, human }) => {
  const { t, older, newer } = await linkedPosts(api, human, 'Scrolled, then back')
  await scrollingAsHistoryMoves(page)
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${newer}`)
  await expectRevealed(page, post(page, newer))
  await expectMarkGone(page)
  // Already where the link lands (that scroll told), and clicked where it is: landing on the post does
  // not scroll, so nothing on the next step tells of the window before the reader scrolls it.
  await post(page, older).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  const leftNewer = await scrollY(page)
  await post(page, newer)
    .getByRole('link', { name: 'the first finding' })
    .evaluate((a: HTMLElement) => a.click())
  await expectRevealed(page, post(page, older))
  expect(await scrollY(page)).toBe(leftNewer)
  await expectMarkGone(page)
  await recordMarks(page)

  await scrollAsHistoryMoves(page, 2000)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#post-${newer}$`))
  await expect.poll(() => scrollY(page)).toBe(leftNewer)
  // And the other way: a place scrolled to right before Forward is where the next Back returns.
  await scrollAsHistoryMoves(page, 1000)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`#post-${older}$`))
  await expect.poll(() => scrollY(page)).toBe(2000)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(2000)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#post-${newer}$`))
  await expect.poll(() => scrollY(page)).toBe(1000)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(1000)
  expect(await marks(page)).toEqual([])
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

test('going back two steps at once returns to where the reader was there, unmarked', async ({
  page,
  api,
  human,
}) => {
  let first = 0
  let second = 0
  let third = 0
  await scrollingAsHistoryMoves(page)
  const t = await longTicket(api, human, 'Two steps back', 'in_progress', async (id) => {
    third = (
      await ok<Row>(human.post(`/api/tickets/${id}/updates`, { data: { body: 'The end.', progress: false } }))
    ).id
    second = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, {
          data: { body: `Goes on to [the end](#post-${third}).`, progress: false },
        }),
      )
    ).id
    first = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, {
          data: { body: `Starts with [the middle](#post-${second}).`, progress: false },
        }),
      )
    ).id
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${first}`)
  await expectRevealed(page, post(page, first))
  await expectMarkGone(page)
  const toSecond = post(page, first).getByRole('link', { name: 'the middle' })
  await toSecond.scrollIntoViewIfNeeded()
  const leftFirst = await scrollY(page)
  await toSecond.click()
  await expectRevealed(page, post(page, second))
  await expectMarkGone(page)
  await scrollTo(page, 1000)
  await post(page, second).getByRole('link', { name: 'the end' }).click()
  await expectRevealed(page, post(page, third))
  await expectMarkGone(page)
  await recordMarks(page)

  await scrollAsHistoryMoves(page, 2000)
  await page.evaluate(() => history.go(-2))
  await expect(page).toHaveURL(new RegExp(`#post-${first}$`))
  await expect.poll(() => scrollY(page)).toBe(leftFirst)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(leftFirst)
  expect(await marks(page)).toEqual([])
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

test('Back to the page as it was before a #link takes its mark off at once', async ({ page, api, human }) => {
  const { t, older, newer } = await linkedPosts(api, human, 'Back to no anchor')
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await feedDrawn(page)
  await post(page, newer).getByRole('link', { name: 'the first finding' }).click()
  await expect(post(page, older)).toHaveAttribute('data-revealed', '')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}$`))
  // Gone with the step back, not left to fade.
  await expect(page.locator('[data-revealed]')).toHaveCount(0, { timeout: 300 })
})

test('a reload lands on the anchor again and marks it, wherever the reader had scrolled', async ({
  page,
  api,
  human,
}) => {
  const { t, newer } = await linkedPosts(api, human, 'Reloaded')
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${newer}`)
  await expectRevealed(page, post(page, newer))
  await expectMarkGone(page)
  await scrollTo(page, 0)
  await page.reload()
  await expectRevealed(page, post(page, newer))
  expect(await scrollY(page)).toBeGreaterThan(0)
})

test('Back right after a #link takes its mark off at once', async ({ page, api, human }) => {
  let older = 0
  let newer = 0
  const t = await longTicket(api, human, 'Back at once', 'in_progress', async (id) => {
    older = (
      await ok<Row>(human.post(`/api/tickets/${id}/updates`, { data: { body: 'Earlier.', progress: false } }))
    ).id
    newer = (
      await ok<Row>(
        human.post(`/api/tickets/${id}/updates`, {
          data: { body: `After [the earlier one](#post-${older}).`, progress: false },
        }),
      )
    ).id
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${newer}`)
  await expectRevealed(page, post(page, newer))
  await expectMarkGone(page)
  await post(page, newer).getByRole('link', { name: 'the earlier one' }).click()
  await expect(post(page, older)).toHaveAttribute('data-revealed', '')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#post-${newer}$`))
  // Gone with the step back, not left to fade.
  await expect(page.locator('[data-revealed]')).toHaveCount(0, { timeout: 300 })
})

test('a #link clicked while the last target is still held in place lands on its reply', async ({
  page,
  api,
  human,
  agent,
}) => {
  let bottom = 0
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Two links in a row', 'in_progress', async (id) => {
    bottom = (
      await ok<Row>(human.post(`/api/tickets/${id}/updates`, { data: { body: 'Bottom.', progress: false } }))
    ).id
    // Above it in the feed, and answered.
    thread = await answeredPost(human, agent, id, 'Higher up')
    await ok(
      human.patch(`/api/updates/${bottom}`, {
        data: { body: `See [the answer](#post-${thread.post}-reply-${thread.reply}).` },
      }),
    )
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${bottom}`)
  await expect(post(page, bottom)).toHaveAttribute('data-revealed', '')
  // Right away, while the post is held where it landed: opening the thread above it pushes it down.
  await post(page, bottom).getByRole('link', { name: 'the answer' }).click()
  await expect(page).toHaveURL(new RegExp(`#post-${thread.post}-reply-${thread.reply}$`))
  await expect(threadToggle(post(page, thread.post))).toHaveAttribute('aria-expanded', 'true')
  await expectRevealed(page, reply(page, thread.reply))
})

test("a lane's post linked on its parent shows with the lanes' posts folded in", async ({
  page,
  project,
  api,
  human,
}) => {
  let lanePost = 0
  const t = await longTicket(api, human, 'Parent of a lane', 'in_progress', async (id) => {
    const lane = await ok<Row>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'The lane', parentId: id } }),
    )
    lanePost = (
      await ok<Row>(
        human.post(`/api/tickets/${lane.id}/updates`, {
          data: { body: 'Found in the lane.', progress: false },
        }),
      )
    ).id
  })
  await page.goto(`/projects/${project.id}/features/${t.id}#post-${lanePost}`)
  await expect(page.getByRole('switch', { name: 'include lane posts' })).toBeChecked()
  await expectRevealed(page, post(page, lanePost))
  await expect(post(page, lanePost)).toContainText('Found in the lane.')
})

test('an anchor that matches nothing leaves the page as it is', async ({ page, project, api, human }) => {
  const t = await longTicket(api, human, 'Nothing to land on', 'in_progress', async (id) => {
    await ok(human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'A lane', parentId: id } }))
  })
  const folds: string[] = []
  page.on('request', (r) => {
    if (r.url().includes(`/api/tickets/${t.id}?lanes=1`)) folds.push(r.url())
  })
  await page.goto(`/projects/${project.id}/features/${t.id}#post-999999999`)
  await feedDrawn(page)
  // Not among the ticket's posts, so the lanes' posts are folded in once to look there; still nothing.
  const lanes = page.getByRole('switch', { name: 'include lane posts' })
  await expect(lanes).toBeChecked()
  await page.waitForTimeout(3_000)
  await expect(lanes).toBeChecked()
  expect(folds.length).toBeLessThanOrEqual(2)
  expect(await scrollY(page)).toBe(0)
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
  await expect(page.locator('[aria-expanded="true"]')).toHaveCount(0)
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Nothing to land on')
})

test('a reply that is gone lands on its post', async ({ page, api, human, agent }) => {
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Reply deleted since', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Still there')
  })
  await ok(human.delete(`/api/comments/${thread.reply}`))
  await page.goto(`/projects/${t.projectId}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`)
  await expectRevealed(page, post(page, thread.post))
  await expect(reply(page, thread.reply)).toHaveCount(0)
})

test('without motion, in either theme, the mark is a still tint for the same moment', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let decision = 0
  const t = await longTicket(api, human, 'Still marks', 'in_progress', async (id) => {
    decision = (await askDecision(agent, id, 'Hold still')).id
  })
  const tints: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme })
    // Loaded afresh each time (from another page: the same URL again would only move to its anchor).
    await overview(page, project)
    await page.goto(`/projects/${project.id}/features/${t.id}#post-${decision}`)
    await expectRevealed(page, post(page, decision))
    const style = await post(page, decision).evaluate((el) => {
      const s = getComputedStyle(el)
      return { animation: s.animationName, shadow: s.boxShadow }
    })
    expect(style.animation).toBe('none')
    expect(style.shadow).not.toBe('none')
    tints.push(style.shadow)
    await expectMarkGone(page)
  }
  expect(tints[0]).not.toBe(tints[1])
})

test('Home links its entries to the same places', async ({ page, project, api, agent }) => {
  const t = await api.ticket({ title: 'Asked from Home', status: 'in_progress' })
  const d = await askDecision(agent, t.id, `Which project is it, ${project.id}`)
  await page.goto('/')
  await expect(
    page.getByRole('link', { name: `Decide: Which project is it, ${project.id}` }),
  ).toHaveAttribute('href', `/projects/${project.id}/features/${t.id}#post-${d.id}`)
})

// --- the PR queue ---

let prNumbers = 1000

/** A PR row as a refresh from GitHub would leave it (the e2e repo has no remote, so none comes). */
function seedPr(
  project: Project,
  pr: { title: string; author?: string; waitingOn?: 'me' | 'others'; stage?: string; updatedAt?: string },
) {
  const number = ++prNumbers
  const id = inDatabase(
    (db) =>
      (
        db
          .prepare(
            `insert into prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha,
               waiting_on, review_stage, updated_at, fetched_at)
             values (?, ?, ?, ?, ?, ?, ?, 'main', 'abcdef1234567', ?, ?, ?, ?) returning id`,
          )
          .get(
            project.id,
            project.repos[0]!.id,
            number,
            pr.title,
            `https://github.com/example/repo/pull/${number}`,
            pr.author ?? 'someone',
            `branch-${number}`,
            pr.waitingOn ?? 'me',
            pr.stage ?? 'pending',
            pr.updatedAt ?? new Date().toISOString(),
            new Date().toISOString(),
          ) as Row
      ).id,
  )
  return { id, number }
}

const topBar = (page: Page) => page.getByRole('banner')

test('a PR to review lands on its card, whatever filter this browser remembers', async ({
  page,
  project,
}) => {
  const target = seedPr(project, { title: 'Review me first', updatedAt: '2026-01-01T00:00:00.000Z' })
  // Others before it in the queue (newest first), so its card starts below the fold.
  for (let i = 0; i < 12; i++) seedPr(project, { title: `Another PR ${i}` })
  await overview(page, project)
  await page.evaluate(() => localStorage.setItem('prs.filter', 'others'))
  await overview(page, project)

  const link = needsYou(page).getByRole('link', { name: `Review PR #${target.number} Review me first` })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/prs#pr-${target.id}`)
  await link.click()
  const card = page.locator(`#pr-${target.id}`)
  await expectRevealed(page, card, topBar(page))
  await expect(card).toContainText('Review me first')
  await expect(page).toHaveURL(new RegExp(`#pr-${target.id}$`))
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  // Shown for this visit, not remembered.
  expect(await page.evaluate(() => localStorage.getItem('prs.filter'))).toBe('others')
})

/**
 * The PR queue visited once (its list now loaded), a filter that hides the PR picked there, then the
 * Overview's link to the PR: the list is drawn at once, then filtered as remembered, then switched to
 * the filter that shows the PR.
 */
async function reviewFromCachedQueue(page: Page, project: Project) {
  const target = seedPr(project, { title: 'Review me again', updatedAt: '2026-01-01T00:00:00.000Z' })
  for (let i = 0; i < 12; i++) seedPr(project, { title: `Queued PR ${i}` })
  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: `Review PR #${target.number} Review me again` })
  await link.click()
  await expect(page.locator(`#pr-${target.id}`)).toHaveAttribute('data-revealed', '')
  await page.getByRole('tab', { name: /^Waiting on others/ }).click()
  await expect(page.locator(`#pr-${target.id}`)).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('prs.filter'))).toBe('others')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await recordMarks(page)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`filter=me#pr-${target.id}$`))
  await expect(page.getByRole('tab', { name: /^To review/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: /^All/ })).toHaveCount(0)
  const card = page.locator(`#pr-${target.id}`)
  await expectRevealed(page, card, topBar(page))
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  expect(await noSidewaysScroll(page)).toBe(true)
  // Shown for this visit, not remembered.
  expect(await page.evaluate(() => localStorage.getItem('prs.filter'))).toBe('others')
  // Revealed once, after the list settled, and the filter put in the URL on the way is no step of
  // the history.
  await expectMarkGone(page)
  expect((await marks(page)).map((m) => m.id)).toEqual([`pr-${target.id}`])
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
}

test('a PR to review lands on its card with the queue already loaded and a filter that hides it', async ({
  page,
  project,
}) => {
  await reviewFromCachedQueue(page, project)
})

test('Forward to a PR the reader scrolled away from returns to where they left it, under a filter remembered since', async ({
  page,
  project,
}) => {
  const target = seedPr(project, { title: 'Come back to me', updatedAt: '2026-01-01T00:00:00.000Z' })
  for (let i = 0; i < 12; i++) seedPr(project, { title: `Queued PR ${i}` })
  await overview(page, project)
  await needsYou(page)
    .getByRole('link', { name: `Review PR #${target.number} Come back to me` })
    .click()
  await expectRevealed(page, page.locator(`#pr-${target.id}`), topBar(page))
  await expectMarkGone(page)
  const left = await scrollTo(page, 600)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  // Picked meanwhile (in another tab of the queue): it hides the PR, so the list is filtered, then
  // switched to the one that shows it, on the way back.
  await page.evaluate(() => localStorage.setItem('prs.filter', 'others'))
  await recordMarks(page)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`#pr-${target.id}$`))
  await expect.poll(() => scrollY(page)).toBe(left)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(left)
  expect(await marks(page)).toEqual([])
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

test('Back and Forward over a #link in a review result mark nothing', async ({ page, project, human }) => {
  const summaryMd = [
    'A claim with a note.[^1]',
    ...Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: all good here.`),
    '[^1]: The note behind the claim.',
  ].join('\n\n')
  const result = await ok<Row>(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: { prNumber: 4545, sha: 'abcdef1234567', verdict: 'SHIP', summaryMd },
    }),
  )
  await page.goto(`/projects/${project.id}/prs?result=${result.id}`)
  await expect(resultDialog(page)).toContainText('Finding 40')
  // To the note, and from the note back to the claim: two steps, the window behind never moving
  // (clicked where they are, as the reader does, without scrolling anything to them first).
  await resultDialog(page)
    .locator('a[href="#user-content-fn-1"]')
    .evaluate((a: HTMLElement) => a.click())
  await expect(page).toHaveURL(/#user-content-fn-1$/)
  await expect(page.locator('#user-content-fn-1')).toHaveAttribute('data-revealed', '')
  await expectMarkGone(page)
  await resultDialog(page)
    .locator('a[href="#user-content-fnref-1"]')
    .evaluate((a: HTMLElement) => a.click())
  await expect(page).toHaveURL(/#user-content-fnref-1$/)
  await expect(page.locator('#user-content-fnref-1')).toHaveAttribute('data-revealed', '')
  await expectMarkGone(page)

  await recordMarks(page)
  await page.goBack()
  await expect(page).toHaveURL(/#user-content-fn-1$/)
  await page.waitForTimeout(1_000)
  await page.goForward()
  await expect(page).toHaveURL(/#user-content-fnref-1$/)
  await page.waitForTimeout(1_000)
  expect(await marks(page)).toEqual([])
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

test("a reply on a PR's thread opens it on the PR's tab", async ({ page, project, agent, human }) => {
  const pr = seedPr(project, {
    title: 'Mine, reviewed',
    author: HUMAN,
    waitingOn: 'others',
    stage: 'reviewed',
  })
  await ok(human.post('/api/comments', { data: { parentType: 'pr', parentId: pr.id, body: 'Is CI green?' } }))
  const r = await ok<Row>(
    agent.post('/api/comments', { data: { parentType: 'pr', parentId: pr.id, body: 'CI is green now.' } }),
  )
  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: `PR #${pr.number} Mine, reviewed` })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/prs#pr-${pr.id}-reply-${r.id}`)
  await link.click()
  // To review shows no PR of the human's own: the queue switches to the filter that shows it.
  await expect(page.getByRole('tab', { name: /^Waiting on others/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(new RegExp(`filter=others#pr-${pr.id}-reply-${r.id}$`))
  await expect(page.getByRole('tab', { name: /^Reviewed/ })).toHaveAttribute('aria-selected', 'true')
  const card = page.locator(`#pr-${pr.id}`)
  await expect(card.getByRole('button', { name: 'thread' })).toHaveAttribute('aria-expanded', 'true')
  await expectRevealed(page, reply(page, r.id), topBar(page))
})

test('a reply on a review result opens it, scrolled to the reply', async ({
  page,
  project,
  human,
  agent,
}) => {
  const summaryMd = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: all good here.`).join('\n\n')
  const result = await ok<Row>(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: { prNumber: 4242, sha: 'abcdef1234567', verdict: 'SHIP', summaryMd },
    }),
  )
  const r = await ok<Row>(
    agent.post('/api/comments', {
      data: { parentType: 'review', parentId: result.id, body: 'Re-ran it, same.' },
    }),
  )
  await overview(page, project)
  const link = needsYou(page).getByRole('link', { name: 'review of PR #4242 (SHIP)' })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/prs?result=${result.id}#reply-${r.id}`)
  await link.click()
  const dialog = page.getByRole('dialog', { name: 'Review result' })
  await expect(dialog).toBeVisible()
  await expect(reply(page, r.id)).toHaveAttribute('data-revealed', '')
  await expect(reply(page, r.id)).toBeInViewport()
  expect(await dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

// --- the reader's own scrolling, and the next ticket ---

/** A review result with a long summary and an agent's reply under it, waiting on the human. */
async function answeredResult(project: Project, human: APIRequestContext, agent: APIRequestContext) {
  const summaryMd = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: all good here.`).join('\n\n')
  const result = await ok<Row>(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: { prNumber: 4343, sha: 'abcdef1234567', verdict: 'SHIP', summaryMd },
    }),
  )
  const r = await ok<Row>(
    agent.post('/api/comments', {
      data: { parentType: 'review', parentId: result.id, body: 'Looked again.' },
    }),
  )
  return { href: `/projects/${project.id}/prs?result=${result.id}#reply-${r.id}`, reply: r.id }
}

/** Threads' replies answer `ms` late, as on a slow connection. */
const slowReplies = (page: Page, ms: number) =>
  page.route(
    (url) => url.pathname === '/api/comments',
    async (route) => {
      await new Promise((r) => setTimeout(r, ms))
      await route.continue()
    },
  )

/** The review result's dialog: a box that scrolls on its own, inside the page. */
const resultDialog = (page: Page) => page.getByRole('dialog', { name: 'Review result' })
const setScrollTop = (box: Locator, top: number) =>
  box.evaluate((el, top) => {
    el.scrollTop = top
    return el.scrollTop
  }, top)

test('right after landing, a scroll the reader makes is kept, in the page or in a box', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  // A scrollbar dragged fires no wheel, touch or key: only the scroll itself, as a script's does.
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Scrolled away at once', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Right away')
  })
  await page.goto(`/projects/${project.id}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`)
  await expect(reply(page, thread.reply)).toHaveAttribute('data-revealed', '')
  expect(await scrollTo(page, 300)).toBe(300)
  await page.waitForTimeout(800)
  expect(await scrollY(page)).toBe(300)

  const result = await answeredResult(project, human, agent)
  await page.goto(result.href)
  await expect(reply(page, result.reply)).toHaveAttribute('data-revealed', '')
  expect(await setScrollTop(resultDialog(page), 0)).toBe(0)
  await page.waitForTimeout(800)
  expect(await resultDialog(page).evaluate((el) => el.scrollTop)).toBe(0)
})

test('a reply drawn late is not scrolled to once the reader has scrolled the page', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let thread = { post: 0, reply: 0 }
  const t = await longTicket(api, human, 'Slow replies', 'in_progress', async (id) => {
    thread = await answeredPost(human, agent, id, 'Late answer')
  })
  await slowReplies(page, 3_000)
  await page.goto(`/projects/${project.id}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`)
  await feedDrawn(page)
  expect(await scrollTo(page, 1200)).toBe(1200)
  await expect(reply(page, thread.reply)).toHaveCount(1)
  await page.waitForTimeout(1_000)
  expect(await scrollY(page)).toBe(1200)
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

test('a reply drawn late is not scrolled to once the reader has scrolled the dialog it is in', async ({
  page,
  project,
  human,
  agent,
}) => {
  const result = await answeredResult(project, human, agent)
  await slowReplies(page, 3_000)
  await page.goto(result.href)
  await expect(resultDialog(page)).toContainText('Finding 40')
  expect(await setScrollTop(resultDialog(page), 300)).toBe(300)
  await expect(reply(page, result.reply)).toHaveCount(1)
  await page.waitForTimeout(1_000)
  expect(await resultDialog(page).evaluate((el) => el.scrollTop)).toBe(300)
  await expect(page.locator('[data-revealed]')).toHaveCount(0)
})

/** Records each element marked from now on, with the ticket on screen at that moment. */
const recordMarks = (page: Page) =>
  page.evaluate(() => {
    const marks: { id: string; shown: string }[] = []
    ;(window as unknown as { marks: typeof marks }).marks = marks
    new MutationObserver((changes) => {
      for (const c of changes) {
        const el = c.target as Element
        if (el.hasAttribute('data-revealed'))
          marks.push({ id: el.id, shown: document.querySelector('main h1')?.textContent ?? '' })
      }
    }).observe(document.body, { subtree: true, attributeFilter: ['data-revealed'] })
  })
const marks = (page: Page) =>
  page.evaluate(() => (window as unknown as { marks: { id: string; shown: string }[] }).marks)

test('going to another ticket with an anchor, nothing on the one still shown is marked or scrolled', async ({
  page,
  project,
  api,
  human,
}) => {
  const a = await longTicket(api, human, 'First in review', 'review')
  const b = await longTicket(api, human, 'Second in review', 'review')
  await page.goto(`/projects/${project.id}/features/${a.id}`)
  await feedDrawn(page)
  expect(await scrollTo(page, 1500)).toBe(1500)
  await recordMarks(page)
  // The next ticket answers late, so the first one stays on screen meanwhile.
  await page.route(
    (url) => url.pathname === `/api/tickets/${b.id}`,
    async (route) => {
      await new Promise((r) => setTimeout(r, 2_000))
      await route.continue()
    },
  )
  // A link inside the app, as the router follows it.
  await page.evaluate(
    (href) =>
      (
        window as unknown as { __TSR_ROUTER__: { navigate(o: { href: string }): Promise<void> } }
      ).__TSR_ROUTER__.navigate({
        href,
      }),
    `/projects/${project.id}/features/${b.id}#handoff`,
  )
  await expect(page).toHaveURL(new RegExp(`/features/${b.id}#handoff$`))
  await page.waitForTimeout(1_000)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('First in review')
  expect(await scrollY(page)).toBe(1500)
  expect(await marks(page)).toEqual([])

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Second in review')
  await expectRevealed(page, page.getByRole('region', { name: 'Hand-off' }))
  expect(await marks(page)).toEqual([{ id: 'handoff', shown: `#${b.id} Second in review` }])
})

for (const cached of [true, false])
  test(`Back to a ticket with an anchor${cached ? '' : ', no longer loaded,'} returns to where the reader left it`, async ({
    page,
    project,
    api,
    human,
  }) => {
    const a = await longTicket(api, human, 'Stepped to', 'review')
    const b = await longTicket(api, human, 'Linked first', 'review')
    await page.goto(`/projects/${project.id}/features/${b.id}#handoff`)
    await expectRevealed(page, page.getByRole('region', { name: 'Hand-off' }))
    await expectMarkGone(page)
    // The reader scrolls away from it, then steps to the other ticket in the column by its key.
    const left = await scrollTo(page, 1200)
    const step = page.locator(`a[title^="#${a.id} "]`)
    await page.keyboard.press((await step.getAttribute('aria-keyshortcuts'))!)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Stepped to')
    await feedDrawn(page)
    expect(await scrollTo(page, 1500)).toBe(1500)
    await recordMarks(page)
    if (!cached) {
      // Out of the cache, and slow to come back: the ticket is drawn well after the router restores.
      await page.evaluate(
        (id) =>
          (
            window as unknown as {
              __TSR_ROUTER__: {
                options: { context: { queryClient: { removeQueries(f: { queryKey: unknown[] }): void } } }
              }
            }
          ).__TSR_ROUTER__.options.context.queryClient.removeQueries({ queryKey: ['ticket', String(id)] }),
        b.id,
      )
      await page.route(
        (url) => url.pathname === `/api/tickets/${b.id}`,
        async (route) => {
          await new Promise((r) => setTimeout(r, 1_500))
          await route.continue()
        },
      )
    }
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/features/${b.id}#handoff$`))
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Linked first')
    await expect.poll(() => scrollY(page)).toBe(left)
    await page.waitForTimeout(1_000)
    expect(await scrollY(page)).toBe(left)
    expect(await marks(page)).toEqual([])
    await expect(page.locator('[data-revealed]')).toHaveCount(0)
  })

// --- on a phone ---

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a PR to review lands on its card with the queue already loaded and a filter that hides it', async ({
    page,
    project,
  }) => {
    await reviewFromCachedQueue(page, project)
  })

  test('a decision, a question and a reply land below the stuck header', async ({
    page,
    project,
    api,
    human,
    agent,
  }) => {
    let decision = 0
    let question = 0
    let thread = { post: 0, reply: 0 }
    const t = await longTicket(api, human, 'All on a phone', 'in_progress', async (id) => {
      thread = await answeredPost(human, agent, id, 'Phone thread')
      decision = (await askDecision(agent, id, 'Pick on the phone')).id
      question = (
        await ok<Row>(
          agent.post('/api/comments', {
            data: { parentType: 'ticket', parentId: id, body: 'Asked on the phone' },
          }),
        )
      ).id
    })

    await overview(page, project)
    await needsYou(page).getByRole('link', { name: 'Decide: Pick on the phone' }).click()
    await expectRevealed(page, post(page, decision))
    await expectInView(post(page, decision).getByRole('group', { name: 'Decision' }), ticketHeader(page))
    expect(await noSidewaysScroll(page)).toBe(true)

    await page.goBack()
    await needsYou(page)
      .getByRole('link', { name: `#${t.id} All on a phone`, exact: true })
      .click()
    await expectRevealed(page, post(page, question))
    expect(await noSidewaysScroll(page)).toBe(true)

    await page.goBack()
    await needsYou(page)
      .getByRole('listitem')
      .filter({ hasText: 'Phone thread: done' })
      .getByRole('link')
      .click()
    await expect(threadToggle(post(page, thread.post))).toHaveAttribute('aria-expanded', 'true')
    await expectRevealed(page, reply(page, thread.reply))
    expect(await noSidewaysScroll(page)).toBe(true)
  })

  test('a ticket in review lands on its hand-off card, past the feed', async ({
    page,
    project,
    api,
    human,
  }) => {
    const t = await longTicket(api, human, 'Review on a phone', 'review')
    await overview(page, project)
    await needsYou(page)
      .getByRole('link', { name: `#${t.id} Review on a phone`, exact: true })
      .click()
    await expectRevealed(page, page.getByRole('region', { name: 'Hand-off' }))
    // Below the feed at this width: well down the page.
    expect(await scrollY(page)).toBeGreaterThan(page.viewportSize()!.height)
    expect(await noSidewaysScroll(page)).toBe(true)
  })
})
