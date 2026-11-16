import fs from 'node:fs'

import type { Locator, Page } from '@playwright/test'

import type { Attachment, CommentRow, TicketFull, TicketRow } from '#/lib/api'
import { attachOriginal, canvasOf, pdf, png, sendFile } from './files'
import { expect, ok, test } from './fixtures'

/** The picture the canvas draws on, by its own accessible name. */
const pictureOf = (canvas: Locator) => canvas.getByRole('img', { name: 'Picture to annotate' })

/** Drags one of the canvas's tools from `from` to `to`, in the picture's own pixels. */
async function draw(page: Page, canvas: Locator, tool: string, from: [number, number], to: [number, number]) {
  await canvas.getByRole('button', { name: tool, exact: true }).click()
  const box = (await pictureOf(canvas).boundingBox())!
  await page.mouse.move(box.x + from[0], box.y + from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 })
  await page.mouse.up()
}

/** Picks the colour every mark drawn next uses. */
const ink = (canvas: Locator, colour: string) => canvas.getByLabel('Colour').fill(colour)

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

/** The bytes the board serves for an attachment. */
async function served(page: Page, url: string) {
  const res = await page.request.get(url)
  expect(res.ok()).toBe(true)
  return Buffer.from(await res.body())
}

test('a picture in a new ticket goes through the canvas, and the ticket keeps the picture and its notes', async ({
  page,
  project,
  human,
}) => {
  const original = png(300, [250, 250, 250])
  const dialog = await openNewTicket(page, project.id, 'The cut-off button')
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), { name: 'shot.png', buffer: original })

  // The picture opens the canvas before it joins the form.
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await expect(pictureOf(canvas)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Remove shot.png' })).toHaveCount(0)

  await draw(page, canvas, 'Box', [40, 40], [180, 140])
  // Drawing a mark picks it: the note input writes its note, and the panel lists it numbered.
  await expect(canvas.getByLabel('Note')).toBeEnabled()
  await canvas.getByLabel('Note').fill('the button is cut off')
  await expect(canvas.getByRole('listitem')).toHaveText('1. the button is cut off')
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()

  // The pending thumbnail is the annotated render, ready to go with the ticket.
  const thumb = dialog.getByRole('img', { name: 'shot.png' })
  await expect(thumb).toBeVisible()
  await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(300)
  // The box is in the thumbnail's own pixels: the drawn-on picture is what will be attached.
  const inked = await thumb.evaluate(async (el: HTMLImageElement) => {
    const drawn = document.createElement('canvas')
    drawn.width = el.naturalWidth
    drawn.height = el.naturalHeight
    const ctx = drawn.getContext('2d')!
    ctx.drawImage(el, 0, 0)
    const { data } = ctx.getImageData(0, 0, drawn.width, drawn.height)
    let rose = 0
    for (let i = 0; i < data.length; i += 4)
      if (data[i]! > 180 && data[i + 1]! < 90 && data[i + 2]! < 120) rose++
    return rose
  })
  expect(inked).toBeGreaterThan(0)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments).toHaveLength(1)
  const attached = ticket.attachments[0]!
  expect(attached.name).toBe('shot.png')
  expect(attached.mime).toBe('image/png')
  expect(attached.annotations).toMatchObject({
    version: 1,
    width: 300,
    height: 300,
    items: [{ kind: 'rect', color: '#e11d48', note: 'the button is cut off' }],
  })
  // What is served is the annotated render, not the file that went in.
  const bytes = await served(page, attached.url)
  expect(bytes.equals(original)).toBe(false)
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
})

