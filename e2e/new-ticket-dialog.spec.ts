import type { Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { png, sendFile } from './files'
import { type Api, expect, ok, test } from './fixtures'

const LINES = 60
const TASKS = Array.from({ length: 40 }, (_, i) => `Task number ${i + 1}`)
// A new ticket starts with the project's default phases, the typed tasks under the first.
const PHASES = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Merged']
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

/**
 * The paragraph holding the caret shows between the dialog's heading and its footer, and is what is
 * drawn at its middle: nothing pinned covers it. Measured once the frame after the key has been drawn.
 */
async function expectCaretLineInSight(page: Page, dialog: Locator, what: string) {
  const line = await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    const node = getSelection()?.focusNode
    const p = (node instanceof Element ? node : node?.parentElement)?.closest('p')
    if (!p) return null
    const r = p.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + Math.min(r.width / 2, 40), r.y + r.height / 2)
    return { top: r.top, bottom: r.bottom, uncovered: hit?.closest('p') === p }
  })
  expect(line, `${what}: the caret is in a paragraph`).not.toBeNull()
  const [top, bottom] = await Promise.all([box(header(dialog)), box(footer(dialog))])
  const at = `${what} at ${line!.top}..${line!.bottom}, heading to ${top.y + top.height}, footer from ${bottom.y}`
  expect(line!.top, `${at}: below the heading`).toBeGreaterThanOrEqual(top.y + top.height - 1)
  expect(line!.bottom, `${at}: above the footer`).toBeLessThanOrEqual(bottom.y + 1)
  expect(line!.uncovered, `${at}: drawn uncovered`).toBe(true)
}

/**
 * Types lines of instructions, then presses Enter at their end with nothing typed after it, a few
 * times over: each new empty line, and the caret in it, is scrolled clear of the footer by the editor
 * itself, which does not go by the fields' scroll padding.
 */
async function expectEntersAtTheEndInSight(page: Page, dialog: Locator, lines: number) {
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  for (let i = 1; i <= lines; i++) {
    if (i > 1) await page.keyboard.press('Enter')
    await page.keyboard.insertText(`Line ${i} of the instructions`)
  }
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press('Enter')
    await expectCaretLineInSight(page, dialog, `empty line ${i} after the instructions`)
  }
  // Typing on the empty line, then Enter again: the next one shows too.
  await page.keyboard.insertText('More')
  await expectCaretLineInSight(page, dialog, 'the line typed after them')
  for (let i = 1; i <= 2; i++) {
    await page.keyboard.press('Enter')
    await expectCaretLineInSight(page, dialog, `empty line ${i} after the typed one`)
  }
  await expect(text.locator('p')).toHaveCount(lines + 5)
}

/**
 * With long instructions, scrolls the fields so that one line hides under the heading, the next one
 * just below it, and with the caret at the start of that next line presses Backspace: the two join on
 * the hidden line, and the editor scrolls the caret's line out from under the heading.
 */
