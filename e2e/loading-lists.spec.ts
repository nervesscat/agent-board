import type { APIRequestContext, Locator, Page } from '@playwright/test'

import { expect, ok, test } from './fixtures'
import { png } from './files'
import { delayApi, watchLoading } from './loading'

const status = (page: Page | Locator, name: string) => page.getByRole('status', { name, exact: true })

async function writeReport(agent: APIRequestContext, projectId: number, ticketId: number, name: string) {
  const res = await agent.post('/api/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'write_run_report', arguments: { projectId, ticketId, agent: name } },
    },
  })
  await ok(res)
}

async function upload(ctx: APIRequestContext, name: string, data: Buffer) {
  return ok<{ id: number }>(ctx.post('/api/uploads', { data: { name, base64: data.toString('base64') } }))
}

test('Run reports: a slow load shows a labeled placeholder, and a filter keeps the rows dimmed', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Reported work' })
  await writeReport(agent, project.id, t.id, 'hunt')
  await writeReport(agent, project.id, t.id, 'verify')
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/run-reports`))
  await page.goto(`/projects/${project.id}/run-reports`)

  await expect(page.getByRole('heading', { name: 'Run reports' })).toBeVisible()
  await expect(status(page, 'Loading run reports…')).toBeVisible()
  await expect(page.getByText('No run reports')).toHaveCount(0)
  const list = page.getByRole('list', { name: 'Run reports' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(status(page, 'Loading run reports…')).toHaveCount(0)

  await page.getByRole('combobox', { name: 'Agent' }).click()
  await page.getByRole('option', { name: 'hunt', exact: true }).click()
  // The rows stay, dimmed, until the filtered ones arrive: no placeholder, no blank.
  await expect(list).toHaveAttribute('aria-busy', 'true')
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(status(page, 'Loading run reports…')).toHaveCount(0)
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).not.toHaveAttribute('aria-busy', 'true')
})

test('Run reports: a fast load and a fast filter draw no placeholder', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Reported work' })
  await writeReport(agent, project.id, t.id, 'hunt')
  await writeReport(agent, project.id, t.id, 'verify')
  const watch = await watchLoading(page)
  await page.goto(`/projects/${project.id}/run-reports`)
  const list = page.getByRole('list', { name: 'Run reports' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('combobox', { name: 'Agent' }).click()
  await page.getByRole('option', { name: 'hunt', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  expect(await watch.seen()).toEqual([])
})

test('Gallery: slow tiles are labeled, a filter dims the tiles, and a text file shows a delayed placeholder', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Files of the parser' })
  const image = await upload(agent, 'shot.png', png(16))
  const text = await upload(agent, 'notes.txt', Buffer.from('The parser is fixed.'))
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: 'Files.', attachmentIds: [image.id, text.id] },
    }),
  )
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/gallery`))
  await page.goto(`/projects/${project.id}/gallery`)

  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible()
  await expect(status(page, 'Loading files…')).toBeVisible()
  await expect(page.getByText('No files on this project yet.')).toHaveCount(0)
  const tiles = page.locator('li[data-file]')
  await expect(tiles).toHaveCount(2)
  await expect(status(page, 'Loading files…')).toHaveCount(0)

  await page.getByRole('group', { name: 'File type' }).getByRole('button', { name: 'Images' }).click()
  await expect(page.locator('[aria-busy=true] li[data-file]')).toHaveCount(2)
  await expect(status(page, 'Loading files…')).toHaveCount(0)
  await expect(tiles).toHaveCount(1)

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(tiles).toHaveCount(2)
  await delayApi(page, /^\/api\/uploads\/\d+$/)
  await tiles.filter({ hasText: 'notes.txt' }).getByRole('link', { name: 'Open notes.txt' }).click()
  const dialog = page.getByRole('dialog')
  await expect(status(dialog, 'Loading file…')).toBeVisible()
  await expect(dialog.getByText('The parser is fixed.')).toBeVisible()
  await expect(status(dialog, 'Loading file…')).toHaveCount(0)
})

test('Gallery: a fast load draws no placeholder', async ({ page, project, api, agent }) => {
  const t = await api.ticket({ title: 'Files of the parser' })
  const image = await upload(agent, 'shot.png', png(16))
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Files.', attachmentIds: [image.id] } }),
  )
  const watch = await watchLoading(page)
  await page.goto(`/projects/${project.id}/gallery`)
  await expect(page.locator('li[data-file]')).toHaveCount(1)
  expect(await watch.seen()).toEqual([])
})

