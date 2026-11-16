import type { APIRequestContext, CDPSession, Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { canvasOf, png } from './files'
import { expect, ok, test } from './fixtures'

/** An attachment as the server returns it on a ticket. */
type Stored = TicketFull['attachments'][number]

/** The picture the canvas draws on, by its own accessible name. */
const pictureOf = (canvas: Locator) => canvas.getByRole('img', { name: 'Picture to annotate' })
const noteField = (canvas: Locator) => canvas.getByRole('textbox', { name: 'Note', exact: true })
const control = (canvas: Locator, name: string) => canvas.getByRole('button', { name, exact: true })

/**
 * A point of the picture, in the picture's own pixels, as a page position. The canvas maps a pointer
 * back the same way (through its border box), so a drag from here to there moves exactly that far.
 */
async function at(canvas: Locator, [x, y]: [number, number]) {
  const el = pictureOf(canvas)
  const box = (await el.boundingBox())!
  const size = await el.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }))
  return { x: box.x + (x * box.width) / size.w, y: box.y + (y * box.height) / size.h }
}

async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]) {
  const a = await at(canvas, from)
  const b = await at(canvas, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
}

async function click(page: Page, canvas: Locator, point: [number, number], shift = false) {
  const p = await at(canvas, point)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.click(p.x, p.y)
  if (shift) await page.keyboard.up('Shift')
}

/** Picks one of the canvas's drawing tools and drags it from `from` to `to`, in the picture's pixels. */
async function draw(page: Page, canvas: Locator, tool: string, from: [number, number], to: [number, number]) {
  await control(canvas, tool).click()
  await drag(page, canvas, from, to)
}

/** Opens the New ticket dialog on the project's features page. */
async function openNewTicket(page: Page, projectId: number, title: string) {
  await page.goto(`/projects/${projectId}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog', { name: 'New ticket' })
  await dialog.getByLabel('Title').fill(title)
  return dialog
}

/** Picks a picture with the dialog's attach button, the way a person does. */
async function pickWith(page: Page, button: Locator, file: { name: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser')
  await button.click()
  await (await chooser).setFiles({ name: file.name, mimeType: 'image/png', buffer: file.buffer })
}

/** A new ticket with a 300-pixel picture on the canvas, ready to draw on. */
async function openCanvas(page: Page, projectId: number, title: string) {
  const dialog = await openNewTicket(page, projectId, title)
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), {
    name: 'select.png',
    buffer: png(300, [250, 250, 250]),
  })
  const canvas = canvasOf(page)
  await expect(pictureOf(canvas)).toBeVisible()
  return { dialog, canvas }
}

/** Creates the ticket the picture was attached to, and returns the attachment the server stored. */
async function createTicket(human: APIRequestContext, projectId: number, dialog: Locator): Promise<Stored> {
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${projectId}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments).toHaveLength(1)
  return ticket.attachments[0]!
}

/** Attaches the picture as drawn, then creates the ticket with it. */
async function attachAndCreate(
  human: APIRequestContext,
  projectId: number,
  dialog: Locator,
  canvas: Locator,
): Promise<Stored> {
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()
  return createTicket(human, projectId, dialog)
}

/** The marks the server stored with the picture. */
function storedItems(attached: Stored) {
  expect(attached.annotations).toBeTruthy()
  return attached.annotations!.items
}

test('the Select tool picks one mark, adds and takes away with Shift, and a drag box selects several', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Select by clicking')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await noteField(canvas).fill('first')
  await draw(page, canvas, 'Box', [160, 160], [260, 260])
  await noteField(canvas).fill('second')

  await control(canvas, 'Select').click()
  await expect(control(canvas, 'Select')).toHaveAttribute('aria-pressed', 'true')

  // A click on a mark picks it: its note is editable and the Delete button follows the selection.
  await click(page, canvas, [60, 60])
  await expect(noteField(canvas)).toHaveValue('first')

  // A click on empty picture clears it.
  await click(page, canvas, [285, 20])
  await expect(noteField(canvas)).toBeDisabled()

  // Shift-click adds the second mark: two selected, so the note field is off.
  await click(page, canvas, [60, 60])
  await click(page, canvas, [210, 210], true)
  await expect(noteField(canvas)).toBeDisabled()
  // Shift-click again takes it away: one left, and its note is shown again.
  await click(page, canvas, [210, 210], true)
  await expect(noteField(canvas)).toHaveValue('first')

  // A drag from empty picture selects every mark its box meets, and draws nothing.
  await drag(page, canvas, [285, 285], [5, 5])
  await expect(noteField(canvas)).toBeDisabled()
  await expect(canvas.getByRole('listitem')).toHaveCount(2)

  // Escape clears the selection and leaves the canvas open.
  await page.keyboard.press('Escape')
  await expect(canvas).toBeVisible()
  await expect(noteField(canvas)).toBeDisabled()

  // The select tool drew nothing: the stored document holds the two boxes as they were drawn.
  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const items = storedItems(attached)
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ kind: 'rect', note: 'first' })
  expect(items[1]).toMatchObject({ kind: 'rect', note: 'second' })
})

test('a drag moves the selection, and the rotate handle turns it about the centre of its box', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Move and turn')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await draw(page, canvas, 'Box', [160, 160], [260, 260])

  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  // Dragging the picked mark moves it by the same distance in the picture's pixels: 40 right, 80 down.
  await drag(page, canvas, [60, 60], [100, 140])

  // The selection's box is now 60..140 by 100..180, so its rotate handle sits 26 above the top middle.
  // Turning the pointer from above the centre (100, 140) to its right is a quarter turn clockwise.
  await drag(page, canvas, [100, 74], [180, 140])

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [moved, other] = storedItems(attached)
  expect(moved!.rect!.x).toBeCloseTo(60, 0)
  expect(moved!.rect!.y).toBeCloseTo(100, 0)
  expect(moved!.rect!.w).toBeCloseTo(80, 0)
  expect(moved!.rotation).toBeCloseTo(Math.PI / 2, 2)
  // The mark nobody touched keeps its place and has no rotation key at all.
  expect(other!.rect!.x).toBeCloseTo(160, 0)
  expect(other!.rect!.y).toBeCloseTo(160, 0)
  expect(other!.rect!.w).toBeCloseTo(100, 0)
  expect(other!.rect!.h).toBeCloseTo(100, 0)
  expect('rotation' in other!).toBe(false)
})

test('Escape while a mouse button is held on a selected mark leaves the canvas open and the drag finishes', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Escape during drag')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])

  const from = await at(canvas, [60, 60])
  const to = await at(canvas, [70, 60])
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(canvas).toBeVisible()
  await page.mouse.up()

  await expect(canvas).toBeVisible()
  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [moved] = storedItems(attached)
  expect(moved!.rect!.x).toBeCloseTo(30, 0)
})

test('Escape while a mouse button is held on a drawing tool, with nothing selected, leaves the canvas open and the box finishes', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Escape during draw')
  await control(canvas, 'Box').click()

  const from = await at(canvas, [40, 40])
  const to = await at(canvas, [120, 120])
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(canvas).toBeVisible()
  await page.mouse.up()

  await expect(canvas).toBeVisible()
  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [drawn] = storedItems(attached)
  expect(drawn!.rect!.x).toBeCloseTo(40, 0)
  expect(drawn!.rect!.w).toBeCloseTo(80, 0)
})

test('a click on a mark in the band under the rotate handle picks that mark, not the handle', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Mark under the handle')
  // A small box whose middle sits 8 pixels above the rotate handle of the box drawn after it.
  await draw(page, canvas, 'Box', [118, 60], [132, 80])
  await noteField(canvas).fill('under')
  await draw(page, canvas, 'Box', [100, 100], [150, 150])
  await control(canvas, 'Select').click()

  await click(page, canvas, [125, 66])
  await expect(noteField(canvas)).toHaveValue('under')

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [under, drawn] = storedItems(attached)
  expect(under!.note).toBe('under')
  expect(drawn!.rect!.x).toBeCloseTo(100, 0)
  expect(drawn!.rotation).toBeUndefined()
})

test('Delete removes the selection, and undo and redo bring it back and take it away again', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Delete and undo')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await noteField(canvas).fill('gone')
  await draw(page, canvas, 'Box', [160, 160], [260, 260])
  await noteField(canvas).fill('kept')

  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  // The Delete key, with focus in the canvas dialog, removes the picked mark and its note.
  await page.keyboard.press('Delete')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])

  // Undo brings it back in its place in the order; redo takes it away again.
  await control(canvas, 'Undo').click()
  await expect(canvas.getByRole('listitem')).toHaveText(['1. gone', '2. kept'])
  await control(canvas, 'Redo').click()
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])

  // The keyboard shortcuts: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo.
  await page.keyboard.press('Control+z')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. gone', '2. kept'])
  await page.keyboard.press('Control+Shift+z')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])

  // The Delete key removes the one left; undo brings it back with its note.
  await click(page, canvas, [210, 210])
  await page.keyboard.press('Delete')
  await expect(canvas.getByRole('listitem')).toHaveCount(0)
  await control(canvas, 'Undo').click()
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])

  // Clear is one step too: undo brings back what it removed.
  await control(canvas, 'Clear').click()
  await expect(canvas.getByRole('listitem')).toHaveCount(0)
  await control(canvas, 'Undo').click()
  await expect(canvas.getByRole('listitem')).toHaveText(['1. kept'])

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  expect(storedItems(attached)).toHaveLength(1)
  expect(storedItems(attached)[0]).toMatchObject({ kind: 'rect', note: 'kept' })
})

test('the selection works from the keyboard alone once the marks are drawn', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Keyboard only')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await noteField(canvas).fill('a')
  await draw(page, canvas, 'Box', [160, 160], [260, 260])
  await noteField(canvas).fill('b')

  // Tab reaches Clear from Undo (Redo is skipped while there is nothing to redo, and there is no Delete button).
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  await control(canvas, 'Undo').focus()
  await page.keyboard.press('Tab')
  await expect(control(canvas, 'Clear')).toBeFocused()

  // Keyboard only from here: Select is focused, and Ctrl+A selects every mark.
  await control(canvas, 'Select').focus()
  await page.keyboard.press('Control+a')
  await expect(noteField(canvas)).toBeDisabled()
  await page.keyboard.press('Delete')
  await expect(canvas.getByRole('listitem')).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. a', '2. b'])
  await page.keyboard.press('Control+Shift+z')
  await expect(canvas.getByRole('listitem')).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Control+z')
  await expect(canvas.getByRole('listitem')).toHaveText(['1. a', '2. b'])

  // Escape clears a selection without closing the canvas.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Escape')
  await expect(canvas).toBeVisible()
  await expect(noteField(canvas)).toBeDisabled()

  // Backspace removes a selection too.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(canvas.getByRole('listitem')).toHaveCount(0)

  await attachAndCreate(human, project.id, dialog, canvas)
})

test.describe('touch', () => {
  test.use({ hasTouch: true })

  /** One finger on the screen, moved along `path` (page positions), then lifted. */
  async function touchPath(cdp: CDPSession, path: { x: number; y: number }[]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [path[0]!] })
    for (const p of path.slice(1))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /** A straight touch drag across the picture, from one picture pixel to another, in ten steps. */
  async function touchDrag(cdp: CDPSession, canvas: Locator, from: [number, number], to: [number, number]) {
    const a = await at(canvas, from)
    const b = await at(canvas, to)
    const steps = 10
    const path = Array.from({ length: steps + 1 }, (_, i) => ({
      x: a.x + ((b.x - a.x) * i) / steps,
      y: a.y + ((b.y - a.y) * i) / steps,
    }))
    await touchPath(cdp, path)
  }

  test('a tap selects a mark, a touch drag moves it, and the rotate handle turns it', async ({
    page,
    project,
    human,
  }) => {
    const { dialog, canvas } = await openCanvas(page, project.id, 'Touch')
    await draw(page, canvas, 'Box', [20, 20], [100, 100])
    await draw(page, canvas, 'Box', [160, 160], [260, 260])
    await control(canvas, 'Select').click()
    const cdp = await page.context().newCDPSession(page)

    await touchPath(cdp, [await at(canvas, [60, 60])])
    await expect(noteField(canvas)).toBeEnabled()

    await touchDrag(cdp, canvas, [60, 60], [100, 140])
    await touchDrag(cdp, canvas, [100, 74], [180, 140])

    const attached = await attachAndCreate(human, project.id, dialog, canvas)
    const [moved] = storedItems(attached)
    expect(moved!.rect!.x).toBeCloseTo(60, 0)
    expect(moved!.rect!.y).toBeCloseTo(100, 0)
    expect(moved!.rotation).toBeCloseTo(Math.PI / 2, 2)
  })
})

test('the attached picture has no selection pixels, whatever is selected', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Selection is not in the picture')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])

  // The outline colour (#0ea5e9) is on screen while the mark is selected: the check below means something.
  const outline = (c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < data.length; i += 4)
      if (
        Math.abs(data[i]! - 14) <= 12 &&
        Math.abs(data[i + 1]! - 165) <= 12 &&
        Math.abs(data[i + 2]! - 233) <= 12
      )
        n++
    return n
  }
  await expect.poll(() => pictureOf(canvas).evaluate(outline)).toBeGreaterThan(0)

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const res = await page.request.get(attached.url)
  expect(res.ok()).toBe(true)
  const counts = await page.evaluate(
    async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      let selection = 0
      let rose = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!
        const g = data[i + 1]!
        const b = data[i + 2]!
        if (Math.abs(r - 14) <= 12 && Math.abs(g - 165) <= 12 && Math.abs(b - 233) <= 12) selection++
        if (r > 180 && g < 90 && b < 120) rose++
      }
      return { selection, rose }
    },
    Buffer.from(await res.body()).toString('base64'),
  )
  expect(counts.selection).toBe(0)
  // The render decodes and carries the mark, so the count above is a real count.
  expect(counts.rose).toBeGreaterThan(0)
})

test('a picture drawn on and never selected stores its marks with no rotation key', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Drawing only')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await noteField(canvas).fill('the button is cut off')
  const attached = await attachAndCreate(human, project.id, dialog, canvas)

  const doc = attached.annotations!
  expect(Object.keys(doc).sort()).toEqual(['height', 'items', 'version', 'width'])
  expect(doc).toMatchObject({ version: 1, width: 300, height: 300 })
  expect(doc.items).toHaveLength(1)
  const [mark] = doc.items
  // The keys the canvas writes for a box, and nothing else.
  expect(Object.keys(mark!).sort()).toEqual(['color', 'id', 'kind', 'note', 'rect', 'width'])
  expect(mark!.rect!.x).toBeCloseTo(20, 0)
  expect(mark!.rect!.w).toBeCloseTo(80, 0)
  expect('rotation' in mark!).toBe(false)
})

test('the select controls lock while the picture attaches', async ({ page, project, human }) => {
  // The encode is held so the button reads "Attaching…" long enough to try every control.
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      ...rest: [string?, number?]
    ) {
      setTimeout(() => toBlob.call(this, callback, ...rest), 4_000)
    }
  })
  const { dialog, canvas } = await openCanvas(page, project.id, 'Locked while attaching')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas.getByRole('button', { name: 'Attaching…' })).toBeVisible()

  for (const name of ['Select', 'Pencil', 'Undo', 'Redo', 'Clear'])
    await expect(control(canvas, name)).toBeDisabled()
  // A pointer on the picture does nothing while it attaches: no move, no new mark.
  await drag(page, canvas, [60, 60], [200, 200])
  await expect(noteField(canvas)).toBeDisabled()

  await expect(canvas).toBeHidden()
  const attached = await createTicket(human, project.id, dialog)
  const items = storedItems(attached)
  expect(items).toHaveLength(1)
  expect(items[0]!.rect!.x).toBeCloseTo(20, 0)
  expect('rotation' in items[0]!).toBe(false)
})

/** The cursor the canvas shows once the pointer is at `point` (a picture pixel), read from the element's style. */
async function cursorAt(page: Page, canvas: Locator, point: [number, number]) {
  const p = await at(canvas, point)
  await page.mouse.move(p.x, p.y)
  return pictureOf(canvas).evaluate((c: HTMLCanvasElement) => c.style.cursor)
}

/** The colour of one pixel of a stored picture, read the way the flattened-picture test reads it. */
async function pixelOf(page: Page, attached: Stored, [x, y]: [number, number]) {
  const res = await page.request.get(attached.url)
  expect(res.ok()).toBe(true)
  return page.evaluate(
    async ({ base64, x, y }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
      return { r: r!, g: g!, b: b! }
    },
    { base64: Buffer.from(await res.body()).toString('base64'), x, y },
  )
}

test('dragging a corner handle resizes both sides, and a side handle one side, from the opposite edge', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Resize corner and side')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])

  // The south-east corner handle sits on the box's corner (100, 100): dragged to (140, 130), the top-left stays put.
  await drag(page, canvas, [100, 100], [140, 130])
  // The box is now 20..140 by 20..130; its east side handle sits at (140, 75). Dragged to 150, only the width changes.
  await drag(page, canvas, [140, 75], [150, 75])

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [mark] = storedItems(attached)
  expect(mark!.rect!.x).toBeCloseTo(20, 0)
  expect(mark!.rect!.y).toBeCloseTo(20, 0)
  expect(mark!.rect!.w).toBeCloseTo(130, 0)
  expect(mark!.rect!.h).toBeCloseTo(110, 0)
  expect('rotation' in mark!).toBe(false)
})

test('each resize is one undo step, and redo brings back only the step that was undone', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Resize undo and redo')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  await drag(page, canvas, [100, 100], [140, 130])
  await drag(page, canvas, [140, 75], [150, 75])

  // Two undo steps take both resizes back; the box drawn before them stays, so Undo is still there.
  await control(canvas, 'Undo').click()
  await control(canvas, 'Undo').click()
  await expect(control(canvas, 'Undo')).toBeEnabled()
  // One redo puts back only the corner resize.
  await control(canvas, 'Redo').click()

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [mark] = storedItems(attached)
  expect(mark!.rect!.x).toBeCloseTo(20, 0)
  expect(mark!.rect!.y).toBeCloseTo(20, 0)
  expect(mark!.rect!.w).toBeCloseTo(120, 0)
  expect(mark!.rect!.h).toBeCloseTo(110, 0)
})

test('the side handles of a vertical line do nothing on its zero width', async ({ page, project, human }) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Zero width')
  await draw(page, canvas, 'Pencil', [100, 20], [100, 120])
  await control(canvas, 'Select').click()
  await click(page, canvas, [100, 70])

  // The line's east and west handles both sit on its one vertical edge: a drag sideways changes nothing.
  await drag(page, canvas, [100, 70], [140, 70])

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [line] = storedItems(attached)
  expect(line!.kind).toBe('pen')
  for (const [x] of line!.points!) expect(x).toBeCloseTo(100, 0)
})

test('the cursor shows the resize arrow on each side and corner, grab on the rotate tip, move inside, and default elsewhere', async ({
  page,
  project,
}) => {
  const { canvas } = await openCanvas(page, project.id, 'Cursor by part')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])

  expect(await cursorAt(page, canvas, [100, 60])).toBe('ew-resize')
  expect(await cursorAt(page, canvas, [60, 20])).toBe('ns-resize')
  expect(await cursorAt(page, canvas, [100, 100])).toBe('nwse-resize')
  expect(await cursorAt(page, canvas, [20, 100])).toBe('nesw-resize')
  // The rotate tip sits below the box here, since there is no room above it.
  expect(await cursorAt(page, canvas, [60, 126])).toBe('grab')
  expect(await cursorAt(page, canvas, [60, 60])).toBe('move')
  expect(await cursorAt(page, canvas, [285, 285])).toBe('default')
})

test('the X beside the rotate tip deletes the selection as one step, and undo brings it back', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Delete with the X')
  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  await noteField(canvas).fill('gone')
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])

  // Hovering the rotate tip shows the X beside it; the X is 16 css pixels to the right of the tip.
  await cursorAt(page, canvas, [60, 126])
  const tip = await at(canvas, [60, 126])
  await page.mouse.click(tip.x + 16, tip.y)
  await expect(canvas.getByRole('listitem')).toHaveCount(0)

  await control(canvas, 'Undo').click()
  await expect(canvas.getByRole('listitem')).toHaveText(['1. gone'])

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  expect(storedItems(attached)).toHaveLength(1)
})

test('Fill is unchecked by default, fills the next box, shows the fill of a selected box, and undo and redo set it on the selection', async ({
  page,
  project,
  human,
}) => {
  const { dialog, canvas } = await openCanvas(page, project.id, 'Fill')
  const fillBox = canvas.getByRole('checkbox', { name: 'Fill' })
  await expect(fillBox).not.toBeChecked()

  await draw(page, canvas, 'Box', [20, 20], [100, 100])
  // A drawn mark is selected: Escape clears it, so the Fill click below is for the next box, not this one.
  await page.keyboard.press('Escape')
  await fillBox.click()
  await expect(fillBox).toBeChecked()
  await draw(page, canvas, 'Box', [160, 160], [260, 260])

  // A single selected filled box shows Fill checked; the unfilled one shows it unchecked.
  await control(canvas, 'Select').click()
  await click(page, canvas, [210, 210])
  await expect(fillBox).toBeChecked()
  await click(page, canvas, [60, 60])
  await expect(fillBox).not.toBeChecked()

  // Fill on for the selected unfilled box is one step: undo takes it off, redo puts it on.
  await fillBox.click()
  await expect(fillBox).toBeChecked()
  await control(canvas, 'Undo').click()
  await expect(fillBox).not.toBeChecked()
  await control(canvas, 'Redo').click()
  await expect(fillBox).toBeChecked()

  const attached = await attachAndCreate(human, project.id, dialog, canvas)
  const [first, second] = storedItems(attached)
  expect(first).toMatchObject({ kind: 'rect', fill: true })
  expect(second).toMatchObject({ kind: 'rect', fill: true })
  // The flattened picture paints both boxes filled in the mark's colour, at their middles.
  const rose = ({ r, g, b }: { r: number; g: number; b: number }) => r > 180 && g < 90 && b < 120
  expect(rose(await pixelOf(page, attached, [60, 60]))).toBe(true)
  expect(rose(await pixelOf(page, attached, [210, 210]))).toBe(true)
})
