import type { TicketFull } from '#/lib/api'
import { expect, ok, section, test } from './fixtures'

test('a task can be tagged blocked on the human: chip, reason and its parent on the Tasks card', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: {
        title: 'Take payments',
        status: 'in_progress',
        tasks: [{ text: 'Setup', subtasks: ['Get the API key', 'Wire it'] }, 'Deploy'],
        defaultPhases: false,
      },
    }),
  )
  const read = () => ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  const task = async (text: string) => (await read()).tasks.find((x) => x.text === text)!
  // An agent tags a subtask over REST, with what the human must do.
  const key = await task('Get the API key')
  const tagged = await ok<TicketFull['tasks'][number]>(
    agent.patch(`/api/tasks/${key.id}`, {
      data: { blocked: true, blockedReason: 'Create a restricted key in the Stripe dashboard' },
    }),
  )
  expect(tagged).toMatchObject({
    blocked: true,
    blockedReason: 'Create a restricted key in the Stripe dashboard',
  })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Tasks' })
  const row = async (text: string) => card.locator(`#task-${(await task(text)).id}`)
  const keyRow = await row('Get the API key')
  const setupRow = await row('Setup')
  const deployRow = await row('Deploy')
  // The tag and its reason are text on the row, not a tooltip.
  await expect(keyRow.getByText('blocked', { exact: true })).toBeVisible()
  await expect(keyRow.getByText('Create a restricted key in the Stripe dashboard')).toBeVisible()
  // Its parent shows it, untagged itself.
  await expect(setupRow).toContainText('1 subtask blocked')
  await expect(setupRow.getByText('blocked', { exact: true })).toHaveCount(0)
  await expect(deployRow).not.toContainText('blocked')
  // A blocked task still counts as open.
  await expect(card).toContainText('0/4 · 0%')

  // The human tags a task from the card, with a reason.
  await card.getByRole('button', { name: 'Mark Deploy blocked', exact: true }).click()
  const reason = card.getByRole('textbox', { name: 'Why Deploy is blocked' })
  await reason.fill('Approve the release in the store')
  let sent = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/tasks/'))
  await card.getByRole('button', { name: 'Mark blocked', exact: true }).click()
  expect((await sent).postDataJSON()).toEqual({
    blocked: true,
    blockedReason: 'Approve the release in the store',
  })
  await expect(deployRow.getByText('blocked', { exact: true })).toBeVisible()
  await expect(deployRow.getByText('Approve the release in the store')).toBeVisible()
  await expect(reason).toHaveCount(0)

  // And a subtask without one: the parent counts two.
  await card.getByRole('button', { name: 'Mark Wire it blocked', exact: true }).click()
  sent = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/tasks/'))
  await card.getByRole('textbox', { name: 'Why Wire it is blocked' }).press('Enter')
  expect((await sent).postDataJSON()).toEqual({ blocked: true })
  await expect((await row('Wire it')).getByText('blocked', { exact: true })).toBeVisible()
  await expect(setupRow).toContainText('2 subtasks blocked')
  expect((await task('Wire it')).blocked).toBe(true)
  await card.screenshot({ path: test.info().outputPath('tasks-blocked.png') })

  // Unblocking clears the tag and its reason; the parent's count follows.
  sent = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/tasks/'))
  await card.getByRole('button', { name: 'Unblock Get the API key', exact: true }).click()
  expect((await sent).postDataJSON()).toEqual({ blocked: false })
  await expect(keyRow.getByText('blocked', { exact: true })).toHaveCount(0)
  await expect(keyRow).not.toContainText('Stripe dashboard')
  await expect(setupRow).toContainText('1 subtask blocked')
  await card.getByRole('button', { name: 'Unblock Wire it', exact: true }).click()
  await expect(setupRow).not.toContainText('blocked')
  expect(await task('Get the API key')).toMatchObject({ blocked: false, blockedReason: '' })

  // Ticking a blocked task done clears its tag.
  await card.getByRole('checkbox', { name: 'Deploy', exact: true }).click()
  await expect(deployRow.getByText('blocked', { exact: true })).toHaveCount(0)
  expect(await task('Deploy')).toMatchObject({ done: true, blocked: false, blockedReason: '' })
  // The agent clears what it set, too.
  await ok(agent.patch(`/api/tasks/${key.id}`, { data: { blocked: true } }))
  await ok(agent.patch(`/api/tasks/${key.id}`, { data: { blocked: false } }))
  expect((await read()).status).toBe('in_progress')
})

