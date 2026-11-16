import type { Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/** The formatting toolbar of a rich editor, from its text. */
const toolbarOf = (text: Locator) =>
  text.locator('xpath=ancestor::div[div[@role="toolbar"]][1]').getByRole('toolbar', { name: 'Formatting' })

/**
 * Selects the word `word` in the editor's first line, by keyboard: the caret goes to the start of the
 * line, past `before` characters, then the next `word.length` are selected.
 */
async function selectWord(page: Page, editor: Locator, before: number, word: string) {
  await editor.click()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < before; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowRight')
  expect(await editor.evaluate(() => window.getSelection()?.toString())).toBe(word)
}

test('a bold on the selected word of the New ticket instructions marks only that word', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Partial bold')
  const text = dialog.getByRole('textbox', { name: 'Instructions' })
  await text.click()
  await page.keyboard.type('Hello brave world')

  await selectWord(page, text, 6, 'brave')
  await toolbarOf(text).getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(text.locator('strong')).toHaveText('brave')
  await expect(text.locator('strong')).toHaveCount(1)

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const saved = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(saved.body).toBe('Hello **brave** world')
})

test('a heading on the selected word of a reply makes only that word a heading', async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Partial heading in a reply' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  const post = page.getByRole('article')
  const actions = post.getByRole('group', { name: 'Post actions' })
  await actions.hover()
  await actions.getByRole('button', { name: 'reply', exact: true }).click()
  const reply = post.getByRole('textbox', { name: 'Reply' })
  await reply.click()
  await page.keyboard.type('Hello brave world')

  await selectWord(page, reply, 6, 'brave')
  await toolbarOf(reply).getByRole('button', { name: 'Heading', exact: true }).click()
  await expect(reply.getByRole('heading', { level: 2 })).toHaveText('brave')
  await expect(reply.getByRole('heading')).toHaveCount(1)
  await expect(reply.locator('p').first()).toHaveText(/^Hello/)
  await expect(reply.locator('p').last()).toHaveText(/world$/)
})
