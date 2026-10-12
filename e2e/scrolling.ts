import type { APIRequestContext, Locator, Page } from '@playwright/test'

import { type Api, expect, ok } from './fixtures'

/** Posts as many progress posts on the ticket, each several lines long. */
export async function addPosts(human: APIRequestContext, ticketId: number, count = 20) {
  for (let i = 1; i <= count; i++) {
    const body = `Post ${i}.\n\n${'Some progress on the work, said at some length. '.repeat(6)}\n\nMore.`
    await ok(human.post(`/api/tickets/${ticketId}/updates`, { data: { body } }))
  }
}

/**
 * A ticket with a feed several screens long, so the page scrolls well past its header. `first` posts
 * what should be at the bottom of the feed (oldest), before the long posts come on top of it.
 */
export async function longTicket(
  api: Api,
  human: APIRequestContext,
  title: string,
  status = 'in_progress',
  first?: (ticketId: number) => Promise<unknown>,
) {
  const t = await api.ticket({
    title,
    status,
    body: Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of the instructions.`).join('\n\n'),
  })
  await first?.(t.id)
  await addPosts(human, t.id)
  return t
}

/** Waits for the feed to be drawn: its posts all come in one read. */
export const feedDrawn = (page: Page) =>
  expect(page.getByRole('article').filter({ hasText: 'Post 1.' })).toHaveCount(1)

/** The ticket page, with the whole feed drawn and the page several screens long. */
export async function openLong(page: Page, path: string) {
  await page.goto(path)
  await feedDrawn(page)
  const { height, screen } = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    screen: window.innerHeight,
  }))
  expect(height).toBeGreaterThan(3 * screen)
}

export const ticketHeader = (page: Page) => page.getByRole('main').locator('header')

export async function box(l: Locator) {
  const b = await l.boundingBox()
  expect(b, 'drawn on the page').not.toBeNull()
  return b!
}

export const scrollTo = (page: Page, y: number | 'bottom') =>
  page.evaluate((y) => {
    window.scrollTo(0, y === 'bottom' ? document.documentElement.scrollHeight : y)
    return window.scrollY
  }, y)

/**
 * Points spread over the element's box that hit something other than the element or what is in it:
 * whatever is drawn over it there. Empty when the element is on top all over. `inset` keeps the points
 * that far inside its edges: a rounded box does not take the clicks just inside its corners.
 */
export const coveredAt = (l: Locator, inset = 1) =>
  l.evaluate((el, inset) => {
    const r = el.getBoundingClientRect()
    const covered: string[] = []
    for (let i = 0; i <= 10; i++)
      for (let j = 0; j <= 4; j++) {
        const x = r.left + inset + ((r.width - 2 * inset) * i) / 10
        const y = r.top + inset + ((r.height - 2 * inset) * j) / 4
        const hit = document.elementFromPoint(x, y)
        if (!hit || !el.contains(hit))
          covered.push(`${Math.round(x)},${Math.round(y)}: ${hit?.outerHTML.slice(0, 80)}`)
      }
    return covered
  }, inset)
