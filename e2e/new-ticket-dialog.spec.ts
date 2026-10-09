import type { Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { png, sendFile } from './files'
import { expect, ok, test } from './fixtures'

const LINES = 60
const TASKS = Array.from({ length: 40 }, (_, i) => `Task number ${i + 1}`)
// As many as a ticket takes.
const TAGS = Array.from({ length: 20 }, (_, i) => `Longer-tag-name-${i + 1}`)
const FILES = 4

const header = (dialog: Locator) => dialog.locator('[data-slot="dialog-header"]')
const footer = (dialog: Locator) => dialog.locator('[data-slot="dialog-footer"]')

async function box(el: Locator) {
  const b = await el.boundingBox()
  expect(b, 'the element is drawn').not.toBeNull()
  return b!
}

/** The element is drawn wholly inside the window (a pixel of rounding allowed). */
async function expectInWindow(page: Page, el: Locator, what: string) {
  const b = await box(el)
  const { width, height } = page.viewportSize()!
  const inside = b.x >= -1 && b.y >= -1 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1
  expect(inside, `${what} at ${JSON.stringify(b)} in ${width}x${height}`).toBe(true)
}

/** The element shows between the dialog's heading and its footer: not under either of them. */
async function expectBetweenEnds(dialog: Locator, el: Locator, what: string) {
  const [b, top, bottom] = await Promise.all([box(el), box(header(dialog)), box(footer(dialog))])
  expect(b.y, `${what} below the heading`).toBeGreaterThanOrEqual(top.y + top.height - 1)
  expect(b.y + b.height, `${what} above the footer`).toBeLessThanOrEqual(bottom.y + 1)
}

/**
 * Scrolls the part of the dialog that scrolls (the first element in it, itself included, that
 * overflows on a scrolling axis) to its top or its end, and returns its sizes; null when none does.
 */
const scrollFields = (dialog: Locator, to: 'top' | 'end') =>
  dialog.evaluate((d, to) => {
    const el = [d, ...d.querySelectorAll<HTMLElement>('*')].find(
      (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight,
    )
    if (!el) return null
    el.scrollTop = to === 'top' ? 0 : el.scrollHeight
    const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = el
    return { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth }
  }, to)

/** The heading, Create and the close button are on screen, uncovered, with the fields wherever they are. */
async function expectEndsInReach(page: Page, dialog: Locator, heading: string) {
  for (const [el, what] of [
    [dialog.getByRole('heading', { name: heading }), 'the heading'],
    [dialog.getByRole('button', { name: 'Create' }), 'Create'],
    [dialog.getByRole('button', { name: 'Close' }), 'the close button'],
  ] as const) {
    await expect(el).toBeInViewport({ ratio: 1 })
    await expectInWindow(page, el, what)
  }
  // Trial clicks: nothing else would take the click.
  await dialog.getByRole('button', { name: 'Create' }).click({ trial: true })
  await dialog.getByRole('button', { name: 'Close' }).click({ trial: true })
}

/**
 * Types many lines of instructions in the dialog from the keyboard, then checks the line being typed
 * is still in sight: the fields follow the caret, and it never hides under the footer.
 */
async function typeLongInstructions(page: Page, dialog: Locator) {
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  for (let i = 1; i <= LINES; i++) {
    if (i > 1) await page.keyboard.press('Enter')
    // One input per line, the way a fast typist or an IME delivers it: a key per character is slow.
    await page.keyboard.insertText(`Line ${i} of the instructions`)
  }
  const last = text.locator('p').last()
  await expect(last).toHaveText(`Line ${LINES} of the instructions`)
  await expect(last).toBeInViewport({ ratio: 1 })
  await expectBetweenEnds(dialog, last, 'the line being typed')
}

/** Fills the dialog with more than fits on any screen: long instructions, tasks, tags and files. */
async function fillTall(page: Page, dialog: Locator, { files = true } = {}) {
  await dialog.getByLabel('Title').fill('A long one')
  await typeLongInstructions(page, dialog)
  if (files) {
    const chooser = page.waitForEvent('filechooser')
    await dialog.getByRole('button', { name: 'attach' }).click()
    await (
      await chooser
    ).setFiles(
      Array.from({ length: FILES }, (_, i) => ({
        name: `picture-${i + 1}.png`,
        mimeType: 'image/png',
        buffer: png(8, [40 * i, 120, 200]),
      })),
    )
    await expect(dialog.getByRole('img')).toHaveCount(FILES)
    await expect(dialog.getByLabel('uploading')).toHaveCount(0)
  }
  await dialog.getByLabel('Initial tasks, one per line').fill(TASKS.join('\n'))
  await dialog.getByLabel('Tags (optional)').fill(TAGS.join(', '))
}

/** The fields scroll between the pinned ends, from the Title at the top to `last` at the end. */
async function expectFieldsScroll(page: Page, dialog: Locator, heading: string, last: Locator[]) {
  const end = await scrollFields(dialog, 'end')
  expect(end, 'a part of the dialog scrolls').not.toBeNull()
  expect(end!.scrollHeight).toBeGreaterThan(end!.clientHeight)
  expect(end!.scrollTop).toBeGreaterThan(0)
  for (const el of last) {
    await expect(el).toBeInViewport({ ratio: 1 })
    await expectBetweenEnds(dialog, el, 'the last fields')
  }
  await expectInWindow(page, dialog, 'the dialog')
  await expectEndsInReach(page, dialog, heading)

  expect((await scrollFields(dialog, 'top'))!.scrollTop).toBe(0)
  const title = dialog.getByLabel('Title')
  await expect(title).toBeInViewport({ ratio: 1 })
  await expectBetweenEnds(dialog, title, 'the Title input')
}

/** The page behind the dialog: not scrolled, and no taller than before the dialog opened. */
const pageScroll = (page: Page) =>
  page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }))