test('each tool leaves its colour on the flattened picture', async ({ page, project, human }) => {
  const dialog = await openNewTicket(page, project.id, 'Every tool')
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), {
    name: 'tools.png',
    buffer: png(320, [120, 120, 120]),
  })
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  for (const name of [
    'Pencil',
    'Box',
    'Arrow',
    'Ellipse',
    'Text',
    'Note',
    'Undo',
    'Clear',
    'Attach original',
  ])
    await expect(canvas.getByRole('button', { name, exact: true })).toBeVisible()

  await ink(canvas, '#ff0000')
  await draw(page, canvas, 'Pencil', [20, 20], [120, 70])
  await ink(canvas, '#00ff00')
  await draw(page, canvas, 'Box', [20, 200], [110, 280])
  await ink(canvas, '#0000ff')
  await draw(page, canvas, 'Arrow', [140, 20], [290, 80])
  await ink(canvas, '#ff00ff')
  await draw(page, canvas, 'Ellipse', [150, 190], [300, 280])
  await ink(canvas, '#000000')
  await canvas.getByRole('button', { name: 'Text', exact: true }).click()
  await canvas.getByLabel('Text').fill('Hi')
  const box = (await pictureOf(canvas).boundingBox())!
  await page.mouse.click(box.x + 20, box.y + 130)
  // The last mark drawn is the one picked: its note is numbered in the picture and listed here.
  await canvas.getByLabel('Note').fill('the edge is cut off')
  await expect(canvas.getByRole('listitem')).toHaveText('1. the edge is cut off')

  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments[0]!.annotations!.items).toMatchObject([
    { kind: 'pen' },
    { kind: 'rect' },
    { kind: 'arrow' },
    { kind: 'ellipse' },
    { kind: 'text', note: 'the edge is cut off' },
  ])

  // Read the served PNG back in the page, as the PDF thumbnail test reads a canvas.
  const inked = await page.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const counts = { red: 0, green: 0, blue: 0, magenta: 0, black: 0, white: 0, width: canvas.width }
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      if (r > 200 && g < 60 && b < 60) counts.red++
      if (g > 200 && r < 60 && b < 60) counts.green++
      if (b > 200 && r < 60 && g < 60) counts.blue++
      if (r > 200 && b > 200 && g < 60) counts.magenta++
      if (r < 40 && g < 40 && b < 40) counts.black++
      // The base picture is grey: white comes only from the number burned into the mark's badge.
      if (r > 245 && g > 245 && b > 245) counts.white++
    }
    return counts
  }, ticket.attachments[0]!.url)
  expect(inked.width).toBe(320)
  for (const [name, count] of Object.entries(inked))
    if (name !== 'width') expect(count, `${name} was drawn`).toBeGreaterThan(0)
})

test("a picture attached to a ticket's instructions opens the canvas", async ({ page, api }) => {
  const t = await api.ticket({ title: 'Instructions with a picture' })
  const original = png(240, [200, 200, 240])
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await pickWith(page, instructions.getByRole('button', { name: /attach/i }), {
    name: 'screen.png',
    buffer: original,
  })

  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await draw(page, canvas, 'Ellipse', [30, 30], [200, 180])
  await canvas.getByLabel('Note').fill('the header is missing')
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()

  await expect(instructions.getByRole('listitem').filter({ hasText: 'screen.png' })).toBeVisible()
  await expect
    .poll(async () => (await api.getTicket(t.id)).attachments.map((a) => a.annotations?.items[0]?.note))
    .toEqual(['the header is missing'])
  const attached = (await api.getTicket(t.id)).attachments[0]!
  expect((await served(page, attached.url)).equals(original)).toBe(false)
})