test('blocked tasks show on the board card, the list, and the summary', async ({ page, project, human }) => {
  const make = (title: string, tasks: unknown[]) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title, status: 'in_progress', tasks, defaultPhases: false },
      }),
    )
  const waiting = await make('Waits on keys', [
    { text: 'Get the key', blocked: true, blockedReason: 'Paste the key in .env' },
    { text: 'Sign the app', blocked: true },
    'Write the client',
  ])
  await make('All clear', ['Just code'])
  // A lane's blocked task counts on its parent's card.
  const lane = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: {
        title: 'Waits on keys: docs',
        parentId: waiting.id,
        tasks: [{ text: 'Proofread', blocked: true }],
      },
    }),
  )
  expect((await ok<TicketFull>(human.get(`/api/tickets/${waiting.id}`))).blockedTasks).toBe(3)

  await page.goto(`/projects/${project.id}/features`)
  // The ticket's own card, not its lane's.
  const named = new RegExp(`#${waiting.id} Waits on keys(?!:)`)
  const card = page.getByRole('link', { name: named })
  await expect(card).toContainText('3 tasks blocked')
  await expect(page.getByRole('link', { name: /All clear/ })).not.toContainText('blocked')
  await card.screenshot({ path: test.info().outputPath('board-card-blocked.png') })

  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByRole('link', { name: named })).toContainText('3 tasks blocked')
  await expect(page.getByRole('link', { name: /All clear/ })).not.toContainText('blocked')

  // The summary lists each blocked task under Needs you, and counts them.
  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const entry = needsYou.getByRole('listitem').filter({ hasText: 'Get the key' })
  await expect(entry).toContainText('blocked')
  await expect(entry).toContainText('Paste the key in .env')
  const key = (await ok<TicketFull>(human.get(`/api/tickets/${waiting.id}`))).tasks[0]!
  const link = entry.getByRole('link', { name: `#${waiting.id} Waits on keys`, exact: true })
  await expect(link).toHaveAttribute('href', `/projects/${project.id}/features/${waiting.id}#task-${key.id}`)
  await expect(needsYou.getByRole('listitem').filter({ hasText: 'Sign the app' })).toBeVisible()
  const laneEntry = needsYou.getByRole('listitem').filter({ hasText: 'Proofread' })
  await expect(laneEntry).toContainText(`lane of #${waiting.id}`)
  await expect(laneEntry.getByRole('link', { name: `#${lane.id} Waits on keys: docs` })).toBeVisible()
  await expect(needsYou.locator('[data-slot="card-title"]')).toContainText('3')
  await expect(needsYou).not.toContainText('Just code')
  await needsYou.screenshot({ path: test.info().outputPath('needs-you-blocked.png') })

  // In progress carries the same badge as the card.
  const inProgress = section(page, 'In progress')
  await expect(inProgress.getByRole('listitem').filter({ hasText: 'Waits on keys' }).first()).toContainText(
    '3 tasks blocked',
  )
  await expect(inProgress.getByRole('listitem').filter({ hasText: 'All clear' })).not.toContainText('blocked')

  // On Home, the project's line counts them as waiting on the human.
  await page.goto('/')
  const block = page
    .getByRole('heading', { level: 2, name: project.name, exact: true })
    .locator('xpath=ancestor::section[1]')
  await expect(block).toContainText('3 waiting on you')

  // The link lands on the task.
  await page.goto(`/projects/${project.id}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${waiting.id}#task-${key.id}$`))
  await expect(page.locator(`#task-${key.id}`)).toBeInViewport()

  // Ticking it done takes it off Needs you.
  await ok(human.patch(`/api/tasks/${key.id}`, { data: { done: true } }))
  await page.goto(`/projects/${project.id}`)
  await expect(needsYou.getByRole('listitem').filter({ hasText: 'Get the key' })).toHaveCount(0)
  await expect(needsYou.locator('[data-slot="card-title"]')).toContainText('2')
})
