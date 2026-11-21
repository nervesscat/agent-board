import type { APIRequestContext, Page } from '@playwright/test'

import { expect, ok, test } from './fixtures'
import { png } from './files'
import { delayApi, warm, watchLoading } from './loading'

const status = (page: Page, name: string) => page.getByRole('status', { name, exact: true })

async function upload(ctx: APIRequestContext, name: string, data: Buffer) {
  return ok<{ id: number }>(ctx.post('/api/uploads', { data: { name, base64: data.toString('base64') } }))
}

test('a thread that loads slowly shows a labeled placeholder, never the empty state, then the replies', async ({
  page,
  project,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Threaded work' })
  const post = await ok<{ id: number }>(
    human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'A post to answer.' } }),
  )
  await ok(
    human.post('/api/comments', {
      data: { parentType: 'update', parentId: post.id, body: 'Answer in time.' },
    }),
  )
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByText('A post to answer.')).toBeVisible()
  await delayApi(page, /^\/api\/comments/)
  await page.getByRole('button', { name: '1 reply', exact: true }).click()

  await expect(status(page, 'Loading replies…')).toBeVisible()
  await expect(page.getByText('No comments yet.')).toHaveCount(0)
  await expect(page.getByText('Answer in time.')).toBeVisible()
  await expect(status(page, 'Loading replies…')).toHaveCount(0)
})

