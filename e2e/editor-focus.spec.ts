import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { CommentRow, TicketFull, TicketRow } from '#/lib/api'
import { png, sendFile } from './files'
import { expect, ok, test } from './fixtures'

const FORMATS = [
  'Bold',
  'Italic',
  'Strikethrough',
  'Inline code',
  'Heading',
  'Bullet list',
  'Numbered list',
  'Checklist',
  'Quote',
  'Code block',
  'Link',
]

/** The bordered box of a rich editor (its toolbar and its text), from the text. */
const boxOf = (text: Locator) => text.locator('xpath=ancestor::div[div[@role="toolbar"]][1]')

/** The formatting toolbar of a rich editor, from its text. */
const toolbarOf = (text: Locator) => boxOf(text).getByRole('toolbar', { name: 'Formatting' })

/** The New ticket dialog, opened with the title typed in (focus is still on the title). */
async function newTicket(page: Page, projectId: number, title: string) {
  await page.goto(`/projects/${projectId}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const titleBox = dialog.getByLabel('Title')
  await expect(titleBox).toBeFocused()
  await titleBox.fill(title)
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  return {
    dialog,
    title: titleBox,
    text,
    attach: dialog.getByRole('button', { name: 'attach' }),
    toolbar: toolbarOf(text),
    format: (name: string) => dialog.getByRole('button', { name, exact: true }),
  }
}

/** Creates the ticket in the dialog, and the ticket as saved (the project's only ticket). */
async function created(dialog: Locator, human: APIRequestContext, projectId: number) {
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${projectId}/tickets`))
  return ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
}

/** Creates the ticket in the dialog, and the body it was saved with. */
async function createdBody(dialog: Locator, human: APIRequestContext, projectId: number) {
  return (await created(dialog, human, projectId)).body
}

/**
 * Where the editor's box, its toolbar, the toolbar's last button and its text are drawn. Measured once
 * whatever moves the editor (a dialog zooming in) has finished, and all in the same frame.
 */
function measure(text: Locator) {
  return text.evaluate(async (el) => {
    const moving: Animation[] = []
    for (let node: Element | null = el; node; node = node.parentElement) moving.push(...node.getAnimations())
    await Promise.all(moving.map((a) => a.finished))
    const box = el.parentElement!.closest(':has(> [role="toolbar"])')!
    const bar = box.querySelector(':scope > [role="toolbar"]')!
    const rect = (e: Element) => {
      const { top, right, bottom, left } = e.getBoundingClientRect()
      return { top, right, bottom, left }
    }
    return { box: rect(box), bar: rect(bar), last: rect(bar.lastElementChild!), text: rect(el) }
  })
}

/** The editor's toolbar is drawn above its text. */
async function expectToolbarAbove(text: Locator) {
  const { bar, text: drawn } = await measure(text)
  expect(bar.bottom).toBeLessThanOrEqual(drawn.top)
}

/**
 * The editor's attach is the last button of its toolbar, drawn in the toolbar's row: inside the
 * editor's box and above its text.
 */
async function expectAttachInToolbar(text: Locator) {
  await expect(toolbarOf(text).getByRole('button').last()).toHaveAccessibleName(/attach/i)
  const { box, bar, last: attach, text: drawn } = await measure(text)
  expect(attach.left).toBeGreaterThanOrEqual(box.left)
  expect(attach.right).toBeLessThanOrEqual(box.right)
  expect(attach.top).toBeGreaterThanOrEqual(bar.top)
  expect(attach.bottom).toBeLessThanOrEqual(bar.bottom)
  expect(attach.bottom).toBeLessThanOrEqual(drawn.top)
}

