import type { Repo } from '#/lib/api'
import { expect, ok, test } from './fixtures'
import { backslashCheckout } from './repos'

/** The repositories page's card for the repo of that name. */
const card = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('button').filter({ has: page.locator('[data-slot="card-title"]', { hasText: name }) })

test('a body written by hand with \\\\ separators adds the repo at exactly that path', async ({
  human,
  project,
  page,
}) => {
  const repoPath = backslashCheckout('api-backslash')
  const name = `api-backslash-${project.id}`
  // The JSON text as a client writing it by hand sends it: each backslash doubled.
  const body = `{"projectId":${project.id},"name":"${name}","repoPath":"${repoPath.replaceAll('\\', '\\\\')}"}`
  expect(body).toContain(String.raw`\\`)
  const created = await ok<Repo>(
    human.post('/api/repos', { data: Buffer.from(body), headers: { 'content-type': 'application/json' } }),
  )
  expect(created.repoPath).toBe(repoPath)
  const listed = await ok<Repo[]>(human.get('/api/repos'))
  expect(listed.find((r) => r.id === created.id)?.repoPath).toBe(repoPath)

  await page.goto(`/projects/${project.id}/repositories`)
  await expect(card(page, name).locator('[data-slot="card-content"] .font-mono')).toHaveText(repoPath)
})

test('a body that is not JSON is refused with the reason and how a backslash is written', async ({
  human,
  project,
}) => {
  // What is left of such a body once a shell collapses \\ to \: \c is no JSON escape.
  const res = await human.post('/api/repos', {
    // A Buffer goes as these bytes; a string that does not parse would be sent JSON-encoded instead.
    data: Buffer.from(String.raw`{"projectId":${project.id},"repoPath":"C:\code\repo"}`),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status()).toBe(400)
  const { error } = (await res.json()) as { error: string }
  expect(error).toMatch(/^body must be JSON: .*escaped character/i)
  const backslash = String.fromCharCode(0x5c)
  expect(error).toContain(
    `; a backslash in a JSON string is written ${backslash}${backslash} (or ${backslash}u005c)`,
  )
})

test('the edit dialog moves a repo to a checkout typed with backslashes, at exactly that path', async ({
  human,
  page,
}, info) => {
  const name = `edit-backslash-${info.workerIndex}-${Date.now()}`
  const created = await ok<{ id: number }>(human.post('/api/projects', { data: { name } }))
  await ok<Repo>(
    human.post('/api/repos', {
      data: { projectId: created.id, repoPath: backslashCheckout('edit-from'), name },
    }),
  )
  const repoPath = backslashCheckout('edit-to')
  await page.goto(`/projects/${created.id}/repositories`)
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await card(page, name).click()
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
  await dialog.getByLabel('Repository path').fill(repoPath)
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(card(page, name).locator('[data-slot="card-content"] .font-mono')).toHaveText(repoPath)
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  const listed = await ok<Repo[]>(human.get('/api/repos'))
  expect(listed.filter((r) => r.name === name).map((r) => r.repoPath)).toEqual([repoPath])
})

test('the New repository dialog adds a checkout typed with backslashes, at exactly that path', async ({
  human,
  page,
}, info) => {
  const repoPath = backslashCheckout('dialog-backslash')
  const name = `dialog-backslash-${info.workerIndex}-${Date.now()}`
  // A project of its own, so no other test's project gains a second repo.
  const created = await ok<{ id: number }>(human.post('/api/projects', { data: { name } }))
  await page.goto(`/projects/${created.id}/repositories`)
  // The skeleton goes once the content is drawn: a click before that is lost, as the content is replaced.
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'New repository' }).click()
  const dialog = page.getByRole('dialog', { name: 'New repository' })
  // The page's project is the one the repo goes to.
  await expect(dialog.getByLabel('Project').locator('[data-slot="select-value"]')).toHaveText(name)
  await dialog.getByLabel('Repository path').fill(repoPath)
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Add repository' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(card(page, name).locator('[data-slot="card-content"] .font-mono')).toHaveText(repoPath)
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  const listed = await ok<Repo[]>(human.get('/api/repos'))
  expect(listed.filter((r) => r.name === name).map((r) => r.repoPath)).toEqual([repoPath])
})
