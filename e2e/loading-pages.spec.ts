import { localDate } from '#/lib/format'
import { expect, ok, test } from './fixtures'
import { delayApi, watchLoading } from './loading'

const status = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('status', { name, exact: true })

test('the Team page draws its heading at once, then the agents replace the placeholder', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'loader', instructions: 'Loads.', delegation: '', reportTemplate: '' },
    }),
  )
  await delayApi(page, new RegExp(`^/api/projects/${project.id}$`))
  await page.goto(`/projects/${project.id}/agents`)

  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible()
  await expect(status(page, 'Loading agents…')).toBeVisible()
  await expect(page.getByText('No agents yet')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Remove loader' })).toBeVisible()
  await expect(status(page, 'Loading agents…')).toHaveCount(0)
})

test('the Team page does not say no ticket is reserved before the tickets are known', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'loader', instructions: 'Loads.', delegation: '', reportTemplate: '' },
    }),
  )
  await delayApi(page, new RegExp(`^/api/projects/${project.id}/tickets`))
  await page.goto(`/projects/${project.id}/agents`)

  await expect(page.getByRole('button', { name: 'Remove loader' })).toBeVisible()
  await expect(page.getByText('no tickets reserved for it')).toHaveCount(0)
  await expect(page.getByText('no tickets reserved for it')).toBeVisible()
})

test('a fast load of the Team page and of a ticket opened by a link draws no placeholder', async ({
  page,
  project,
  api,
}) => {
  const ticket = await api.ticket({ title: 'Fast ticket' })
  const watch = await watchLoading(page)

  await page.goto(`/projects/${project.id}/agents`)
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible()
  await expect(page.getByText('No agents yet')).toBeVisible()
  expect(await watch.seen()).toEqual([])

  await page.goto(`/projects/${project.id}/features/${ticket.id}`)
  await expect(page.getByRole('heading', { name: /Fast ticket/ })).toBeVisible()
  // The ticket itself answers at once, so its page skeleton never shows. Parts that load on their own
  // (the work timeline, the runs) may legitimately pass 150 ms on a loaded machine and show theirs.
  expect((await watch.seen()).filter((n) => n === 'Loading ticket…')).toEqual([])
})

test('a ticket opened by a link shows a skeleton, then the ticket', async ({ page, project, api }) => {
  const ticket = await api.ticket({ title: 'Cold link ticket' })
  await delayApi(page, new RegExp(`^/api/tickets/${ticket.id}$`))
  await page.goto(`/projects/${project.id}/features/${ticket.id}`)

  await expect(status(page, 'Loading ticket…')).toBeVisible()
  await expect(page.getByText('Cold link ticket')).toHaveCount(0)

  await expect(page.getByRole('heading', { name: /Cold link ticket/ })).toBeVisible()
  await expect(status(page, 'Loading ticket…')).toHaveCount(0)
})

test('an unknown ticket opened by a link shows its error, not a skeleton for good', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features/99999999`)
  await expect(page.getByText(/not found/i)).toBeVisible()
  await expect(status(page, 'Loading ticket…')).toHaveCount(0)
})

test('the Instructions page draws its heading at once, and its history says nothing until it is read', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.put(`/api/projects/${project.id}/instructions`, { data: { instructions: 'Run the checks.' } }),
  )
  await delayApi(page, new RegExp(`^/api/projects/${project.id}(/instructions/changes)?$`))
  await page.goto(`/projects/${project.id}/instructions`)

  await expect(page.getByRole('heading', { name: 'Instructions', exact: true })).toBeVisible()
  await expect(status(page, 'Loading instructions…')).toBeVisible()
  await expect(page.getByText('No instructions yet')).toHaveCount(0)
  await expect(status(page, 'Loading instructions history…')).toBeVisible()
  await expect(page.getByText('No changes yet.')).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'Run the checks.' })).toBeVisible()
  await expect(status(page, 'Loading instructions…')).toHaveCount(0)
  await expect(page.getByRole('listitem', { name: /^Change by/ })).toBeVisible()
  await expect(status(page, 'Loading instructions history…')).toHaveCount(0)
})

test('the Daily page draws its heading at once, and each card its own placeholder', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { cadence: 'daily', shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )
  await ok(
    human.post(`/api/projects/${project.id}/reports`, { data: { period: localDate(), body: 'Shipped it.' } }),
  )
  await delayApi(page, /^\/api\/(daily|projects\/\d+\/(report-settings|reports|pushed-today))/)
  await page.goto(`/projects/${project.id}/daily`)

  await expect(page.getByRole('heading', { name: 'Daily', exact: true })).toBeVisible()
  await expect(status(page, 'Loading report…').first()).toBeVisible()
  await expect(status(page, 'Loading activity…')).toBeVisible()
  await expect(status(page, 'Loading calendar…')).toBeVisible()
  await expect(page.getByText(/^Nothing happened on/)).toHaveCount(0)
  await expect(page.getByText('Nothing pushed today')).toHaveCount(0)
  await expect(page.getByText(/No report is asked for|No report for/)).toHaveCount(0)

  const card = page.getByRole('region', { name: 'Report', exact: true })
  await expect(card).toContainText('Shipped it.')
  await expect(status(page, 'Loading report…')).toHaveCount(0)
  await expect(status(page, 'Loading activity…')).toHaveCount(0)
})

test('going to another day keeps the day on show, dimmed, until the new one arrives', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { cadence: 'daily', shiftStart: '00:00', shiftEnd: '23:59', workdays: [1, 2, 3, 4, 5, 6, 7] },
    }),
  )
  await ok(
    human.post(`/api/projects/${project.id}/reports`, { data: { period: localDate(), body: 'Shipped it.' } }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  const card = page.getByRole('region', { name: 'Report', exact: true })
  await expect(card).toContainText('Shipped it.')

  await delayApi(page, /^\/api\/(daily|projects\/\d+\/reports\?)/)
  await page.getByRole('button', { name: 'Previous day' }).click()

  await expect(card).toHaveAttribute('aria-busy', 'true')
  await expect(card).toContainText('Shipped it.')
  await expect(status(page, 'Loading report…')).toHaveCount(0)

  await expect(card).not.toHaveAttribute('aria-busy', 'true')
  await expect(card).not.toContainText('Shipped it.')
})