test('a picture in a post and in a reply opens the canvas, and an agent reads the notes with it', async ({
  page,
  api,
  human,
  agent,
}) => {
  const t = await api.ticket({ title: 'Pictures in the thread' })
  const original = png(280, [240, 240, 200])
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // The ticket's comment box: the picture is pasted in, so the canvas opens before it joins the form.
  const text = page.getByRole('textbox', { name: 'New post', exact: true })
  const form = page.locator('form').filter({ has: text })
  await sendFile(page, 'form:has([role="textbox"][aria-label="New post"]) [role="textbox"]', 'paste', {
    name: 'star.png',
    mime: 'image/png',
    data: original,
  })
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await draw(page, canvas, 'Arrow', [30, 30], [220, 200])
  await canvas.getByLabel('Note').fill('this row is off by one')
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()
  await expect(form.getByRole('button', { name: 'Remove star.png' })).toBeVisible()
  await text.fill('The export table.')
  await form.getByRole('button', { name: 'Post', exact: true }).click()

  const post = page.locator('article:not([aria-label="Summary"])').first()
  const image = post.getByRole('img', { name: 'star.png' })
  await expect(image).toBeVisible()
  // The posted picture shows as it was drawn on, with its notes under it.
  await expect(post.getByText('1. this row is off by one')).toBeVisible()
  // Clicking it opens the gallery, which lists the same notes.
  await image.click()
  const gallery = page
    .getByRole('dialog')
    .filter({ has: page.locator('[aria-label="Notes on the picture"]') })
  await expect(gallery.getByText('1. this row is off by one')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(gallery).toBeHidden()

  const saved = await api.getTicket(t.id)
  const attached = saved.updates[0]!.attachments[0]!
  expect(attached.annotations!.items).toMatchObject([{ kind: 'arrow', note: 'this row is off by one' }])
  expect((await served(page, attached.url)).equals(original)).toBe(false)

  // An agent gets the picture on this machine and the notes, without a browser.
  const info = await ok<Attachment & { url: string; path: string }>(
    agent.get(`/api/uploads/${attached.id}/info`),
  )
  expect(info.path).toBe(attached.path)
  expect(info.annotations).toMatchObject({
    items: [{ kind: 'arrow', note: 'this row is off by one' }],
  })
  const bytes = fs.readFileSync(info.path)
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(bytes.equals(original)).toBe(false)
  // The same document comes back with the post's attachment on the ticket.
  expect(saved.updates[0]!.attachments[0]!.annotations).toEqual(info.annotations)

  // A reply under the post opens the canvas too, and its comment carries the notes.
  await post.getByRole('group', { name: 'Post actions' }).hover()
  await post.getByRole('button', { name: 'reply', exact: true }).click()
  const reply = page.getByRole('textbox', { name: 'Reply', exact: true })
  await sendFile(page, 'form:has([role="textbox"][aria-label="Reply"]) [role="textbox"]', 'paste', {
    name: 'second.png',
    mime: 'image/png',
    data: png(200, [230, 230, 230]),
  })
  const replyCanvas = canvasOf(page)
  await expect(replyCanvas).toBeVisible()
  await draw(page, replyCanvas, 'Pencil', [20, 20], [150, 150])
  await replyCanvas.getByLabel('Note').fill('and here the column is missing')
  await replyCanvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(replyCanvas).toBeHidden()
  await reply.fill('And one more.')
  await page
    .locator('form')
    .filter({ has: reply })
    .getByRole('button', { name: 'Reply', exact: true })
    .click()

  await expect
    .poll(async () => {
      const comments = await ok<CommentRow[]>(
        human.get(`/api/comments?parentType=update&parentId=${saved.updates[0]!.id}`),
      )
      return comments.map((c) => c.attachments[0]?.annotations?.items[0]?.note)
    })
    .toEqual(['and here the column is missing'])
})

test('a screenshot the canvas flattens to image.png keeps its notes on the new ticket', async ({
  page,
  project,
  human,
}) => {
  const dialog = await openNewTicket(page, project.id, 'A pasted screenshot')

  // A screenshot pasted in the Instructions editor arrives as "image.png", which the form renames
  // once the canvas has flattened it; the document has to go with the file that is uploaded.
  await sendFile(page, '[role="dialog"] [contenteditable="true"]', 'paste', {
    name: 'image.png',
    mime: 'image/png',
    data: png(160, [245, 245, 245]),
  })
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await draw(page, canvas, 'Box', [20, 20], [130, 110])
  await canvas.getByLabel('Note').fill('pasted note')
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()
  await expect(dialog.getByRole('img', { name: /^pasted-.*\.png$/ })).toBeVisible()

  // A file picked under that same name is renamed the same way, and keeps its document too.
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), {
    name: 'image.png',
    buffer: png(140, [240, 240, 240]),
  })
  const pickedCanvas = canvasOf(page)
  await expect(pickedCanvas).toBeVisible()
  await draw(page, pickedCanvas, 'Arrow', [10, 10], [120, 100])
  await pickedCanvas.getByLabel('Note').fill('picked note')
  await pickedCanvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(pickedCanvas).toBeHidden()

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments.map((a) => [a.name, a.annotations?.items[0]?.note])).toEqual([
    [expect.stringMatching(/^pasted-.*\.png$/), 'pasted note'],
    [expect.stringMatching(/^pasted-.*\.png$/), 'picked note'],
  ])
})