test('the assignee, branch and needs controls keep their shape and say nothing false while their lists load', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'Details under load' })
  await api.ticket({ title: 'Some other ticket' })
  await delayApi(page, /^\/api\/actors/)
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/tickets$`))
  await delayApi(page, /^\/api\/repos\/\d+\/branches/)
  await page.goto(`/projects/${project.id}/features/${t.id}`)

  const assignee = page.locator('#assignee')
  const branch = page.locator('#branch')
  const needs = page.locator('#needs')
  await expect(assignee).toBeVisible()
  await expect(branch).toBeVisible()
  // Disabled, and no state a list that has not answered could not know.
  await expect(assignee).toBeDisabled()
  await expect(assignee).not.toContainText('Unassigned')
  await expect(needs).toBeDisabled()
  await expect(needs).not.toContainText('No other tickets')
  await expect(status(page, 'Loading agents…')).toBeVisible()
  await expect(status(page, 'Loading tickets…')).toBeVisible()
  await expect(status(page, 'Loading branches…')).toBeVisible()
  const role = await branch.evaluate((el) => `${el.tagName} ${el.getAttribute('role')}`)

  await expect(assignee).toBeEnabled()
  await expect(assignee).toContainText('Unassigned')
  await expect(needs).toBeEnabled()
  await expect(needs).toContainText('Add a ticket it needs merged first…')
  await expect(status(page, 'Loading agents…')).toHaveCount(0)
  await expect(status(page, 'Loading tickets…')).toHaveCount(0)
  await expect(status(page, 'Loading branches…')).toHaveCount(0)
  expect(await branch.evaluate((el) => `${el.tagName} ${el.getAttribute('role')}`)).toBe(role)
})

test('an attachment thumbnail shows a skeleton in a box of its own until the picture lands or fails', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Pictured work' })
  const good = await upload(agent, 'shot.png', png(64))
  const bad = await upload(agent, 'broken.png', Buffer.from('this is not a picture'))
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: 'Two pictures.', attachmentIds: [good.id, bad.id] },
    }),
  )
  await delayApi(page, /^\/api\/uploads\/\d+/)
  await page.goto(`/projects/${project.id}/features/${t.id}`)

  const box = (name: string) => page.locator('a', { has: page.locator(`img[alt="${name}"]`) })
  const height = async (name: string) => (await box(name).boundingBox())!.height
  await expect(box('shot.png')).toBeVisible()
  await expect(box('shot.png').locator('[data-slot=skeleton]')).toBeVisible()
  // Until the bytes arrive the box already has a size, so the placeholder is not a thin line.
  expect(await height('shot.png')).toBeGreaterThan(100)

  await expect(box('shot.png').locator('[data-slot=skeleton]')).toHaveCount(0)
  await expect(box('broken.png').locator('[data-slot=skeleton]')).toHaveCount(0)
})

test('the New ticket dialog opens at once; Create waits, with a placeholder, for the project', async ({
  page,
  project,
}) => {
  await delayApi(page, new RegExp(`^/api/projects/${project.id}$`))
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog', { name: 'New ticket' })

  await expect(dialog.getByLabel('Title')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
  await expect(status(page, "Loading the project's phases…")).toBeVisible()
  await expect(dialog.getByText(/It starts with the project/)).toBeVisible()
  await expect(status(page, "Loading the project's phases…")).toHaveCount(0)
  await dialog.getByLabel('Title').fill('Ready now')
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeEnabled()
})

test('the folder picker shows labeled rows while the first listing is on its way', async ({
  page,
  project,
}) => {
  await delayApi(page, /^\/api\/fs\/dirs/)
  await page.goto(`/projects/${project.id}/repositories`)
  await page.getByRole('button', { name: 'New repository' }).click()
  await page.getByRole('button', { name: 'Browse…' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose the checkout' })

  await expect(status(page, 'Loading folders…')).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  const list = picker.getByRole('list', { name: 'Folders' })
  const height = (await list.boundingBox())!.height
  await expect(status(page, 'Loading folders…')).toHaveCount(0)
  expect((await list.boundingBox())!.height).toBe(height)
})

test('the palette recents show a placeholder while the tickets they name are on their way', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'Remembered ticket' })
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    ['command-palette.recents', JSON.stringify([`ticket:${project.id}:${t.id}`])],
  )
  // The recents' list is the features page's own, so it is held back from the first load on: the palette
  // opened while the page is still waiting for it is the state under test (a cached list is never pending).
  await page.route(
    (url) => url.pathname === `/api/projects/${project.id}/tickets` && url.search === '?parent=root',
    async (route) => {
      await new Promise((r) => setTimeout(r, 3000))
      await route.continue().catch(() => {})
    },
  )
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByRole('heading', { name: 'Ongoing features' })).toBeVisible()
  await page.keyboard.press('Control+f')
  const palette = page.getByRole('dialog', { name: 'Search the board' })
  await expect(status(page, 'Loading recent tickets…')).toBeVisible()
  await expect(palette.getByRole('option', { name: /Remembered ticket/ })).toBeVisible()
  await expect(status(page, 'Loading recent tickets…')).toHaveCount(0)
})

test('fast loads draw no placeholder in the New ticket dialog or the ticket details', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'Quick details' })
  await api.ticket({ title: 'Another ticket' })
  await warm(page, `/projects/${project.id}/features/${t.id}`, `/projects/${project.id}/features`)
  const watch = await watchLoading(page)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.locator('#assignee')).toContainText('Unassigned')
  await expect(page.locator('#needs')).toBeEnabled()
  await expect(page.locator('#branch')).toBeVisible()
  await page.getByRole('button', { name: 'New lane' }).click()
  await expect(page.getByRole('dialog', { name: 'New lane' })).toBeVisible()
  await page.keyboard.press('Escape')
  // The git state, runs and timeline load on their own and may pass 150 ms on a loaded machine, so the
  // ticket page is held to its page-level placeholder; the page after it must show none at all.
  const onTicket = await watch.seen()
  expect(onTicket).not.toContain('Loading ticket…')
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(page.getByText(/It starts with the project/)).toBeVisible()
  expect((await watch.seen()).slice(onTicket.length)).toEqual([])
})

test('the palette on a page outside a project shows no recents placeholder for a remembered ticket', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'Remembered ticket' })
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    ['command-palette.recents', JSON.stringify([`ticket:${project.id}:${t.id}`])],
  )
  await page.goto('/')
  await page.keyboard.press('Control+f')
  await expect(page.getByRole('dialog', { name: 'Search the board' })).toBeVisible()
  // Well past the 150 ms a placeholder waits: the tickets are not asked for here, so none is on its way.
  await page.waitForTimeout(600)
  await expect(status(page, 'Loading recent tickets…')).toHaveCount(0)
})
