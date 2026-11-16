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
  await expect(control(canvas, 'Delete')).toBeEnabled()

  // A click on empty picture clears it.
  await click(page, canvas, [285, 20])
  await expect(noteField(canvas)).toBeDisabled()
  await expect(control(canvas, 'Delete')).toBeDisabled()

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
  await expect(control(canvas, 'Delete')).toBeEnabled()
  await expect(canvas.getByRole('listitem')).toHaveCount(2)

  // Escape clears the selection and leaves the canvas open.
  await page.keyboard.press('Escape')
  await expect(canvas).toBeVisible()
  await expect(control(canvas, 'Delete')).toBeDisabled()

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

  // The Delete button removes the one left; undo brings it back with its note.
  await click(page, canvas, [210, 210])
  await control(canvas, 'Delete').click()
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

  // Tab reaches the Delete button from Undo (Redo is skipped while there is nothing to redo).
  await control(canvas, 'Select').click()
  await click(page, canvas, [60, 60])
  await control(canvas, 'Undo').focus()
  await page.keyboard.press('Tab')
  await expect(control(canvas, 'Delete')).toBeFocused()

  // Keyboard only from here: Select is focused, and Ctrl+A selects every mark.
  await control(canvas, 'Select').focus()
  await page.keyboard.press('Control+a')
  await expect(control(canvas, 'Delete')).toBeEnabled()
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
  await expect(control(canvas, 'Delete')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(canvas).toBeVisible()
  await expect(control(canvas, 'Delete')).toBeDisabled()

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

  for (const name of ['Select', 'Pencil', 'Undo', 'Redo', 'Delete', 'Clear'])
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