test('a batch picked together keeps its order whichever member is a picture', async ({
  page,
  project,
  human,
}) => {
  const dialog = await openNewTicket(page, project.id, 'Picked together')

  // A picture first and a PDF after it in one selection: the PDF waits for the canvas instead of
  // overtaking the picture in the form and on the ticket.
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (
    await chooser
  ).setFiles([
    { name: 'shot.png', mimeType: 'image/png', buffer: png(80, [220, 220, 220]) },
    { name: 'spec.pdf', mimeType: 'application/pdf', buffer: pdf('Spec') },
  ])
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Remove spec.pdf' })).toHaveCount(0)
  await attachOriginal(page)
  // The form lists them in the order they were picked; the Remove buttons are in that same order.
  const pending = () =>
    dialog
      .getByRole('button', { name: /^Remove / })
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  await expect.poll(pending).toEqual(['Remove shot.png', 'Remove spec.pdf'])

  // A non-picture first goes in at once, and the picture behind it still opens the canvas.
  const second = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (
    await second
  ).setFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') },
    { name: 'second.png', mimeType: 'image/png', buffer: png(80, [210, 210, 210]) },
  ])
  await expect(canvas).toBeVisible()
  await attachOriginal(page)
  await expect
    .poll(pending)
    .toEqual(['Remove shot.png', 'Remove spec.pdf', 'Remove notes.md', 'Remove second.png'])

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments.map((a) => a.name)).toEqual(['shot.png', 'spec.pdf', 'notes.md', 'second.png'])
})

test('a PDF and a markdown file attach as they are, with no canvas', async ({ page, project, human }) => {
  const original = png(8, [10, 10, 10])
  const dialog = await openNewTicket(page, project.id, 'No canvas for these')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (await chooser).setFiles({ name: 'spec.pdf', mimeType: 'application/pdf', buffer: pdf('Spec') })
  await expect(canvasOf(page)).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Remove spec.pdf' })).toBeVisible()

  await sendFile(page, '[role="dialog"] h2', 'drop', {
    name: 'notes.md',
    mime: 'text/markdown',
    data: Buffer.from('# Notes\n\nThe parser is fixed.'),
  })
  await expect(canvasOf(page)).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Remove notes.md' })).toBeVisible()

  // A picture in between still goes through the canvas, keeping its place unasked.
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), { name: 'shot.png', buffer: original })
  await attachOriginal(page)
  await dialog.getByRole('button', { name: 'Create' }).click()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments.map((a) => [a.name, a.annotations])).toEqual([
    ['spec.pdf', null],
    ['notes.md', null],
    ['shot.png', null],
  ])
})

test('closing the canvas while the picture is attaching waits for it, and the next picture still arrives', async ({
  page,
  project,
  human,
}) => {
  // The encode is held for a moment: the test closes the canvas while the button reads "Attaching…",
  // rather than hoping a large picture takes long enough.
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      ...rest: [string?, number?]
    ) {
      setTimeout(() => toBlob.call(this, callback, ...rest), 1_500)
    }
  })
  const dialog = await openNewTicket(page, project.id, 'Two pictures at once')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (
    await chooser
  ).setFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: png(300, [235, 235, 235]) },
    { name: 'second.png', mimeType: 'image/png', buffer: png(200, [215, 215, 215]) },
  ])
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()

  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas.getByRole('button', { name: 'Attaching…' })).toBeVisible()
  // A second copy taken while the first encodes would go in without its document and take the queued
  // picture with it, so both wait: Attach original is out, and Escape (like the X and the backdrop)
  // leaves the canvas where it is.
  await expect(canvas.getByRole('button', { name: 'Attach original', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(canvas).toBeVisible()

  // The encode finishes on the picture it started on, and the one queued behind it gets its turn.
  await expect(canvas.locator('[data-slot="dialog-description"]')).toContainText('second.png')
  await canvas.getByRole('button', { name: 'Attach original', exact: true }).click()
  await expect(canvas).toBeHidden()
  // The picture that was encoding is in the form, once, with its (empty) document; the second follows.
  await expect(dialog.getByRole('img', { name: 'first.png' })).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'second.png' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments.map((a) => [a.name, a.annotations?.items.length ?? null])).toEqual([
    ['first.png', 0],
    ['second.png', null],
  ])
})