/** The editor's toolbar has the formatting buttons and nothing else: no attach. */
async function expectFormatsOnly(text: Locator) {
  const buttons = toolbarOf(text).getByRole('button')
  await expect(buttons).toHaveCount(FORMATS.length)
  expect(await buttons.evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')))).toEqual(FORMATS)
}

test('Tab from the title reaches the instructions text, then the formatting buttons and attach, then the next field', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Keyboard only')
  await expectToolbarAbove(d.text)
  await expectAttachInToolbar(d.text)

  await page.keyboard.press('Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('hello')

  // From a plain paragraph Tab leaves the text for the buttons, one at a time, without typing anything.
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(d.attach).toBeFocused()
  await expect(d.text).toHaveText('hello')
  await page.keyboard.press('Tab')
  await expect(d.dialog.getByLabel('Initial tasks')).toBeFocused()

  // Shift+Tab walks the same way back.
  await page.keyboard.press('Shift+Tab')
  await expect(d.attach).toBeFocused()
  for (const name of [...FORMATS].reverse()) {
    await page.keyboard.press('Shift+Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await page.keyboard.press('Shift+Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(d.title).toBeFocused()

  expect(await createdBody(d.dialog, human, project.id)).toBe('hello')
})

test('the New ticket dialog has its one attach in the editor toolbar, not beside the Instructions label', async ({
  page,
  project,
}) => {
  const d = await newTicket(page, project.id, 'Where attach is')
  await expect(d.dialog.getByRole('button', { name: /attach/i })).toHaveCount(1)
  await expect(d.toolbar.getByRole('button', { name: 'attach' })).toBeVisible()
  // Above the editor's box: the label, and no button.
  await expect(boxOf(d.text).locator('xpath=preceding-sibling::label')).toHaveText('Instructions')
  await expect(boxOf(d.text).locator('xpath=preceding-sibling::*/descendant-or-self::button')).toHaveCount(0)
})

test('the toolbar attach is a paperclip with no text, named and titled like the formatting buttons', async ({
  page,
  project,
}) => {
  const d = await newTicket(page, project.id, 'Just the icon')
  const attach = d.toolbar.getByRole('button').last()
  await expect(attach).toHaveAccessibleName('Attach files')
  await expect(attach).toHaveAttribute('title', 'Attach files')
  await expect(attach).toHaveAttribute('aria-busy', 'false')
  await expect(attach).toHaveText('')
  expect(await attach.evaluate((b) => (b as HTMLElement).innerText.trim())).toBe('')
  await expect(attach.locator('svg')).toHaveCount(1)
  await expect(attach.locator('svg.lucide-paperclip')).toBeVisible()
  // As big as the formatting buttons beside it.
  const link = (await d.format('Link').boundingBox())!
  const clip = (await attach.boundingBox())!
  expect(clip.width).toBe(link.width)
  expect(clip.height).toBe(link.height)
})

test('the toolbar attach spins while its files upload, with no text, and is a paperclip again after', async ({
  page,
  api,
}) => {
  // Uploads wait until released, to see the button while one is on its way.
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/uploads', async (route) => {
    await held
    await route.continue()
  })

  const t = await api.ticket({ title: 'Busy attach', body: 'Instructions.' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await instructions.getByRole('button', { name: 'edit' }).click()
  const editor = instructions.getByRole('textbox', { name: 'Instructions' })
  const attach = toolbarOf(editor).getByRole('button').last()
  await expect(attach).toHaveAccessibleName('Attach files')

  const chooser = page.waitForEvent('filechooser')
  await attach.click()
  await (await chooser).setFiles({ name: 'slow.png', mimeType: 'image/png', buffer: png() })
  await expect(attach).toHaveAttribute('aria-busy', 'true')
  await expect(attach).toHaveAccessibleName('Attaching files…')
  await expect(attach).toHaveAttribute('title', 'Attaching files…')
  await expect(attach).toBeEnabled()
  await expect(attach).toHaveText('')
  await expect(attach.locator('svg')).toHaveCount(1)
  await expect(attach.locator('svg.lucide-loader-circle.animate-spin')).toBeVisible()

  release()
  await expect(attach).toHaveAttribute('aria-busy', 'false')
  await expect(attach).toHaveAccessibleName('Attach files')
  await expect(attach).toHaveAttribute('title', 'Attach files')
  await expect(attach).toHaveText('')
  await expect(attach.locator('svg')).toHaveCount(1)
  await expect(attach.locator('svg.lucide-paperclip')).toBeVisible()
  await expect
    .poll(async () => (await api.getTicket(t.id)).attachments.map((a) => a.name))
    .toEqual(['slow.png'])
})

test('with a file pending, Tab goes from attach to the file, and Shift+Tab back', async ({
  page,
  project,
}) => {
  const d = await newTicket(page, project.id, 'With a file')
  const chooser = page.waitForEvent('filechooser')
  await d.attach.click()
  await (await chooser).setFiles({ name: 'picked.png', mimeType: 'image/png', buffer: png() })
  const preview = d.dialog.getByRole('button', { name: 'Preview picked.png' })
  const remove = d.dialog.getByRole('button', { name: 'Remove picked.png' })
  await expect(preview).toBeVisible()
  await expect(d.dialog.getByLabel('uploading')).toHaveCount(0)

  await d.text.click()
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(d.attach).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(preview).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(d.dialog.getByLabel('Initial tasks')).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(preview).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(d.attach).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(d.format('Link')).toBeFocused()
})

test('the toolbar attach opens the file picker with Enter and Space without creating the ticket, and its files go with the ticket', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Files by keyboard')
  await page.keyboard.press('Tab')
  await expect(d.text).toBeFocused()
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(d.attach).toBeFocused()

  for (const [key, name] of [
    ['Enter', 'by-enter.png'],
    ['Space', 'by-space.png'],
  ] as const) {
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press(key)
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png() })
    await expect(d.dialog.getByRole('img', { name })).toBeVisible()
  }
  await expect(d.dialog).toBeVisible()
  expect(await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))).toEqual([])

  // A file removed and picked again (by mouse) is listed again.
  await d.dialog.getByRole('button', { name: 'Remove by-enter.png' }).click()
  await expect(d.dialog.getByRole('img', { name: 'by-enter.png' })).toHaveCount(0)
  const chooser = page.waitForEvent('filechooser')
  await d.attach.click()
  await (await chooser).setFiles({ name: 'by-enter.png', mimeType: 'image/png', buffer: png() })
  await expect(d.dialog.getByRole('img', { name: 'by-enter.png' })).toBeVisible()
  await expect(d.dialog.getByLabel('uploading')).toHaveCount(0)

  const ticket = await created(d.dialog, human, project.id)
  expect(ticket.title).toBe('Files by keyboard')
  expect(ticket.attachments.map((a) => a.name)).toEqual(['by-space.png', 'by-enter.png'])
})

