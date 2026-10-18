import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Gallery } from '#/lib/api'
import { fileSize, localDate, shiftDate } from '#/lib/format'
import { AGENT } from './env'
import { uploadedAt } from './db'
import { type Api, expect, expectTooltip, ok, test } from './fixtures'
import { png, pdf } from './files'
import { box, coveredAt, feedDrawn, longTicket, ticketHeader } from './scrolling'

/**
 * The project's Gallery: every file on its tickets as a grid, filtered by kind and upload day in the
 * URL, a page at a time; a tile opens its file in the lightbox and links to its ticket, and to the post
 * or reply it came with.
 */

type Row = { id: number }
type Upload = { id: number; url: string; size: number }

// Not a playable video: enough for the tile to be a <video>, which only reads its metadata.
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01])

async function upload(ctx: APIRequestContext, name: string, data: Buffer, mime?: string) {
  return ok<Upload>(ctx.post('/api/uploads', { data: { name, base64: data.toString('base64'), mime } }))
}
const postWith = (ctx: APIRequestContext, ticketId: number, attachmentIds: number[], body = 'Files.') =>
  ok<Row>(ctx.post(`/api/tickets/${ticketId}/updates`, { data: { body, attachmentIds } }))

const gallery = (page: Page, projectId: number, search = '') =>
  page.goto(`/projects/${projectId}/gallery${search}`)
const tiles = (page: Page) => page.locator('li[data-file]')
const tile = (page: Page, name: string) => tiles(page).filter({ has: page.getByText(name, { exact: true }) })
const names = (page: Page) => tiles(page).locator('[data-slot="file-name"]')
/** The names on the tiles now: only once the tiles are known to be there (allInnerTexts does not wait). */
const tileNames = (page: Page) => names(page).allInnerTexts()
const thumb = (t: Locator) => t.getByRole('link', { name: /^Open .+\./ })

const typeChips = (page: Page) => page.getByRole('group', { name: 'File type' })
const chip = (page: Page, name: string) => typeChips(page).getByRole('button', { name, exact: true })
const dayButton = (page: Page, name: 'From' | 'To') =>
  page.getByRole('button', { name: new RegExp(`^${name}\\b`) })
const calendar = (page: Page) => page.locator('[data-slot="popover-content"]')

/** Picks `day` (YYYY-MM-DD) in the From or To date picker, going back a month or two to reach it. */
async function pickDay(page: Page, name: 'From' | 'To', day: string) {
  await dayButton(page, name).click()
  const cell = calendar(page).locator(`td[data-day="${day}"]:not([data-outside]) button`)
  for (let back = 0; back < 3 && !(await cell.isVisible()); back++)
    await calendar(page)
      .getByRole('button', { name: /previous month/i })
      .click()
  await cell.click()
  await expect(calendar(page)).toHaveCount(0)
}

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