test('a note or a text longer than the document allows is capped, and the picture is kept', async ({
  page,
  project,
  human,
}) => {
  // The server refuses a document whose note or text is over 2000 characters, and the failed upload
  // drops the picture with the marks on it, so the canvas holds both fields at that length.
  const long = (c: string) => c.repeat(2_500)
  const capped = (c: string) => c.repeat(2_000)
  const dialog = await openNewTicket(page, project.id, 'A note too long to store')
  await pickWith(page, dialog.getByRole('button', { name: 'attach' }), {
    name: 'long.png',
    buffer: png(300, [240, 240, 240]),
  })
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()

  await canvas.getByRole('button', { name: 'Text', exact: true }).click()
  const textField = canvas.getByRole('textbox', { name: 'Text' })
  const noteField = canvas.getByRole('textbox', { name: 'Note' })
  await textField.fill(long('t'))
  await expect(textField).toHaveValue(capped('t'))
  const box = (await pictureOf(canvas).boundingBox())!
  await page.mouse.click(box.x + 20, box.y + 20)
  await expect(noteField).toBeEnabled()
  await noteField.fill(long('n'))
  await expect(noteField).toHaveValue(capped('n'))
  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas).toBeHidden()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments).toHaveLength(1)
  const [item] = ticket.attachments[0]!.annotations!.items
  expect(item!.kind).toBe('text')
  expect(item!.text).toHaveLength(2_000)
  expect(item!.note).toHaveLength(2_000)
})

test("a batch on a ticket's instructions is stored in the order it was picked, however long its first file takes to upload", async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Instructions in pick order' })
  // The first upload is held before it leaves the page, so the tiny file picked after it would land
  // first on the board if the two batches the canvas accepts were sent at once instead of one after
  // the other.
  await page.addInitScript(() => {
    const real = globalThis.fetch
    let held = false
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!held && String(input).includes('/api/uploads')) {
        held = true
        await new Promise((done) => setTimeout(done, 1_500))
      }
      return real(input, init)
    }
  })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  const chooser = page.waitForEvent('filechooser')
  await instructions.getByRole('button', { name: /attach/i }).click()
  await (
    await chooser
  ).setFiles([
    { name: 'big.png', mimeType: 'image/png', buffer: png(300, [205, 205, 205], 4_000_000) },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') },
  ])
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await attachOriginal(page)

  // The list under the instructions has them in pick order, and so does the ticket.
  const listed = () =>
    instructions.locator('ul > li').evaluateAll((els) => els.map((el) => el.textContent?.trim()))
  await expect.poll(listed).toEqual(['big.png', 'notes.md'])
  await expect
    .poll(async () => (await api.getTicket(t.id)).attachments.map((a) => a.name))
    .toEqual(['big.png', 'notes.md'])
})