test('a formatting button reached with Tab formats at the caret and gives the text its focus back', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Bold by keyboard')
  await page.keyboard.press('Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('a')

  // Space turns bold on...
  await page.keyboard.press('Tab')
  await expect(d.format('Bold')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('b')

  // ...and Enter turns it off.
  await page.keyboard.press('Tab')
  await expect(d.format('Bold')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('c')

  expect(await createdBody(d.dialog, human, project.id)).toBe('a**b**c')
})

test('in a list item Tab still indents and Shift+Tab outdents, with focus kept in the text', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Nested list')
  await page.keyboard.press('Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('- one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  const nested = d.text.locator('ul ul li')

  await page.keyboard.press('Tab')
  await expect(nested).toHaveText('two')
  await expect(d.text).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(nested).toHaveCount(0)
  await expect(d.text).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(nested).toHaveText('two')
  await expect(d.text).toBeFocused()

  expect(await createdBody(d.dialog, human, project.id)).toMatch(/^- one\n +- two$/)
})

test('every rich editor puts its text before its toolbar: ticket instructions and a reply', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Edit by keyboard', body: 'Old instructions.' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  const instructions = page.getByRole('region', { name: 'Instructions' })
  await instructions.getByRole('button', { name: 'edit' }).click()
  const editor = instructions.getByRole('textbox', { name: 'Instructions' })
  await expect(editor).toBeFocused()
  await expectToolbarAbove(editor)
  await page.keyboard.press('Tab')
  await expect(instructions.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  const post = page.getByRole('article')
  const actions = post.getByRole('group', { name: 'Post actions' })
  await actions.hover()
  await actions.getByRole('button', { name: 'reply', exact: true }).click()
  const reply = post.getByRole('textbox', { name: 'Reply' })
  await reply.click()
  await expect(reply).toBeFocused()
  await expectToolbarAbove(reply)
  await page.keyboard.press('Tab')
  await expect(post.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(reply).toBeFocused()
})

test('the ticket instructions have attach in the editor toolbar while editing, and in the header otherwise', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Attach while editing', body: 'Old instructions.' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  const attach = instructions.getByRole('button', { name: /attach/i })
  const listed = (name: string) => instructions.getByRole('listitem').filter({ hasText: name })
  const attached = async () => (await api.getTicket(t.id)).attachments.map((a) => a.name)

  // Not editing: no editor, and attach in the header attaches to the ticket at once.
  await expect(instructions.getByRole('toolbar')).toHaveCount(0)
  await expect(attach).toHaveCount(1)
  await expect(instructions.getByRole('button', { name: 'edit' })).toBeVisible()
  let chooser = page.waitForEvent('filechooser')
  await attach.click()
  await (await chooser).setFiles({ name: 'from-header.png', mimeType: 'image/png', buffer: png() })
  await expect(listed('from-header.png')).toBeVisible()
  await expect.poll(attached).toEqual(['from-header.png'])

  // Editing: the one attach is the toolbar's, after Link and before Cancel.
  await instructions.getByRole('button', { name: 'edit' }).click()
  const editor = instructions.getByRole('textbox', { name: 'Instructions' })
  await expect(editor).toBeFocused()
  await page.keyboard.type(' More.')
  await expect(attach).toHaveCount(1)
  await expect(toolbarOf(editor).getByRole('button', { name: 'attach' })).toBeVisible()
  await expectToolbarAbove(editor)
  await expectAttachInToolbar(editor)
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(instructions.getByRole('button', { name, exact: true })).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(attach).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(instructions.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(instructions.getByRole('button', { name: 'Save' })).toBeFocused()

  // Attaching from it attaches to the ticket at once, and leaves the text being edited alone.
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(attach).toBeFocused()
  chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles({ name: 'from-toolbar.png', mimeType: 'image/png', buffer: png() })
  await expect(listed('from-toolbar.png')).toBeVisible()
  await expect.poll(attached).toEqual(['from-header.png', 'from-toolbar.png'])
  await expect(editor).toBeVisible()
  await expect(editor).toHaveText('Old instructions. More.')
  expect((await api.getTicket(t.id)).body).toBe('Old instructions.')

  // Cancel drops the edit and keeps the file.
  await instructions.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toBeHidden()
  await expect(listed('from-toolbar.png')).toBeVisible()
  await expect(attach).toHaveCount(1)
  const saved = await api.getTicket(t.id)
  expect(saved.body).toBe('Old instructions.')
  expect(saved.attachments.map((a) => a.name)).toEqual(['from-header.png', 'from-toolbar.png'])
})

test('editors without an attach of their own have none in the toolbar; posts and replies have theirs in it', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'No attach here', status: 'in_progress' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // The resume note.
  await page.getByRole('button', { name: /^Leave a resume note/ }).click()
  const note = page.getByRole('region', { name: 'Resume here' }).getByRole('textbox', { name: 'Resume note' })
  await expect(note).toBeFocused()
  await expectFormatsOnly(note)

  // New post and Reply: one attach each, the toolbar's, adding to that form's files.
  const actions = page.getByRole('article').getByRole('group', { name: 'Post actions' })
  await actions.hover()
  await actions.getByRole('button', { name: 'reply', exact: true }).click()
  for (const [name, file] of [
    ['New post', 'for-the-post.png'],
    ['Reply', 'for-the-reply.png'],
  ]) {
    const text = page.getByRole('textbox', { name, exact: true })
    const form = page.locator('form').filter({ has: text })
    await expectAttachInToolbar(text)
    const attach = form.getByRole('button', { name: /attach/i })
    await expect(attach).toHaveCount(1)
    await expect(toolbarOf(text).getByRole('button', { name: /attach/i })).toHaveCount(1)
    const chooser = page.waitForEvent('filechooser')
    await attach.click()
    await (await chooser).setFiles({ name: file, mimeType: 'image/png', buffer: png() })
    await expect(form.getByRole('button', { name: `Remove ${file}` })).toBeVisible()
  }

  // The project instructions.
  await page.goto(`/projects/${t.projectId}/settings`)
  const settings = page.getByRole('region', { name: 'Project instructions' })
  await settings.getByRole('button', { name: 'No instructions yet. Click to write them.' }).click()
  const instructions = settings.getByRole('textbox', { name: 'Project instructions' })
  await expect(instructions).toBeFocused()
  await expectFormatsOnly(instructions)

  // An agent's instructions and when to delegate to it.
  await page.goto(`/projects/${t.projectId}/agents`)
  await page.getByRole('button', { name: 'New agent' }).click()
  for (const name of ['Instructions', 'When to delegate'])
    await expectFormatsOnly(page.getByRole('textbox', { name, exact: true }))
})

/** The form a composer's text is in: the New post form or a reply form. `text` is located from the page. */
const formOf = (page: Page, text: Locator) => page.locator('form').filter({ has: text })

/** Opens the reply box under the ticket's only post, and gives its text (located from the page). */
async function openReply(page: Page) {
  const actions = page.getByRole('article').getByRole('group', { name: 'Post actions' })
  await actions.hover()
  await actions.getByRole('button', { name: 'reply', exact: true }).click()
  return page.getByRole('textbox', { name: 'Reply', exact: true })
}

/** Picks a file with the composer's toolbar attach, and waits for its form to list it. */
async function pick(page: Page, text: Locator, name: string) {
  const chooser = page.waitForEvent('filechooser')
  await toolbarOf(text).getByRole('button', { name: 'Attach files', exact: true }).click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png() })
  await expect(formOf(page, text).getByRole('button', { name: `Remove ${name}` })).toBeVisible()
}