test('the Gallery module lists the files with their size, uploader, time and ticket, and opens them in place', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Screens of the parser', status: 'in_progress' })
  const longName = 'a-very-long-file-name-for-the-screenshot-of-the-parser-error-dialog.png'
  const image = await upload(agent, longName, png(64))
  const doc = await upload(agent, 'spec.pdf', pdf('Spec'))
  const video = await upload(agent, 'clip.webm', WEBM, 'video/webm')
  const notes = await upload(agent, 'notes.md', Buffer.from('# Notes\n\nThe parser is fixed.'))
  const blob = await upload(agent, 'blob.bin', Buffer.alloc(3000, 1))
  await postWith(agent, t.id, [image.id, doc.id, video.id, notes.id, blob.id])

  // Every request the page makes, to show the PDF's bytes are not read before it is opened.
  const requested: string[] = []
  page.on('request', (r) => requested.push(new URL(r.url()).pathname))

  await page.goto(`/projects/${project.id}`)
  const link = page.getByRole('navigation').getByRole('link', { name: 'Gallery', exact: true })
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/gallery$`))
  await expect(link).toHaveClass(/active/)
  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible()
  await expect(tiles(page)).toHaveCount(5)

  const shot = tile(page, longName)
  await expect(shot).toContainText(fileSize(image.size))
  await expect(shot).toContainText(AGENT)
  await expect(shot).toContainText('just now')
  await expect(shot).toContainText(`#${t.id} Screens of the parser`)
  // The name is cut short on the tile; the whole of it shows on hover, as does the exact time.
  await expectTooltip(shot.getByText(longName, { exact: true }), longName)
  await expectTooltip(shot.locator('time'), /\d/)

  // An image is the file itself, loaded lazily; a video only its first frame, never playing.
  await expect(thumb(shot).locator('img')).toHaveAttribute('loading', 'lazy')
  await expect(thumb(shot).locator('img')).toHaveAttribute('src', image.url)
  const clip = thumb(tile(page, 'clip.webm')).locator('video')
  await expect(clip).toHaveAttribute('preload', 'metadata')
  expect(await clip.evaluate((v: HTMLVideoElement) => v.autoplay || v.hasAttribute('autoplay'))).toBe(false)
  // A PDF, a text file and any other file are icons with their name.
  for (const name of ['spec.pdf', 'notes.md', 'blob.bin']) {
    await expect(thumb(tile(page, name)).locator('img, video, iframe, canvas')).toHaveCount(0)
    await expect(thumb(tile(page, name)).locator('svg')).toHaveCount(1)
  }
  await expect(thumb(tile(page, 'notes.md'))).toContainText('MD')

  await page.waitForLoadState('networkidle')
  expect(requested).toContain(image.url)
  expect(requested).not.toContain(doc.url)

  // Opened in place: the lightbox, stepping through the gallery's tiles; the URL stays on the gallery.
  const dialog = page.getByRole('dialog')
  await thumb(shot).click()
  await expect(dialog.locator(`img[src="${image.url}"]`)).toBeVisible()
  await expect(dialog).toContainText('/ 5')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await thumb(tile(page, 'spec.pdf')).click()
  await expect(dialog.locator('iframe')).toHaveAttribute('src', doc.url)
  await expect.poll(() => requested.includes(doc.url)).toBe(true)
  await page.keyboard.press('Escape')

  await thumb(tile(page, 'notes.md')).click()
  await expect(dialog).toContainText('The parser is fixed.')
  await page.keyboard.press('Escape')

  await thumb(tile(page, 'blob.bin')).click()
  await expect(dialog.getByText('No preview for this file type.')).toBeVisible()
  // The panel's own Download link (the header's is an icon).
  await expect(dialog.getByText('Download', { exact: true })).toHaveAttribute('href', blob.url)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/gallery$`))
})

test('the type, day and archived filters live in the URL, survive a reload, and show an empty state', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  await gallery(page, project.id)
  await expect(page.getByText('No files on this project yet.')).toBeVisible()

  const t = await api.ticket({ title: 'Filtered', status: 'in_progress' })
  const files = [
    await upload(agent, 'shot.png', png()),
    await upload(agent, 'spec.pdf', pdf()),
    await upload(agent, 'notes.md', Buffer.from('notes')),
  ]
  await postWith(
    agent,
    t.id,
    files.map((f) => f.id),
  )
  // A done ticket the human archived: its file shows only with Include archived.
  const old = await api.ticket({ title: 'Shipped long ago', status: 'done' })
  const archivedFile = await upload(agent, 'archived.png', png())
  await postWith(agent, old.id, [archivedFile.id])
  await ok(human.post(`/api/tickets/${old.id}/archive`))
  // All uploaded on one local day, a minute apart in this order: the day filters and the order then
  // hold in any time zone and at any hour the test runs, midnight too.
  const day = shiftDate(localDate(), -10)
  for (const [i, f] of [...files, archivedFile].entries()) uploadedAt(f.id, new Date(`${day}T12:0${i}:00`))

  await gallery(page, project.id)
  await expect(tiles(page)).toHaveCount(3)
  // The kinds are chips like the PR queue's, any number on at once; no checkboxes.
  await expect(typeChips(page).getByRole('button')).toHaveText([
    'Images',
    'Videos',
    'PDFs',
    'Documents and text',
    'Other',
  ])
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await chip(page, 'Images').click()
  await chip(page, 'PDFs').click()
  await expect(page).toHaveURL(/[?&]type=image(,|%2C)pdf(&|$)/)
  await expect(tiles(page)).toHaveCount(2)
  expect((await tileNames(page)).sort()).toEqual(['shot.png', 'spec.pdf'])
  await expect(chip(page, 'Images')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(page, 'Images')).toHaveAttribute('data-active', '')
  await expect(chip(page, 'Videos')).toHaveAttribute('aria-pressed', 'false')
  // Off again, and on: the URL follows each toggle.
  await chip(page, 'PDFs').click()
  await expect(page).toHaveURL(/[?&]type=image(&|$)/)
  await expect(tiles(page)).toHaveCount(1)
  await chip(page, 'PDFs').click()
  await expect(page).toHaveURL(/[?&]type=image(,|%2C)pdf(&|$)/)

  // The days are date pickers, each a button opening a calendar; no native date inputs.
  await expect(page.locator('input[type="date"]')).toHaveCount(0)
  await expect(dayButton(page, 'From')).toHaveText('From')
  await expect(dayButton(page, 'To')).toHaveText('To')
  await pickDay(page, 'From', day)
  await expect(page).toHaveURL(new RegExp(`from=${day}`))
  // To cannot be before From: the day before it is off.
  await dayButton(page, 'To').click()
  await expect(
    calendar(page)
      .locator(`td[data-day="${shiftDate(day, -1)}"] button`)
      .first(),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(calendar(page)).toHaveCount(0)
  await pickDay(page, 'To', day)
  await expect(page).toHaveURL(new RegExp(`to=${day}`))
  await expect(tiles(page)).toHaveCount(2)
  // And From cannot be after To.
  await dayButton(page, 'From').click()
  await expect(
    calendar(page)
      .locator(`td[data-day="${shiftDate(day, 1)}"] button`)
      .first(),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(calendar(page)).toHaveCount(0)
  const shown = new Date(`${day}T00:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  await expect(dayButton(page, 'From')).toHaveText(shown)

  await page.reload()
  await expect(tiles(page)).toHaveCount(2)
  expect((await tileNames(page)).sort()).toEqual(['shot.png', 'spec.pdf'])
  await expect(chip(page, 'Images')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(page, 'PDFs')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(page, 'Videos')).toHaveAttribute('aria-pressed', 'false')
  await expect(dayButton(page, 'From')).toHaveText(shown)
  await expect(dayButton(page, 'To')).toHaveText(shown)

  // Each day clears on its own.
  await page.getByRole('button', { name: 'Clear To' }).click()
  await expect(page).not.toHaveURL(/[?&]to=/)
  await expect(page).toHaveURL(new RegExp(`from=${day}`))
  await expect(dayButton(page, 'To')).toHaveText('To')
  await page.getByRole('button', { name: 'Clear From' }).click()
  await expect(page).not.toHaveURL(/[?&]from=/)
  await expect(dayButton(page, 'From')).toHaveText('From')
  await expect(tiles(page)).toHaveCount(2)

  // A day with no upload: the empty state, and no error.
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await pickDay(page, 'From', shiftDate(day, -3))
  await pickDay(page, 'To', shiftDate(day, -1))
  await expect(page.getByText('No files match these filters.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(tiles(page)).toHaveCount(3)
  expect(errors).toEqual([])

  const archived = page.getByRole('switch', { name: 'Include archived' })
  await archived.click()
  await expect(page).toHaveURL(/[?&]archived=include/)
  await expect(tile(page, 'archived.png')).toContainText(`#${old.id} Shipped long ago`)
  await expect(tiles(page)).toHaveCount(4)
  await page.reload()
  await expect(archived).toBeChecked()
  await expect(tiles(page)).toHaveCount(4)

  // Oldest first, from the URL. The tiles come once the list has loaded: wait for them, in order.
  await gallery(page, project.id, '?sort=oldest')
  await expect(names(page)).toHaveText(['shot.png', 'spec.pdf', 'notes.md'])
  await gallery(page, project.id)
  await expect(names(page)).toHaveText(['notes.md', 'spec.pdf', 'shot.png'])

  // Values it does not know are left out: the gallery unfiltered on that count.
  await gallery(page, project.id, '?type=bogus&from=someday&sort=sideways')
  await expect(tiles(page)).toHaveCount(3)
  await expect(chip(page, 'Images')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText('Newest first')
  await expect(names(page)).toHaveText(['notes.md', 'spec.pdf', 'shot.png'])
  await expect(page.getByText('No files match')).toHaveCount(0)
})

test('the sort control offers every order with an icon, names the current one on hover, and keeps it in the URL', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Sorted', status: 'in_progress' })
  // Uploaded in this order, a minute apart; names, sizes and kinds each in another order.
  const named = ['beta.pdf', 'Alpha.png', 'gamma.md', 'delta.png']
  const made = [
    await upload(agent, named[0]!, pdf('a longer document than the others, by a fair few bytes')),
    await upload(agent, named[1]!, png(8)),
    await upload(agent, named[2]!, Buffer.from('a note')),
    await upload(agent, named[3]!, png(64)),
  ]
  await postWith(
    agent,
    t.id,
    made.map((f) => f.id),
  )
  const day = shiftDate(localDate(), -2)
  for (const [i, f] of made.entries()) uploadedAt(f.id, new Date(`${day}T12:0${i}:00`))
  const bySize = made
    .map((f, i) => ({ ...f, name: named[i]! }))
    .sort((a, b) => b.size - a.size || b.id - a.id)
    .map((f) => f.name)

  await gallery(page, project.id)
  await expect(names(page)).toHaveText(['delta.png', 'gamma.md', 'Alpha.png', 'beta.pdf'])
  const sort = page.getByRole('combobox', { name: 'Sort' })
  await expect(sort).toContainText('Newest first')
  // The order's icon, then the chevron.
  await expect(sort.locator('svg')).toHaveCount(2)
  await expectTooltip(sort, 'Sort: Newest first')
  await expect(sort).not.toHaveAttribute('title')

  await sort.click()
  const options = page.getByRole('option')
  await expect(options).toHaveText([
    'Newest first',
    'Oldest first',
    'Name A to Z',
    'Name Z to A',
    'Largest first',
    'Smallest first',
    'By type',
  ])
  for (const option of await options.all()) await expect(option.locator('svg').first()).toBeVisible()
  await page.getByRole('option', { name: 'Name A to Z' }).click()
  await expect(page).toHaveURL(/[?&]sort=name(&|$)/)
  await expect(names(page)).toHaveText(['Alpha.png', 'beta.pdf', 'delta.png', 'gamma.md'])
  await page.reload()
  await expect(names(page)).toHaveText(['Alpha.png', 'beta.pdf', 'delta.png', 'gamma.md'])
  await expect(sort).toContainText('Name A to Z')
  await expectTooltip(sort, 'Sort: Name A to Z')

  const orders: [string, string, string[]][] = [
    ['Name Z to A', 'name-desc', ['gamma.md', 'delta.png', 'beta.pdf', 'Alpha.png']],
    ['Largest first', 'largest', bySize],
    ['Smallest first', 'smallest', [...bySize].reverse()],
    ['By type', 'type', ['Alpha.png', 'delta.png', 'beta.pdf', 'gamma.md']],
    ['Oldest first', 'oldest', ['beta.pdf', 'Alpha.png', 'gamma.md', 'delta.png']],
  ]
  for (const [label, key, order] of orders) {
    await sort.click()
    await page.getByRole('option', { name: label }).click()
    await expect(page).toHaveURL(new RegExp(`[?&]sort=${key}(&|$)`))
    await expect(names(page)).toHaveText(order)
  }
  // Newest first is the default: no sort in the URL.
  await sort.click()
  await page.getByRole('option', { name: 'Newest first' }).click()
  await expect(page).not.toHaveURL(/[?&]sort=/)
  await expect(names(page)).toHaveText(['delta.png', 'gamma.md', 'Alpha.png', 'beta.pdf'])
})

test("a tile links to its ticket, a lane's to the top-level ticket, and a thread link lands on the post or reply, marked", async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  let thread = { post: 0, reply: 0 }
  // The reply is deep down a long feed, in a thread that loads only once opened.
  const t = await longTicket(api, human, 'Deep thread', 'in_progress', async (id) => {
    const p = await ok<Row>(
      human.post(`/api/tickets/${id}/updates`, { data: { body: 'Does it render?', progress: false } }),
    )
    const shot = await upload(agent, 'reply-shot.png', png())
    const r = await ok<Row>(
      agent.post('/api/comments', {
        data: { parentType: 'update', parentId: p.id, body: 'It does, see this.', attachmentIds: [shot.id] },
      }),
    )
    thread = { post: p.id, reply: r.id }
  })
  const postFile = await upload(agent, 'post-shot.png', png())
  const post = await postWith(agent, t.id, [postFile.id], 'A post with a file.')
  await ok(
    human.post(`/api/tickets/${t.id}/attachments`, {
      data: { attachmentIds: [(await upload(human, 'brief.pdf', pdf())).id] },
    }),
  )
  const lane = await ok<Row>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'The lane', parentId: t.id, status: 'in_progress' },
    }),
  )
  const lanePost = await postWith(agent, lane.id, [(await upload(agent, 'lane-shot.png', png())).id])

  await gallery(page, project.id)
  await expect(tiles(page)).toHaveCount(4)
  // A lane's file is under its top-level ticket, with the lane named below it.
  const laneTile = tile(page, 'lane-shot.png')
  await expect(laneTile).toContainText(`#${t.id} Deep thread`)
  await expect(laneTile).toContainText(`in lane #${lane.id} The lane`)
  await expectTooltip(laneTile.getByText(`in lane #${lane.id} The lane`), `In lane #${lane.id} The lane`)
  // Instructions have no post to land on: only the ticket.
  await expect(tile(page, 'brief.pdf').getByRole('link', { name: 'Open thread' })).toHaveCount(0)
  await expect(tile(page, 'brief.pdf').getByRole('link', { name: 'Open ticket' })).toHaveAttribute(
    'href',
    `/projects/${project.id}/features/${t.id}`,
  )

  await laneTile.getByRole('link', { name: 'Open ticket' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Deep thread')

  // The lane's post is shown on the top-level ticket's page, its lanes' posts folded in, and marked.
  await gallery(page, project.id)
  await tile(page, 'lane-shot.png').getByRole('link', { name: 'Open thread' }).click()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}#post-${lanePost.id}$`))
  // An agent's progress post is in the Agents tab, which the link opens; the long feed is in Main.
  const shown = page.locator(`#post-${lanePost.id}`)
  await expect(shown).toHaveAttribute('data-revealed', '')
  await expect(page.locator('[data-revealed]')).toHaveCount(1)
  await expect(shown).toBeInViewport()
  await expect(shown).toContainText('The lane')

  await gallery(page, project.id)
  const replyLink = tile(page, 'reply-shot.png').getByRole('link', { name: 'Open thread' })
  await expect(replyLink).toHaveAttribute(
    'href',
    `/projects/${project.id}/features/${t.id}#post-${thread.post}-reply-${thread.reply}`,
  )
  await replyLink.click()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}#post-${thread.post}-reply-${thread.reply}$`))
  await feedDrawn(page)
  const reply = page.locator(`#reply-${thread.reply}`)
  await expect(reply).toHaveAttribute('data-revealed', '')
  await expect(page.locator('[data-revealed]')).toHaveCount(1)
  await expect(reply).toBeInViewport()
  await expect(reply).toContainText('It does, see this.')
  // Below the ticket's stuck header, with nothing drawn over it.
  const header = await box(ticketHeader(page))
  expect((await box(reply)).y).toBeGreaterThanOrEqual(header.y + header.height - 1)
  expect(await coveredAt(reply, 6)).toEqual([])

  await gallery(page, project.id)
  await tile(page, 'post-shot.png').getByRole('link', { name: 'Open thread' }).click()
  await expect(page).toHaveURL(new RegExp(`/features/${t.id}#post-${post.id}$`))
  await expect(page.locator(`#post-${post.id}`)).toHaveAttribute('data-revealed', '')
  await expect(page.locator(`#post-${post.id}`)).toBeInViewport()
})