test('the marks are locked while the picture is attaching, so the document is what Attach showed', async ({
  page,
  api,
}) => {
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
  const t = await api.ticket({ title: 'Locked while attaching' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await pickWith(page, instructions.getByRole('button', { name: /attach/i }), {
    name: 'locked.png',
    buffer: png(300, [220, 220, 220]),
  })
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await draw(page, canvas, 'Box', [40, 40], [180, 140])
  await canvas.getByLabel('Note').fill('the box that stays')
  // The Text tool and its field are on screen too, so both fields are part of the freeze.
  await canvas.getByRole('button', { name: 'Text', exact: true }).click()

  await canvas.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(canvas.getByRole('button', { name: 'Attaching…' })).toBeVisible()
  // Said on screen, not only through greyed controls.
  await expect(canvas.getByRole('status')).toHaveText('The marks are locked until the picture is attached.')

  const note = canvas.getByRole('textbox', { name: 'Note', exact: true })
  const text = canvas.getByRole('textbox', { name: 'Text', exact: true })
  for (const name of ['Pencil', 'Box', 'Arrow', 'Ellipse', 'Text', 'Note', 'Undo', 'Clear']) {
    const control = canvas.getByRole('button', { name, exact: true })
    await expect(control).toBeDisabled()
    // Forced, the click does nothing: the mark and the tool stay as they were.
    await control.click({ force: true })
  }
  await expect(note).toBeDisabled()
  await expect(text).toBeDisabled()
  await expect(canvas.getByLabel('Colour')).toBeDisabled()
  await expect(canvas.getByLabel('Stroke width')).toBeDisabled()
  await canvas.getByLabel('Colour').click({ force: true })
  await canvas.getByLabel('Stroke width').click({ force: true })
  // Typing at the locked fields goes nowhere.
  await note.click({ force: true })
  await page.keyboard.type('changed')
  await text.click({ force: true })
  await page.keyboard.type('changed')
  await expect(note).toHaveValue('the box that stays')
  await expect(text).toHaveValue('')
  await expect(canvas.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await expect(canvas).toBeHidden()
  // What was attached is the one mark there was when Attach was clicked: no undo, no clear, no extra
  // mark, no colour or width change, and the note that was written.
  await expect.poll(async () => (await api.getTicket(t.id)).attachments.length).toBe(1)
  const stored = (await api.getTicket(t.id)).attachments[0]!
  expect(stored.annotations!.items).toHaveLength(1)
  expect(stored.annotations!.items[0]).toMatchObject({
    kind: 'rect',
    color: '#e11d48',
    width: 4,
    note: 'the box that stays',
  })
})

test('a batch is stored in the order it was picked, however long its first file takes to upload', async ({
  page,
  project,
  human,
}) => {
  // A picture with megabytes of filler uploads far slower than the tiny PDF picked after it, which is
  // exactly the pair that showed the order following whichever upload finished first.
  const big = png(300, [205, 205, 205], 4_000_000)
  const dialog = await openNewTicket(page, project.id, 'Big picture first')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (
    await chooser
  ).setFiles([
    { name: 'big.png', mimeType: 'image/png', buffer: big },
    { name: 'spec.pdf', mimeType: 'application/pdf', buffer: pdf('Spec') },
  ])
  const canvas = canvasOf(page)
  await expect(canvas).toBeVisible()
  await expect(pictureOf(canvas)).toBeVisible()
  await attachOriginal(page)
  const pending = () =>
    dialog
      .getByRole('button', { name: /^Remove / })
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  await expect.poll(pending).toEqual(['Remove big.png', 'Remove spec.pdf'])
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const [first] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${first!.id}`))
  expect(ticket.attachments.map((a) => a.name)).toEqual(['big.png', 'spec.pdf'])

  // The other way round: a tiny file first, the picture after it.
  const second = await openNewTicket(page, project.id, 'Small file first')
  const secondChooser = page.waitForEvent('filechooser')
  await second.getByRole('button', { name: 'attach' }).click()
  await (
    await secondChooser
  ).setFiles([
    { name: 'tiny.pdf', mimeType: 'application/pdf', buffer: pdf('Tiny') },
    { name: 'second.png', mimeType: 'image/png', buffer: big },
  ])
  await expect(canvas).toBeVisible()
  await attachOriginal(page)
  await second.getByRole('button', { name: 'Create' }).click()
  await expect(second).toBeHidden()

  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const row = rows.find((r) => r.title === 'Small file first')!
  const other = await ok<TicketFull>(human.get(`/api/tickets/${row.id}`))
  expect(other.attachments.map((a) => a.name)).toEqual(['tiny.pdf', 'second.png'])
})
