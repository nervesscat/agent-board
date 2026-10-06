import type { APIRequestContext, Page } from '@playwright/test'

import { inDatabase } from './db'
import { type Api, expect, ok, test } from './fixtures'

/**
 * A ticket whose feed has a tall post from now, then two one-line posts from weeks back: the longest
 * legends there are, on posts shorter than them.
 */
async function feed(api: Api, human: APIRequestContext) {
  const t = await api.ticket({ title: 'A feed to lay out' })
  const post = (body: string) =>
    ok<{ id: number }>(human.post(`/api/tickets/${t.id}/updates`, { data: { body } }))
  for (const [weeks, body] of [
    [4, 'Older.'],
    [3, 'Old.'],
  ] as const) {
    const { id } = await post(body)
    const at = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString()
    inDatabase((db) => db.prepare('update updates set "createdAt" = ? where id = ?').run(at, id))
  }
  await post(Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of a long post.`).join('\n\n'))
  return t
}

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number }

/** Each row of the Activity feed, measured: its legend (the `<time>`), its two lines, its dot, its post. */
const rows = (page: Page) =>
  page.locator('ol > li:has(> time)').evaluateAll((lis) =>
    lis.map((li) => {
      const box = (el: Element | Range): Rect => {
        const { top, bottom, left, right, width, height } = el.getBoundingClientRect()
        return { top, bottom, left, right, width, height }
      }
      const time = li.querySelector(':scope > time') as HTMLElement
      const clockLine = time.querySelector('span') as HTMLElement
      const agoLine = document.createRange()
      agoLine.selectNodeContents(time.firstChild!)
      const style = getComputedStyle(time)
      return {
        li: box(li),
        time: box(time),
        agoLine: box(agoLine),
        clockLine: box(clockLine),
        dot: box(li.children[1]!.lastElementChild!),
        post: box(li.children[2]!),
        article: box(li.querySelector('article')!),
        text: time.textContent ?? '',
        dateTime: time.getAttribute('datetime'),
        title: time.getAttribute('title'),
        writingMode: style.writingMode,
        fontSizes: [parseFloat(style.fontSize), parseFloat(getComputedStyle(clockLine).fontSize)],
        clipped: time.scrollWidth > time.clientWidth + 1 || time.scrollHeight > time.clientHeight + 1,
      }
    }),
  )

const overlap = (a: Rect, b: Rect) =>
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1

/** What holds at every width: the legend runs down the rail, whole, beside its own dot and row. */
async function checkFeed(page: Page) {
  const measured = await rows(page)
  expect(measured).toHaveLength(3)
  measured.forEach((r, i) => {
    const at = `row ${i + 1}`
    expect(r.writingMode, at).toMatch(/^(vertical|sideways)-/)
    expect(r.time.height, at).toBeGreaterThan(r.time.width)
    expect(r.dateTime, at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r.title, at).toBeTruthy()
    expect(r.fontSizes[0], at).toBeGreaterThanOrEqual(12)
    expect(r.fontSizes[1], at).toBeGreaterThanOrEqual(11)
    expect(r.clipped, at).toBe(false)
    expect(overlap(r.agoLine, r.clockLine), at).toBe(false)
    expect(overlap(r.time, r.dot), at).toBe(false)
    // Inside its own row, starting by its dot however tall the post is.
    expect(r.time.left, at).toBeGreaterThanOrEqual(r.li.left - 1)
    expect(r.time.top, at).toBeGreaterThanOrEqual(r.li.top - 1)
    expect(r.time.bottom, at).toBeLessThanOrEqual(r.li.bottom + 1)
    expect(Math.abs(r.time.top - r.dot.top), at).toBeLessThanOrEqual(24)
  })
  const [now, old] = measured
  expect(now!.text).toMatch(/(minutes? ago|just now).*\d{1,2}:\d{2}/)
  expect(old!.text).toMatch(/3 weeks ago.*\d/)
  // The old legends are longer than their one-line posts are tall: still inside their own rows.
  expect(old!.time.height).toBeGreaterThan(old!.article.height)
  return measured
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the feed legend runs down the rail and the post gets the width', async ({ page, api, human }) => {
    const t = await feed(api, human)
    await page.goto(`/projects/${t.projectId}/features/${t.id}`)
    await expect(page.getByText('Paragraph 6 of a long post.')).toBeVisible()
    for (const r of await checkFeed(page)) {
      expect(r.post.left - r.li.left).toBeLessThanOrEqual(60)
      expect(r.post.width).toBeGreaterThanOrEqual(290)
    }
  })
})

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the feed legend runs down the rail', async ({ page, api, human }) => {
    const t = await feed(api, human)
    await page.goto(`/projects/${t.projectId}/features/${t.id}`)
    await expect(page.getByText('Paragraph 6 of a long post.')).toBeVisible()
    for (const r of await checkFeed(page)) expect(r.post.left - r.li.left).toBeLessThanOrEqual(80)
  })
})
