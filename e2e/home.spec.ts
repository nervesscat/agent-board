import type { Locator } from '@playwright/test'

import { startedAt, yesterdayNoon } from './db'
import { expect, ok, section, seedProject, test } from './fixtures'

test('Home and Overview sum up the work: what needs you, in progress, done today, next, carrying over', async ({
  page,
  project,
  api,
  human,
  agent,
}) => {
  const next = await api.ticket({ title: 'Next up', status: 'todo' })
  const today = await api.ticket({ title: 'Started today', status: 'in_progress' })
  const yesterday = await api.ticket({ title: 'Started yesterday', status: 'in_progress' })
  startedAt(yesterday.id, yesterdayNoon())
  const review = await api.ticket({ title: 'Ready for a look', status: 'review' })
  const shipped = await api.ticket({ title: 'Shipped', status: 'todo' })
  await ok(human.patch(`/api/tickets/${shipped.id}`, { data: { status: 'done' } }))
  const asking = await api.ticket({ title: 'Pick a storage', status: 'in_progress' })
  await ok(
    agent.post(`/api/tickets/${asking.id}/decisions`, {
      data: { body: 'Where should uploads live?', options: [{ label: 'Disk' }, { label: 'MinIO' }] },
    }),
  )
  // An agent asks the human something on a ticket the human wrote.
  await ok(
    agent.post('/api/comments', {
      data: { parentType: 'ticket', parentId: next.id, body: 'Should the parser keep comments?' },
    }),
  )
  // Another project's work, which this project's Overview leaves out.
  const other = await seedProject(human, `Second project ${project.id}`)
  await ok(
    human.post(`/api/projects/${other.id}/tickets`, { data: { title: 'Elsewhere', status: 'in_progress' } }),
  )

  const link = (scope: Locator, t: { id: number; title: string }) =>
    scope.getByRole('link', { name: `#${t.id} ${t.title}` })

  await page.goto(`/projects/${project.id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()

  const needsYou = section(page, 'Needs you')
  await expect(needsYou.getByRole('link', { name: 'Decide: Where should uploads live?' })).toBeVisible()
  await expect(needsYou).toContainText(`#${asking.id} Pick a storage`)
  await expect(link(needsYou, review)).toBeVisible()
  await expect(needsYou).toContainText('In review')
  const thread = needsYou.getByRole('listitem').filter({ hasText: 'Should the parser keep comments?' })
  await expect(thread.getByRole('link', { name: `#${next.id} Next up` })).toBeVisible()
  await expect(thread).toContainText('claude: Should the parser keep comments?')
  await expect(needsYou.locator('[data-slot="card-title"]')).toContainText('3')

  const inProgress = section(page, 'In progress')
  await expect(link(inProgress, today)).toBeVisible()
  await expect(link(inProgress, yesterday)).toBeVisible()
  // Blocked on its decision, it is still in progress, marked as blocked.
  await expect(link(inProgress, asking)).toBeVisible()
  await expect(inProgress.getByRole('listitem').filter({ hasText: 'Pick a storage' })).toContainText(
    'Blocked',
  )
  // In review waits on the human: it is under Needs you, not here.
  await expect(link(inProgress, review)).toHaveCount(0)
  await expect(link(inProgress, next)).toHaveCount(0)

  const doneToday = section(page, 'Done today')
  await expect(link(doneToday, shipped)).toBeVisible()
  await expect(link(doneToday, today)).toHaveCount(0)

  const nextUp = section(page, 'Next: To do')
  await expect(link(nextUp, next)).toBeVisible()
  await expect(link(nextUp, shipped)).toHaveCount(0)
  await expect(nextUp).toContainText('1 blocked')

  // Only what was already in progress before today carries over.
  const carrying = section(page, 'Carrying over')
  await expect(link(carrying, yesterday)).toBeVisible()
  await expect(link(carrying, today)).toHaveCount(0)
  const carried = carrying.getByRole('listitem').filter({ hasText: 'Started yesterday' })
  await expect(carried).toContainText('1 day in progress')
  await expect(carried.getByRole('link', { name: 'no handoff' })).toBeVisible()
  await expect(carrying.locator('[data-slot="card-title"]')).toContainText('1 without a handoff')

  // Once the human answers, it no longer waits on them.
  await ok(human.post('/api/comments', { data: { parentType: 'ticket', parentId: next.id, body: 'Yes.' } }))
  await page.reload()
  await expect(needsYou.getByRole('link', { name: 'Decide: Where should uploads live?' })).toBeVisible()
  await expect(thread).toHaveCount(0)

  // The Overview is this project's alone.
  await expect(page.getByText('Elsewhere')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0)

  // The project menu starts with Overview, the page this is.
  const menu = page.locator('aside nav').getByRole('link')
  await expect(menu.first()).toHaveText('Overview')
  await expect(menu.first()).toHaveAttribute('href', `/projects/${project.id}`)
  await expect(menu.first()).toHaveClass(/(^|\s)active(\s|$)/)

  // Switching projects from the Overview stays on the Overview.
  await page.getByRole('button', { name: 'Project' }).click()
  await page.getByRole('button', { name: other.name }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${other.id}$`))
  await expect(section(page, 'In progress').getByRole('link', { name: /Elsewhere/ })).toBeVisible()

  // Home: every project, one block each, its name linking to its Overview.
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
  const block = (name: string) =>
    page.getByRole('heading', { level: 2, name, exact: true }).locator('xpath=ancestor::section[1]')
  const mine = block(project.name)
  await expect(link(section(mine, 'In progress'), yesterday)).toBeVisible()
  await expect(link(section(mine, 'Done today'), shipped)).toBeVisible()
  await expect(mine).toContainText('2 waiting on you · 3 in progress · 1 done today')
  await expect(mine.getByText('Elsewhere')).toHaveCount(0)
  await expect(
    section(block(other.name), 'In progress').getByRole('link', { name: /Elsewhere/ }),
  ).toBeVisible()
  await mine.getByRole('link', { name: project.name }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))

  // The project's repositories have a page in its menu.
  await page.locator('aside nav').getByRole('link', { name: 'Repositories' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/repositories$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible()
  const repo = page.getByRole('button').filter({ hasText: project.repos[0]!.repoPath })
  await expect(repo).toBeVisible()
  await expect(repo).toContainText(project.repos[0]!.repoPath)
})
