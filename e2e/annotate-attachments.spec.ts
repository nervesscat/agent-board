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
