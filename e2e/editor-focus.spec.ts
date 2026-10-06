import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
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

/** The New ticket dialog, opened with the title typed in (focus is still on the title). */
async function newTicket(page: Page, projectId: number, title: string) {
  await page.goto(`/projects/${projectId}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const titleBox = dialog.getByLabel('Title')
  await expect(titleBox).toBeFocused()
  await titleBox.fill(title)
  return {
    dialog,
    title: titleBox,
    text: dialog.getByRole('textbox', { name: 'Instructions' }),
    attach: dialog.getByRole('button', { name: 'attach' }),
    format: (name: string) => dialog.getByRole('button', { name, exact: true }),
  }
}

/** Creates the ticket in the dialog, and the body it was saved with (the project's only ticket). */
async function createdBody(dialog: Locator, human: APIRequestContext, projectId: number) {
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${projectId}/tickets`))
  return (await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))).body
}

/** The toolbar is drawn above the text, inside the editor's box. */
async function expectToolbarAbove(scope: Locator | Page, text: Locator) {
  const bar = await scope.getByRole('toolbar', { name: 'Formatting' }).boundingBox()
  const box = await text.boundingBox()
  expect(bar).not.toBeNull()
  expect(box).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(box!.y + 1)
}

test('Tab from the title reaches the instructions text, then the formatting buttons, then the next field', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Keyboard only')
  await expectToolbarAbove(d.dialog, d.text)

  await page.keyboard.press('Tab')
  await expect(d.attach).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.type('hello')

  // From a plain paragraph Tab leaves the text for the buttons, one at a time, without typing anything.
  for (const name of FORMATS) {
    await page.keyboard.press('Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await expect(d.text).toHaveText('hello')
  await page.keyboard.press('Tab')
  await expect(d.dialog.getByLabel('Initial tasks, one per line')).toBeFocused()

  // Shift+Tab walks the same way back.
  for (const name of [...FORMATS].reverse()) {
    await page.keyboard.press('Shift+Tab')
    await expect(d.format(name)).toBeFocused()
  }
  await page.keyboard.press('Shift+Tab')
  await expect(d.text).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(d.attach).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(d.title).toBeFocused()

  expect(await createdBody(d.dialog, human, project.id)).toBe('hello')
})

test('a formatting button reached with Tab formats at the caret and gives the text its focus back', async ({
  page,
  project,
  human,
}) => {
  const d = await newTicket(page, project.id, 'Bold by keyboard')
  await page.keyboard.press('Tab')
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
  await expectToolbarAbove(instructions, editor)
  await page.keyboard.press('Tab')
  await expect(instructions.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  const post = page.getByRole('article')
  const header = post.locator('.group\\/post').first()
  await header.hover()
  await header.getByRole('button', { name: 'reply', exact: true }).click()
  const reply = post.getByRole('textbox', { name: 'Reply' })
  await reply.click()
  await expect(reply).toBeFocused()
  await expectToolbarAbove(post, reply)
  await page.keyboard.press('Tab')
  await expect(post.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(reply).toBeFocused()
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the toolbar is still drawn above the text in the New ticket dialog', async ({ page, project }) => {
    const d = await newTicket(page, project.id, 'On a phone')
    await expectToolbarAbove(d.dialog, d.text)
  })
})