test('Previews: a slow load is labeled, and a refresh that keeps the rows shows no spinner at once', async ({
  page,
  project,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Previewed work', status: 'in_progress' })
  await ok(
    human.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'wt', branch: 'feat/p', previewUrl: 'https://example.com/p' },
    }),
  )
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/previews`))
  await page.goto(`/projects/${project.id}/previews?stage=_all`)

  await expect(page.getByRole('heading', { name: 'Previews' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(status(page, 'Loading previews…')).toBeVisible()
  await expect(page.getByText('No previews yet')).toHaveCount(0)
  const rows = page.getByRole('region', { name: /^(Running|Not running)$/ }).getByRole('listitem')
  await expect(rows).toHaveCount(1)
  await expect(status(page, 'Loading previews…')).toHaveCount(0)

  // A refresh keeps the rows; its spinner comes only once the fetch has been slow.
  const spinner = page.getByRole('button', { name: 'Refresh' }).locator('svg')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(spinner).not.toHaveClass(/animate-spin/)
  await expect(spinner).toHaveClass(/animate-spin/)
  await expect(rows).toHaveCount(1)
  await expect(spinner).not.toHaveClass(/animate-spin/)
})

test('Previews: a quick refresh that keeps the rows shows no spinner and no placeholder', async ({
  page,
  project,
}) => {
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/previews`), 100)
  const spinner = page.getByRole('button', { name: 'Refresh' }).locator('svg')

  await page.goto(`/projects/${project.id}/previews?stage=_all`)
  await expect(page.getByText('No previews yet')).toBeVisible()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(spinner).not.toHaveClass(/animate-spin/)
  await expect(status(page, 'Loading previews…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
})

test('Cleanup: a slow load shows a labeled placeholder under its heading', async ({ page, project }) => {
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/cleanup`))
  await page.goto(`/projects/${project.id}/cleanup`)

  await expect(page.getByRole('heading', { name: 'Cleanup' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(status(page, 'Loading cleanup…')).toBeVisible()
  await expect(page.getByText('Nothing left behind')).toHaveCount(0)
  await expect(status(page, 'Loading cleanup…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
})

test('Repositories and Notes: slow data shows a labeled placeholder, not an empty state', async ({
  page,
  project,
}) => {
  await delayApi(page, new RegExp(`^/api/projects/${project.id}$`))
  await page.goto(`/projects/${project.id}/repositories`)
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New repository' })).toBeVisible()
  await expect(status(page, 'Loading repositories…')).toBeVisible()
  await expect(page.getByText('No repositories in this project yet')).toHaveCount(0)
  await expect(page.getByText('repo', { exact: true })).toBeVisible()
  await expect(status(page, 'Loading repositories…')).toHaveCount(0)

  await delayApi(page, new RegExp(`^/api/projects/${project.id}/notes`))
  await page.goto(`/projects/${project.id}`)
  await expect(status(page, 'Loading notes…')).toBeVisible()
  await expect(page.getByText('A note is one short fact')).toHaveCount(0)
  await expect(page.getByText('pnpm release 0.2.5')).toBeVisible()
  await expect(status(page, 'Loading notes…')).toHaveCount(0)
})

test('Roadmap: counts read as a dash, not 0, until the tickets are there', async ({ page, project, api }) => {
  await api.ticket({ title: 'One ticket', status: 'in_progress' })
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/roadmap`))
  await page.goto(`/projects/${project.id}/roadmap`)

  await expect(page.getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  const stats = page.locator('b.tabular-nums')
  await expect(stats.first()).toHaveText('–')
  await expect(page.getByText(/^All\s*–$/)).toBeVisible()
  await expect(stats.filter({ hasText: /^0$/ })).toHaveCount(0)

  await expect(page.getByTestId('roadmap')).toBeVisible()
  await expect(stats.first()).toHaveText('1')
  await expect(stats.filter({ hasText: '–' })).toHaveCount(0)
})

test('Run reports and Gallery: an empty result kept for a new filter is not its empty state', async ({
  page,
  project,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Reported work' })
  await writeReport(agent, project.id, t.id, 'hunt')
  await page.goto(`/projects/${project.id}/run-reports?agent=nobody`)
  await expect(page.getByText('No run reports for that filter.')).toBeVisible()
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/run-reports`))
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(status(page, 'Loading run reports…')).toBeVisible()
  await expect(page.getByText('No run reports')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Run reports' }).getByRole('listitem')).toHaveCount(1)

  const image = await upload(agent, 'shot.png', png(16))
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Files.', attachmentIds: [image.id] } }),
  )
  await page.goto(`/projects/${project.id}/gallery?type=video`)
  await expect(page.getByText('No files match these filters.')).toBeVisible()
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/gallery`))
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(status(page, 'Loading files…')).toBeVisible()
  await expect(page.getByText('No files match these filters.')).toHaveCount(0)
  await expect(page.locator('li[data-file]')).toHaveCount(1)
})
