import type { Page } from '@playwright/test'

import { expect, ok, test } from './fixtures'
import { delayApi, warm, watchLoading } from './loading'

const status = (page: Page, name: string) => page.getByRole('status', { name, exact: true })
const features = (id: number, view: string) => `/projects/${id}/features?view=${view}`
const tickets = (id: number) => new RegExp(`^/api/projects/${id}/tickets`)

test('the board shows labeled columns while the tickets load, then the board', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Board card' })
  await delayApi(page, tickets(project.id))
  await page.goto(features(project.id, 'board'))

  await expect(page.getByRole('tab', { name: 'Board' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
  const loading = status(page, 'Loading tickets…')
  await expect(loading).toBeVisible()
  // Columns, not one flat block.
  expect(await loading.locator('[data-slot=skeleton]').count()).toBeGreaterThan(4)
  expect((await loading.boundingBox())!.height).toBeGreaterThan(300)
  await expect(page.getByText('Board card')).toHaveCount(0)

  await expect(page.getByText('Board card')).toBeVisible()
  await expect(loading).toHaveCount(0)
})

test('the stage buttons keep their place while the tickets load', async ({ page, project, api }) => {
  await api.ticket({ title: 'Board card' })
  await delayApi(page, tickets(project.id))
  await page.goto(features(project.id, 'board'))

  const next = page.getByRole('button', { name: 'Next stage' })
  await expect(status(page, 'Loading tickets…')).toBeVisible()
  await expect(next).toBeDisabled()
  const before = await next.boundingBox()
  await expect(page.getByText('Board card')).toBeVisible()
  await expect(next).toBeEnabled()
  expect(await next.boundingBox()).toEqual(before)
})

test('the list shows bordered rows while the tickets load, then the rows', async ({ page, project, api }) => {
  await api.ticket({ title: 'Listed one' })
  await delayApi(page, tickets(project.id))
  await page.goto(features(project.id, 'list'))

  const loading = status(page, 'Loading tickets…')
  await expect(loading).toBeVisible()
  await expect(loading.locator('li')).toHaveCount(6)
  await expect(page.getByText('No tickets.')).toHaveCount(0)

  await expect(page.getByText('Listed one')).toBeVisible()
  await expect(loading).toHaveCount(0)
})

test('the first search answer shows rows, not a block, and the answer replaces them', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Needle ticket' })
  await page.goto(features(project.id, 'list'))
  await expect(page.getByText('Needle ticket')).toBeVisible()
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/tickets\\?.*q=`))
  await page.getByRole('searchbox', { name: 'Search tickets' }).fill('needle')

  const loading = status(page, 'Loading tickets…')
  await expect(loading).toBeVisible()
  await expect(loading.locator('li')).toHaveCount(6)
  await expect(page.getByText('Needle ticket')).toBeVisible()
  await expect(loading).toHaveCount(0)
})

test('the tag filter says it is loading tags, then lists them', async ({ page, project, human }) => {
  await ok(human.patch(`/api/projects/${project.id}`, { data: { tagSuggestions: ['Bug', 'UI'] } }))
  await page.goto(features(project.id, 'board'))
  await expect(page.getByText('Loading tags…')).toHaveCount(0)
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/tags`))
  await page.getByRole('combobox', { name: 'Filter by tag' }).click()

  await expect(status(page, 'Loading tags…')).toBeVisible()
  await expect(page.getByRole('option', { name: 'All tags' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Bug' })).toBeVisible()
  await expect(status(page, 'Loading tags…')).toHaveCount(0)
})

test('the Roadmap shows a labeled chart skeleton while it loads, then the chart', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Road ticket', status: 'in_progress' })
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/roadmap`))
  await page.goto(`/projects/${project.id}/roadmap`)

  await expect(page.getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  const loading = status(page, 'Loading roadmap…')
  await expect(loading).toBeVisible()
  expect(await loading.locator('[data-slot=skeleton]').count()).toBeGreaterThan(5)
  expect((await loading.boundingBox())!.height).toBeGreaterThan(250)

  await expect(page.getByTestId('roadmap')).toBeVisible()
  await expect(loading).toHaveCount(0)
})

test('a fast load of the Features page and the Roadmap draws no placeholder', async ({
  page,
  project,
  api,
}) => {
  await api.ticket({ title: 'Quick ticket', status: 'in_progress' })
  await warm(page, ...['board', 'list', 'archived'].map((view) => features(project.id, view)))
  const watch = await watchLoading(page)

  for (const view of ['board', 'list', 'archived']) {
    await page.goto(features(project.id, view))
    await expect(page.getByRole('tab', { name: 'Board' })).toBeVisible()
    if (view !== 'archived') await expect(page.getByText('Quick ticket')).toBeVisible()
    else await expect(page.getByText('Nothing archived.')).toBeVisible()
  }
  expect(await watch.seen()).toEqual([])

  await page.goto(`/projects/${project.id}/roadmap`)
  await expect(page.getByTestId('roadmap')).toBeVisible()
  expect(await watch.seen()).toEqual([])
})
