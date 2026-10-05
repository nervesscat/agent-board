import type { Attachment, CleanupReport } from '#/lib/api'
import { alone, uploadedDaysAgo } from './db'
import { png } from './files'
import { expect, ok, test } from './fixtures'

test('the Cleanup page lists old unattached uploads and deletes them after asking; agents may not', async ({
  page,
  project,
  human,
  agent,
}) => {
  const file = await ok<Attachment & { url: string }>(
    human.post('/api/uploads', {
      multipart: { file: { name: 'forgotten.png', mimeType: 'image/png', buffer: png() } },
    }),
  )
  // Only the human deletes them.
  expect((await agent.delete('/api/uploads/unattached')).status()).toBe(403)

  await alone('old-uploads', async () => {
    // Old unattached uploads are the board's, not the project's: no other test makes them meanwhile.
    uploadedDaysAgo(file.id, 2)
    const { uploads } = await ok<CleanupReport>(human.get(`/api/projects/${project.id}/cleanup?reach=0`))
    expect(uploads.count).toBeGreaterThanOrEqual(1)

    await page.goto(`/projects/${project.id}/cleanup`)
    const heading = page.getByRole('heading', { name: /^Unattached uploads/ })
    await expect(heading).toContainText(`· ${uploads.count} ·`)
    const files = uploads.count === 1 ? '1 file' : `${uploads.count} files`
    await expect(page.getByText(new RegExp(`^${files}, `))).toBeVisible()

    // Delete now asks first; Keep keeps them.
    await page.getByRole('button', { name: 'Delete now' }).click()
    const ask = page.getByRole('alertdialog')
    await expect(ask).toContainText('Delete the unattached uploads?')
    await expect(ask).toContainText('This cannot be undone.')
    await ask.getByRole('button', { name: 'Keep' }).click()
    await expect(ask).toBeHidden()
    expect((await human.get(file.url)).status()).toBe(200)

    await page.getByRole('button', { name: 'Delete now' }).click()
    await ask.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText(new RegExp(`^Deleted ${files} \\(`))).toBeVisible()
    await expect(heading).toHaveCount(0)
    expect((await human.get(file.url)).status()).toBe(404)
  })
})

test('a recent unattached upload is left alone', async ({ project, human }) => {
  const file = await ok<Attachment & { url: string }>(
    human.post('/api/uploads', {
      multipart: { file: { name: 'just-now.png', mimeType: 'image/png', buffer: png() } },
    }),
  )
  await alone('old-uploads', async () => {
    const before = await ok<CleanupReport>(human.get(`/api/projects/${project.id}/cleanup?reach=0`))
    expect(before.uploads.recent).toBeGreaterThanOrEqual(1)
    await ok(human.delete('/api/uploads/unattached'))
  })
  expect((await human.get(file.url)).status()).toBe(200)
})

test('an old upload that a post links to by its address is kept', async ({ api, human }) => {
  const upload = (name: string) =>
    ok<Attachment & { url: string }>(
      human.post('/api/uploads', { multipart: { file: { name, mimeType: 'image/png', buffer: png() } } }),
    )
  const linked = await upload('linked.png')
  const loose = await upload('loose.png')
  const t = await api.ticket({ title: 'Links a file', status: 'in_progress' })
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: `See ![the screen](${linked.url})` } }))

  await alone('old-uploads', async () => {
    uploadedDaysAgo(linked.id, 2)
    uploadedDaysAgo(loose.id, 2)
    const swept = await ok<{ deleted: number }>(human.delete('/api/uploads/unattached'))
    expect(swept.deleted).toBeGreaterThanOrEqual(1)
  })
  expect((await human.get(loose.url)).status()).toBe(404)
  expect((await human.get(linked.url)).status()).toBe(200)
})