/** `count` small files on one post of a new ticket, each its own upload. */
async function manyFiles(api: Api, agent: APIRequestContext, count: number) {
  const t = await api.ticket({ title: 'Many files' })
  const ids: number[] = []
  for (let i = 0; i < count; i++)
    ids.push(
      (
        await upload(
          agent,
          `build-output-with-a-rather-long-name-number-${String(i).padStart(3, '0')}.bin`,
          Buffer.from([i]),
        )
      ).id,
    )
  await postWith(agent, t.id, ids)
  return t
}

const more = (page: Page) => page.locator('[data-slot="more-files"]')

test('a large gallery comes a page at a time, the next as the grid is scrolled to its end', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  await manyFiles(api, agent, 61)
  const first = await ok<Gallery>(human.get(`/api/projects/${project.id}/gallery`))
  expect(first.items).toHaveLength(60)
  expect(first.next).toBeTruthy()

  await gallery(page, project.id)
  await expect(tiles(page)).toHaveCount(60)
  // Nothing more until the end of the grid nears the screen.
  await expect(more(page)).not.toBeInViewport()
  await page.waitForLoadState('networkidle')
  await expect(tiles(page)).toHaveCount(60)

  await more(page).scrollIntoViewIfNeeded()
  await expect(tiles(page)).toHaveCount(61)
  // After the last page there is nothing more to load.
  await expect(more(page)).toHaveCount(0)
  // The last page brought the oldest, and none twice.
  expect(new Set(await tileNames(page)).size).toBe(61)
  await expect(tiles(page).last()).toContainText('number-000.bin')

  // The lightbox steps through every tile loaded.
  await thumb(tiles(page).last()).click()
  await expect(page.getByRole('dialog')).toContainText('61 / 61')
})