/** The editor's toolbar attach is the paperclip alone: no text, named and titled, as big as Link. */
async function expectPaperclip(text: Locator) {
  const bar = toolbarOf(text)
  const attach = bar.getByRole('button').last()
  await expect(attach).toHaveAccessibleName('Attach files')
  await expect(attach).toHaveAttribute('title', 'Attach files')
  await expect(attach).toHaveAttribute('aria-busy', 'false')
  expect(await attach.evaluate((b) => (b as HTMLElement).innerText.trim())).toBe('')
  await expect(attach.locator('svg')).toHaveCount(1)
  await expect(attach.locator('svg.lucide-paperclip')).toBeVisible()
  const link = (await bar.getByRole('button', { name: 'Link', exact: true }).boundingBox())!
  const clip = (await attach.boundingBox())!
  expect(clip.width).toBe(link.width)
  expect(clip.height).toBe(link.height)
}

test('the New post, Reply and New ticket attach is a paperclip with no text, as big as the Link button', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Just the icon' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const reply = await openReply(page)
  for (const text of [page.getByRole('textbox', { name: 'New post', exact: true }), reply]) {
    await expectPaperclip(text)
    await expect(formOf(page, text)).not.toContainText(/attach/i)
  }

  const d = await newTicket(page, t.projectId, 'Just the icon too')
  await expectPaperclip(d.text)
})