test('the New ticket dialog with long content stays on screen, scrolls its fields between a pinned heading and Create, and creates the ticket', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const before = await pageScroll(page)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await fillTall(page, dialog)

  await expectInWindow(page, dialog, 'the dialog')
  await expectFieldsScroll(page, dialog, 'New ticket', [
    dialog.getByLabel('Tags (optional)'),
    dialog.getByLabel('Branch (optional)'),
  ])
  await expectEndsInReach(page, dialog, 'New ticket')
  expect(await pageScroll(page)).toEqual({ y: 0, height: before.height })

  // Create, from the top of the fields, without scrolling to it.
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.title).toBe('A long one')
  expect(ticket.body).toContain(`Line ${LINES} of the instructions`)
  expect(ticket.tasks.map((t) => t.text)).toEqual(TASKS)
  expect([...ticket.tags].sort()).toEqual([...TAGS].sort())
  expect(ticket.attachments).toHaveLength(FILES)
})

test('the close button and Esc close the New ticket dialog with long content, from either end of its fields', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const open = page.getByRole('button', { name: 'New ticket' })
  await open.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Closed again')
  await typeLongInstructions(page, dialog)
  const close = dialog.getByRole('button', { name: 'Close' })

  await scrollFields(dialog, 'end')
  await expectEndsInReach(page, dialog, 'New ticket')
  await close.click()
  await expect(dialog).toBeHidden()

  // Opened again, it keeps what was typed, so it is just as long.
  await open.click()
  await expect(dialog.getByLabel('Title')).toHaveValue('Closed again')
  expect(await scrollFields(dialog, 'top')).not.toBeNull()
  await expectEndsInReach(page, dialog, 'New ticket')
  await close.click()
  await expect(dialog).toBeHidden()

  await open.click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('the Stage picker opens and picks over the scrolled fields of a long New ticket dialog', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Picked while scrolled')
  await typeLongInstructions(page, dialog)
  await scrollFields(dialog, 'end')

  const stage = dialog.getByLabel('Stage')
  await expectBetweenEnds(dialog, stage, 'the Stage picker')
  await stage.click()
  const option = page.getByRole('option', { name: 'In progress', exact: true })
  await expect(option).toBeInViewport({ ratio: 1 })
  await option.click()
  await expect(stage).toContainText('In progress')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(row).toMatchObject({ title: 'Picked while scrolled', status: 'in_progress' })
})