test('tabbing through the tiles to the last loads the next page too, and on into it', async ({
  page,
  project,
  api,
  agent,
}) => {
  await manyFiles(api, agent, 61)
  await gallery(page, project.id)
  await expect(tiles(page)).toHaveCount(60)
  // From a tile some rows above the end, by the keyboard alone: each Tab scrolls the focused link into
  // view, and the end of the grid with it, until the next page comes and Tab goes on into it.
  await thumb(tiles(page).nth(44)).focus()
  const focusedTile = () =>
    page.evaluate(() => {
      const li = document.activeElement?.closest('li[data-file]')
      return li ? [...document.querySelectorAll('li[data-file]')].indexOf(li) : -1
    })
  let at = await focusedTile()
  for (let presses = 0; at < 60 && presses < 200; presses++) {
    await page.keyboard.press('Tab')
    at = await focusedTile()
  }
  expect(at).toBe(60)
  await expect(tiles(page)).toHaveCount(61)
  await expect(tiles(page).nth(60)).toContainText('number-000.bin')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('no sideways scroll at 390px: filters, tiles with long names, and the next page as it scrolls', async ({
    page,
    project,
    api,
    agent,
  }) => {
    await manyFiles(api, agent, 61)
    const today = localDate()
    await gallery(
      page,
      project.id,
      `?type=other,docs&archived=include&from=${today}&to=${today}&sort=name-desc`,
    )
    await expect(tiles(page)).toHaveCount(60)
    // The chips, both date pickers with a day and the sort control fit the screen, wrapping as they need.
    await expect(chip(page, 'Other')).toHaveAttribute('aria-pressed', 'true')
    for (const control of [
      ...(await typeChips(page).getByRole('button').all()),
      dayButton(page, 'From'),
      dayButton(page, 'To'),
      page.getByRole('combobox', { name: 'Sort' }),
    ]) {
      await expect(control).toBeVisible()
      const b = await box(control)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(390)
    }
    expect(await scrollsSideways(page)).toBe(false)
    // Fewer columns than on a desktop: two tiles side by side.
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => box(tiles(page).nth(i))))
    expect(a!.y).toBe(b!.y)
    expect(c!.y).toBeGreaterThan(a!.y)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect(tiles(page)).toHaveCount(61)
    await expect(more(page)).toHaveCount(0)
    expect(new Set(await tileNames(page)).size).toBe(61)
    expect(await scrollsSideways(page)).toBe(false)
  })
})