test('a file picked with the New post toolbar attach is listed under the editor, and goes with the post', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Post a file' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const text = page.getByRole('textbox', { name: 'New post', exact: true })
  const form = formOf(page, text)
  await text.click()
  await page.keyboard.type('See the picture.')

  // Picking lists the file under the editor, and posts nothing.
  await pick(page, text, 'x.png')
  const preview = form.getByRole('button', { name: 'Preview x.png' })
  await expect(preview).toBeVisible()
  const { box } = await measure(text)
  expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(box.bottom)
  await expect(text).toHaveText('See the picture.')
  expect((await api.getTicket(t.id)).updates).toEqual([])

  // A file removed and picked again is listed again.
  const remove = form.getByRole('button', { name: 'Remove x.png' })
  await remove.click()
  await expect(remove).toHaveCount(0)
  await pick(page, text, 'x.png')
  await expect(remove).toHaveCount(1)

  // Post sends it with the text, and clears the form.
  await form.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(text).toHaveText('')
  await expect(remove).toHaveCount(0)
  const [saved] = (await api.getTicket(t.id)).updates
  expect(saved).toMatchObject({ body: 'See the picture.', progress: false })
  expect(saved!.attachments.map((a) => a.name)).toEqual(['x.png'])
})

test('a file picked with the Reply toolbar attach is listed in the reply form, and goes with the reply', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Reply with a file' })
  const { id } = await ok<{ id: number }>(
    human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }),
  )
  const replies = () => ok<CommentRow[]>(human.get(`/api/comments?parentType=update&parentId=${id}`))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const text = await openReply(page)
  const form = formOf(page, text)
  await text.click()
  await page.keyboard.type('Here it is.')

  // Picking lists the file in the reply form, and replies nothing.
  await pick(page, text, 'y.png')
  await expect(form.getByRole('button', { name: 'Preview y.png' })).toBeVisible()
  await expect(text).toHaveText('Here it is.')
  expect(await replies()).toEqual([])

  // A file removed and picked again is listed again.
  const remove = form.getByRole('button', { name: 'Remove y.png' })
  await remove.click()
  await expect(remove).toHaveCount(0)
  await pick(page, text, 'y.png')
  await expect(remove).toHaveCount(1)

  // Reply sends it with the text, and clears the form.
  await form.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('article').getByText('Here it is.')).toBeVisible()
  await expect(text).toHaveText('')
  await expect(remove).toHaveCount(0)
  const [saved] = await replies()
  expect(saved).toMatchObject({ body: 'Here it is.', author: 'enrique' })
  expect(saved!.attachments.map((a) => a.name)).toEqual(['y.png'])
})

