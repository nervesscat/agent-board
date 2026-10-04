import type { Locator } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { png, sendFile } from './files'
import { expect, ok, test } from './fixtures'

/** Whether an <img> decoded: a broken one (a revoked or wrong URL) has no natural width. */
const decoded = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)

test('attaches files in the New ticket dialog by button, paste and drop, and they go with the ticket', async ({
  page,
  project,
  human,
}) => {
  // Uploads wait until released, to see the dialog while one is on its way.
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/uploads', async (route) => {
    await held
    await route.continue()
  })

  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('With pictures')
  const create = dialog.getByRole('button', { name: /^(Create|Uploading…)$/ })

  // The attach button opens the file picker.
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (await chooser).setFiles({ name: 'picked.png', mimeType: 'image/png', buffer: png(8, [200, 30, 30]) })
  const picked = dialog.getByRole('img', { name: 'picked.png' })
  await expect(picked).toBeVisible()
  await expect.poll(() => decoded(picked)).toBe(true)
  await expect(dialog.getByLabel('uploading')).toHaveCount(1)
  await expect(create).toBeDisabled()
  await expect(create).toHaveText('Uploading…')

  // A screenshot pasted in the instructions (it arrives as "image.png" and gets a name of its own).
  await sendFile(page, '[role="dialog"] [contenteditable="true"]', 'paste', {
    name: 'image.png',
    mime: 'image/png',
    data: png(8, [30, 200, 30]),
  })
  const pasted = dialog.getByRole('img', { name: /^pasted-.*\.png$/ })
  await expect(pasted).toBeVisible()
  await expect.poll(() => decoded(pasted)).toBe(true)
  // The file went to the list, not into the text.
  await expect(dialog.getByRole('textbox', { name: 'Instructions' })).toHaveText('')

  // A file dropped anywhere on the dialog.
  await sendFile(page, '[role="dialog"] h2', 'drop', {
    name: 'dropped.png',
    mime: 'image/png',
    data: png(8, [30, 30, 200]),
  })
  const dropped = dialog.getByRole('img', { name: 'dropped.png' })
  await expect(dropped).toBeVisible()
  await expect.poll(() => decoded(dropped)).toBe(true)
  await expect(dialog.locator('img')).toHaveCount(3)
  await expect(dialog.getByLabel('uploading')).toHaveCount(3)
  await expect(create).toBeDisabled()

  // Removing one drops it from the ticket.
  await dialog.getByRole('button', { name: 'Remove dropped.png' }).click()
  await expect(dropped).toHaveCount(0)

  release()
  await expect(dialog.getByLabel('uploading')).toHaveCount(0)
  await expect(create).toHaveText('Create')
  await expect(create).toBeEnabled()
  // Thumbnails still decode once the uploads finish.
  expect(await decoded(picked)).toBe(true)
  expect(await decoded(pasted)).toBe(true)
  await create.click()
  await expect(dialog).toBeHidden()

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))
  expect(ticket.attachments.map((a) => a.name)).toEqual([
    'picked.png',
    expect.stringMatching(/^pasted-.*\.png$/),
  ])

  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  for (const a of ticket.attachments) {
    const img = instructions.getByRole('img', { name: a.name })
    await expect(img).toBeVisible()
    await expect.poll(() => decoded(img)).toBe(true)
    await expect(instructions.getByRole('listitem').filter({ hasText: a.name })).toBeVisible()
  }
})

test('a file that fails to upload is dropped with a toast, and Create works without it', async ({
  page,
  project,
  human,
}) => {
  await page.route('**/api/uploads', (route) =>
    route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'too large' }),
    }),
  )
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Without the file')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'attach' }).click()
  await (await chooser).setFiles({ name: 'huge.png', mimeType: 'image/png', buffer: png() })
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'huge.png' })).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'huge.png' })).toHaveCount(0)
  const create = dialog.getByRole('button', { name: 'Create' })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(dialog).toBeHidden()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect((await ok<TicketFull>(human.get(`/api/tickets/${row!.id}`))).attachments).toEqual([])
})