test('files drop on the heading, the scrolled fields and the footer of a long New ticket dialog, and the drag ring outlines all of it', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Dropped on')
  await typeLongInstructions(page, dialog)
  const fields = (await scrollFields(dialog, 'end'))!
  expect(fields.scrollTop).toBeGreaterThan(0)

  // Files dragged over the fields light up the dialog itself, the box around the heading and footer.
  const ring = () => dialog.evaluate((d) => getComputedStyle(d).boxShadow)
  const still = await ring()
  await dialog.locator('form').evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'over.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await expect.poll(ring).not.toBe(still)
  await dialog.locator('form').evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'over.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await expect.poll(ring).toBe(still)

  const targets = [
    '[role="dialog"] h2',
    '[role="dialog"] form',
    '[role="dialog"] [data-slot="dialog-footer"]',
  ]
  for (const [i, target] of targets.entries()) {
    await sendFile(page, target, 'drop', {
      name: `dropped-${i + 1}.png`,
      mime: 'image/png',
      data: png(8, [200, 40 * i, 40]),
    })
    await expect(dialog.getByRole('img', { name: `dropped-${i + 1}.png` })).toHaveCount(1)
    await expect(dialog.getByRole('img')).toHaveCount(i + 1)
  }
})

test('the New ticket dialog with nothing in it does not scroll, and keeps its size and its footer strip', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Title')).toBeFocused()
  // Measured once it has zoomed in to its full size.
  await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)))

  expect(await scrollFields(dialog, 'top')).toBeNull()
  const d = await box(dialog)
  expect(d.height).toBeLessThan(page.viewportSize()!.height)
  expect(d.width).toBe(576)
  // The heading keeps its padding from the top edge; the footer strip runs to the bottom and the sides.
  const heading = await box(dialog.getByRole('heading', { name: 'New ticket' }))
  const bottom = await box(footer(dialog))
  expect(heading.y - d.y).toBeCloseTo(16, 0)
  expect(bottom.x).toBeCloseTo(d.x, 0)
  expect(bottom.width).toBeCloseTo(d.width, 0)
  expect(bottom.y + bottom.height).toBeCloseTo(d.y + d.height, 0)
  await expectEndsInReach(page, dialog, 'New ticket')
})

test('the New lane dialog with long content stays on screen, scrolls its fields and creates the lane', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Parent', status: 'in_progress' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const before = await pageScroll(page)
  await page.getByRole('button', { name: 'New lane' }).click()
  const dialog = page.getByRole('dialog')
  await fillTall(page, dialog, { files: false })

  await expectInWindow(page, dialog, 'the dialog')
  await expectEndsInReach(page, dialog, 'New lane')
  await expectFieldsScroll(page, dialog, 'New lane', [
    dialog.getByLabel('Tags (optional)'),
    dialog.getByLabel('Branch (optional)'),
  ])
  expect((await pageScroll(page)).y).toBe(before.y)

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await api.getTicket(t.id)).lanes.map((l) => l.title)).toEqual(['A long one'])
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the New ticket dialog with long content fits the screen, scrolls only up and down, and creates the ticket', async ({
    page,
    project,
    human,
  }) => {
    await page.goto(`/projects/${project.id}/features`)
    const before = await pageScroll(page)
    await page.getByRole('button', { name: 'New ticket' }).click()
    const dialog = page.getByRole('dialog')
    await fillTall(page, dialog)

    await expectInWindow(page, dialog, 'the dialog')
    await expectFieldsScroll(page, dialog, 'New ticket', [dialog.getByLabel('Tags (optional)')])
    await expectEndsInReach(page, dialog, 'New ticket')
    const fields = (await scrollFields(dialog, 'top'))!
    expect(fields.scrollWidth).toBeLessThanOrEqual(fields.clientWidth)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ).toBe(false)
    expect(await pageScroll(page)).toEqual({ y: 0, height: before.height })

    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()
    const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
    const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
    expect(ticket.tasks).toHaveLength(TASKS.length)
    expect(ticket.tags).toHaveLength(TAGS.length)
    expect(ticket.attachments).toHaveLength(FILES)
  })
})