test('from the New post text, Tab reaches the formatting buttons, attach, its files, then Post; Enter and Space on attach post nothing', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Post files by keyboard' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const text = page.getByRole('textbox', { name: 'New post', exact: true })
  const form = formOf(page, text)
  const attach = toolbarOf(text).getByRole('button', { name: 'Attach files', exact: true })
  const format = (name: string) => toolbarOf(text).getByRole('button', { name, exact: true })
  await text.click()
  await page.keyboard.type('hello')

  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(format(name)).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(attach).toBeFocused()

  for (const [key, name] of [
    ['Enter', 'by-enter.png'],
    ['Space', 'by-space.png'],
  ] as const) {
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press(key)
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png() })
    await expect(form.getByRole('button', { name: `Remove ${name}` })).toBeVisible()
  }
  await expect(text).toHaveText('hello')
  expect((await api.getTicket(t.id)).updates).toEqual([])

  // With files pending, Tab goes on from attach to them, then to the rest of the form.
  await text.click()
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(format(name)).toBeFocused()
  }
  for (const next of [
    attach,
    form.getByRole('button', { name: 'Preview by-enter.png' }),
    form.getByRole('button', { name: 'Remove by-enter.png' }),
    form.getByRole('button', { name: 'Preview by-space.png' }),
    form.getByRole('button', { name: 'Remove by-space.png' }),
    form.getByRole('button', { name: 'Post', exact: true }),
  ]) {
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
  }
  await expect(text).toHaveText('hello')
  expect((await api.getTicket(t.id)).updates).toEqual([])
})

test('files pasted in or dropped on the New post and Reply composers are listed as files, not text', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Paste and drop' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await openReply(page)
  for (const name of ['New post', 'Reply']) {
    const text = page.getByRole('textbox', { name, exact: true })
    const form = formOf(page, text)
    const css = `form:has([role="textbox"][aria-label="${name}"])`
    await sendFile(page, `${css} [role="textbox"]`, 'paste', {
      name: 'pasted.png',
      mime: 'image/png',
      data: png(),
    })
    await expect(form.getByRole('button', { name: 'Remove pasted.png' })).toBeVisible()
    await expect(text).toHaveText('')
    // Dropped on the form, outside the text.
    await sendFile(page, `${css} [role="toolbar"]`, 'drop', {
      name: 'dropped.png',
      mime: 'image/png',
      data: png(),
    })
    await expect(form.getByRole('button', { name: 'Remove dropped.png' })).toBeVisible()
    await expect(text).toHaveText('')
  }
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the toolbar, attach with it, is still drawn above the text in the New ticket dialog', async ({
    page,
    project,
  }) => {
    const d = await newTicket(page, project.id, 'On a phone')
    await expectToolbarAbove(d.text)
    await expectAttachInToolbar(d.text)
  })

  test('the New post toolbar, attach with it, is still drawn above the text on a ticket', async ({
    page,
    api,
  }) => {
    const t = await api.ticket({ title: 'Post on a phone' })
    await page.goto(`/projects/${t.projectId}/features/${t.id}`)
    const text = page.getByRole('textbox', { name: 'New post', exact: true })
    await expectToolbarAbove(text)
    await expectAttachInToolbar(text)
  })
})