async function expectBackspaceJoinUnderHeadingInSight(page: Page, dialog: Locator) {
  const lines = dialog.getByRole('textbox', { name: 'Instructions' }).locator('p')
  // Line `n + 1` is the paragraph at index `n`.
  const n = 20
  await page.keyboard.press('Control+Home')
  for (let i = 1; i <= n; i++) await page.keyboard.press('ArrowDown')
  await lines.nth(n).evaluate((next) => {
    const form = next.closest('form')!
    const head = form.querySelector('[data-slot="dialog-header"]')!
    form.scrollTop += next.getBoundingClientRect().top - head.getBoundingClientRect().bottom - 20
  })
  const [under, head] = await Promise.all([box(lines.nth(n - 1)), box(header(dialog))])
  expect(under.y, 'the line to join onto starts under the heading').toBeLessThan(head.y + head.height)

  await page.keyboard.press('Backspace')
  await expect(lines.nth(n - 1)).toHaveText(`Line ${n} of the instructionsLine ${n + 1} of the instructions`)
  await expectCaretLineInSight(page, dialog, 'the joined line')

  // Undone with the fields scrolled to their end, the caret goes back up to its line: the editor
  // scrolls it in from above, to below the heading.
  expect((await scrollFields(dialog, 'end'))!.scrollTop).toBeGreaterThan(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(lines.nth(n)).toHaveText(`Line ${n + 1} of the instructions`)
  await expectCaretLineInSight(page, dialog, 'the line split again by undo')

  // A narrower window wraps the heading over more lines: the room under it grows with it.
  const was = await box(header(dialog))
  await page.setViewportSize({ width: 320, height: page.viewportSize()!.height })
  await expect.poll(async () => (await box(header(dialog))).height).toBeGreaterThan(was.height + 20)
  // Once it has settled: the same height for ten frames in a row.
  await expect
    .poll(() =>
      header(dialog).evaluate(async (head: HTMLElement) => {
        const heights = []
        for (let i = 0; i < 10; i++) {
          heights.push(head.offsetHeight)
          await new Promise(requestAnimationFrame)
        }
        return new Set(heights).size
      }),
    )
    .toBe(1)
  expect((await scrollFields(dialog, 'end'))!.scrollTop).toBeGreaterThan(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(lines.nth(n - 1)).toHaveText(`Line ${n} of the instructionsLine ${n + 1} of the instructions`)
  await expectCaretLineInSight(page, dialog, 'the line joined again by redo, under the taller heading')
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
  const task = dialog.getByLabel('Initial tasks')
  for (const t of TASKS) {
    await task.fill(t)
    await task.press('Enter')
  }
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
  // The page height is compared with the one the dialog leaves, so measure it once the data has loaded.
  await page.waitForLoadState('networkidle')
  const before = await pageScroll(page)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await fillTall(page, dialog)

  await expectInWindow(page, dialog, 'the dialog')
  await expectFieldsScroll(page, dialog, 'New ticket', [
    dialog.getByLabel('Stage'),
    dialog.getByLabel('Tags (optional)'),
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
  expect(ticket.tasks.map((t) => t.text)).toEqual([PHASES[0], ...TASKS, ...PHASES.slice(1)])
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
  await page.waitForLoadState('networkidle')
  // A banner above the page (a report due, a missing tool) can push the button below the fold: the click
  // would scroll to it, which is not the dialog moving the page.
  const newLane = page.getByRole('button', { name: 'New lane' })
  await newLane.scrollIntoViewIfNeeded()
  const before = await pageScroll(page)
  await newLane.click()
  const dialog = page.getByRole('dialog')
  await fillTall(page, dialog, { files: false })

  await expectInWindow(page, dialog, 'the dialog')
  await expectEndsInReach(page, dialog, 'New lane')
  await expectFieldsScroll(page, dialog, 'New lane', [
    dialog.locator('#assignee'),
    dialog.getByLabel('Tags (optional)'),
  ])
  expect((await pageScroll(page)).y).toBe(before.y)

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await api.getTicket(t.id)).lanes.map((l) => l.title)).toEqual(['A long one'])
})

// As long as a title gets, in words, so it wraps over several lines of the heading.
const LONG_TITLE = Array.from({ length: 40 }, (_, i) => `part${i + 1}`)
  .join(' ')
  .slice(0, 200)

/**
 * Under a heading made tall by a long parent title, goes back to the first line of long instructions
 * and types there: that line shows between the heading and the footer, and nothing covers it.
 */
async function expectEditedFirstLineInSight(page: Page, api: Api) {
  const t = await api.ticket({ title: LONG_TITLE })
  expect(t.title).toHaveLength(200)
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await page.getByRole('button', { name: 'New lane' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(LONG_TITLE)).toBeVisible()
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  for (let i = 1; i <= 40; i++) {
    if (i > 1) await page.keyboard.press('Enter')
    await page.keyboard.insertText(`Line ${i} of the instructions`)
  }
  await expect(text.locator('p').last()).toBeInViewport({ ratio: 1 })

  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText('EDITED ')
  const first = text.locator('p').first()
  await expect(first).toHaveText('EDITED Line 1 of the instructions')
  await expect(first).toBeInViewport({ ratio: 1 })
  await expectBetweenEnds(dialog, first, 'the line being edited')
  // What is drawn at the middle of the line is the line itself, not the heading over it.
  const b = await box(first)
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x!, y!)
      return el?.closest('p')?.textContent ?? el?.closest('[data-slot]')?.getAttribute('data-slot') ?? null
    },
    [b.x + Math.min(b.width / 2, 40), b.y + b.height / 2],
  )
  expect(hit).toBe('EDITED Line 1 of the instructions')
}

test('in the New lane dialog under a long parent title, the line edited at the start of long instructions stays in sight', async ({
  page,
  api,
}) => {
  await expectEditedFirstLineInSight(page, api)
})

/** The caret at either end of the fields, scrolled by the editor itself: on the desktop and on a phone. */
function caretAtTheEndsTests() {
  test('Enter at the end of long instructions in the New ticket dialog keeps each new line clear of the footer', async ({
    page,
    project,
  }) => {
    await page.goto(`/projects/${project.id}/features`)
    await page.getByRole('button', { name: 'New ticket' }).click()
    await expectEntersAtTheEndInSight(page, page.getByRole('dialog'), 40)
  })

  test('in the New lane dialog under a long parent title, Enter at the end of long instructions keeps each new line clear of the footer, and Backspace keeps the line it joins clear of the heading', async ({
    page,
    api,
  }) => {
    const t = await api.ticket({ title: LONG_TITLE })
    await page.goto(`/projects/${t.projectId}/features/${t.id}`)
    await page.getByRole('button', { name: 'New lane' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(LONG_TITLE)).toBeVisible()
    await expectEntersAtTheEndInSight(page, dialog, 40)
    await expectBackspaceJoinUnderHeadingInSight(page, dialog)
  })
}

caretAtTheEndsTests()

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  caretAtTheEndsTests()

  test('in the New lane dialog under a long parent title, the line edited at the start of long instructions stays in sight', async ({
    page,
    api,
  }) => {
    await expectEditedFirstLineInSight(page, api)
  })

  test('the New ticket dialog with long content fits the screen, scrolls only up and down, and creates the ticket', async ({
    page,
    project,
    human,
  }) => {
    await page.goto(`/projects/${project.id}/features`)
    await page.waitForLoadState('networkidle')
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
    expect(ticket.tasks).toHaveLength(TASKS.length + PHASES.length)
    expect(ticket.tags).toHaveLength(TAGS.length)
    expect(ticket.attachments).toHaveLength(FILES)
  })
})
