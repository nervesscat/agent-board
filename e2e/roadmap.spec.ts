import type { TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('the Roadmap shows tickets being worked with their lanes as timelines, and filters them', async ({
  page,
  project,
  human,
  agent,
}) => {
  const create = (data: Record<string, unknown>) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { defaultPhases: false, ...data } }),
    )
  const worked = await create({
    title: 'Ship the importer',
    status: 'in_progress',
    tasks: [{ text: 'Implementation', subtasks: ['Parse', 'Store'] }, 'Pushed'],
  })
  const lane = await create({ title: 'Importer docs', parentId: worked.id, tasks: ['Write', 'Proofread'] })
  await create({ title: 'Not started yet', status: 'todo', tasks: ['Plan'] })
  const read = (id: number) => ok<TicketFull>(human.get(`/api/tickets/${id}`))
  const task = async (id: number, text: string) => (await read(id)).tasks.find((t) => t.text === text)!
  await ok(agent.patch(`/api/tasks/${(await task(worked.id, 'Parse')).id}`, { data: { done: true } }))
  await ok(
    agent.patch(`/api/tasks/${(await task(lane.id, 'Write')).id}`, {
      data: { blocked: true, blockedReason: 'Pick the docs host' },
    }),
  )

  await page.goto(`/projects/${project.id}/roadmap`)
  await expect(page.getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  const roadmap = page.getByTestId('roadmap')
  // Only the ticket being worked shows, with its lane under it; the one still to do does not.
  const ticket = roadmap.getByRole('region', { name: `#${worked.id} Ship the importer` })
  await expect(ticket).toBeVisible()
  await expect(roadmap).not.toContainText('Not started yet')
  await expect(ticket).toContainText('Importer docs')
  // The ticket's timeline: Parse done, Store now, Pushed later; the lane's first task blocked.
  await expect(ticket.locator('li[data-state="done"]', { hasText: 'Parse' })).toBeVisible()
  await expect(ticket.locator('li[data-state="now"]', { hasText: 'Store' })).toBeVisible()
  await expect(ticket.locator('li[data-state="blocked"]', { hasText: 'Write' })).toContainText(
    'Pick the docs host',
  )
  // Folding the lanes hides them.
  await ticket.getByRole('button', { name: '1 lane' }).click()
  await expect(ticket).not.toContainText('Importer docs')

  // The blocked filter keeps it (its lane is blocked); the review filter has nothing.
  await page.getByRole('tab', { name: /Blocked/ }).click()
  await expect(page).toHaveURL(/show=blocked/)
  await expect(roadmap.getByRole('region', { name: `#${worked.id} Ship the importer` })).toBeVisible()
  await page.getByRole('tab', { name: /Needs review/ }).click()
  await expect(page.getByText('No ticket is waiting for review.')).toBeVisible()
})

test('the Roadmap picks its time axis in the URL, which survives a reload', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/roadmap`)
  await expect(page.getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  // The legend's own label, so its task states read apart from the rest of the page.
  await expect(page.getByLabel('Legend').getByText('Tasks', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '7 d' })).not.toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: '7 d' }).click()
  await expect(page).toHaveURL(/[?&]window=7d(&|$)/)
  await page.reload()
  await expect(page).toHaveURL(/[?&]window=7d(&|$)/)
  await expect(page.getByRole('tab', { name: '7 d' })).toHaveAttribute('aria-selected', 'true')

  // An unknown value is the default: the page still loads, with no time axis picked.
  await page.goto(`/projects/${project.id}/roadmap?window=30d`)
  await expect(page.getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^(Today|24 h|7 d|Fit all rows)$/ }).first()).toBeVisible()
  for (const name of ['Today', '24 h', '7 d', 'Fit all rows'])
    await expect(page.getByRole('tab', { name })).not.toHaveAttribute('aria-selected', 'true')
})
