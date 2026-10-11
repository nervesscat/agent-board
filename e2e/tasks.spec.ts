import type { TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

test('tasks nest one level: subtasks under their task, counted with it, ticked in step', async ({
  page,
  project,
  human,
}) => {
  // A step with two parts, one of them done, and a plain step.
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Nested plan', tasks: [{ text: 'a', subtasks: ['a1', 'a2'] }, 'b'] },
    }),
  )
  const read = () => ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  const a1 = (await read()).tasks.find((x) => x.text === 'a1')!
  await ok(human.patch(`/api/tasks/${a1.id}`, { data: { done: true } }))

  // The board card counts tasks and subtasks.
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByRole('link', { name: /Nested plan/ })).toContainText('1/4')

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Tasks' })
  const box = (name: string) => card.getByRole('checkbox', { name, exact: true })
  await expect(card).toContainText('1/4 · 25%')
  const subtasksOf = (name: string) => card.getByRole('list', { name: `Subtasks of ${name}` })
  await expect(subtasksOf('a').getByRole('listitem')).toHaveText(['a1', 'a2'])
  await expect(box('a1')).toBeChecked()
  await expect(box('a')).not.toBeChecked()
  // Only a top-level task takes subtasks.
  await expect(card.getByRole('button', { name: 'Add a subtask to a', exact: true })).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Add a subtask to a1' })).toHaveCount(0)

  // A subtask added from the page goes under its task, with parentTaskId.
  await card.getByRole('button', { name: 'Add a subtask to b' }).click()
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/tickets/${t.id}/tasks`),
  )
  await card.getByRole('textbox', { name: 'New subtask of b' }).fill('b1')
  await card.getByRole('textbox', { name: 'New subtask of b' }).press('Enter')
  const b = (await read()).tasks.find((x) => x.text === 'b')!
  expect((await sent).postDataJSON()).toEqual({ tasks: ['b1'], parentTaskId: b.id })
  await expect(subtasksOf('b').getByRole('listitem')).toHaveText(['b1'])
  await expect(card).toContainText('1/5 · 20%')
  await card.screenshot({ path: test.info().outputPath('tasks-nested.png') })

  // Ticking a task ticks its subtasks.
  await box('a').click()
  for (const name of ['a', 'a1', 'a2']) await expect(box(name)).toBeChecked()
  await expect(card).toContainText('3/5 · 60%')
  // Ticking the last open subtask ticks its task.
  await box('b1').click()
  await expect(box('b')).toBeChecked()
  await expect(card).toContainText('5/5 · 100%')
  // Unticking a subtask unticks its task.
  await box('a2').click()
  await expect(box('a')).not.toBeChecked()
  await expect(box('a1')).toBeChecked()
  await expect(card).toContainText('3/5 · 60%')

  // Removing a task removes its subtasks.
  await card.getByRole('button', { name: 'Remove a', exact: true }).click()
  await expect(box('a')).toHaveCount(0)
  await expect(box('a1')).toHaveCount(0)
  await expect(card).toContainText('2/2 · 100%')
  expect((await read()).tasks.map((x) => [x.text, x.parentId])).toEqual([
    ['b', null],
    ['b1', b.id],
  ])

  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByRole('link', { name: /Nested plan/ })).toContainText('2/2')
})

test('the Tasks card tells the human the top level holds high-level phases, in every stage', async ({
  page,
  project,
  human,
}) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Plan in phases' } }),
  )
  // No phases are made for it: the plan is the agent's.
  const created = await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  expect(created.tasks).toEqual([])
  expect(created.progress).toEqual({ done: 0, total: 0 })

  const hint = 'No tasks yet. Plan a few high-level phases, like the hand-off (plan, code, tests…)'
  for (const status of ['todo', 'in_progress', 'review', 'done']) {
    await ok(human.patch(`/api/tickets/${t.id}`, { data: { status } }))
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const card = page.getByRole('region', { name: 'Tasks' })
    await expect(card).toContainText(hint)
    await expect(card).toContainText('the concrete steps under each as subtasks')
    await expect(card.getByRole('textbox', { name: 'Add a phase: plan, code, tests…' })).toBeVisible()
  }

  // The field still adds a top-level task, and the empty state goes once there is one.
  const card = page.getByRole('region', { name: 'Tasks' })
  await card.screenshot({ path: test.info().outputPath('tasks-empty.png') })
  const field = card.getByRole('textbox', { name: 'Add a phase: plan, code, tests…' })
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/tickets/${t.id}/tasks`),
  )
  await field.fill('Code')
  await field.press('Enter')
  expect((await sent).postDataJSON()).toEqual({ tasks: ['Code'] })
  await expect(card.getByRole('checkbox', { name: 'Code', exact: true })).toBeVisible()
  await expect(field).toHaveValue('')
  await expect(card).not.toContainText('No tasks yet')
  // The subtask field keeps its own label.
  await card.getByRole('button', { name: 'Add a subtask to Code' }).click()
  await expect(card.getByRole('textbox', { name: 'New subtask of Code' })).toHaveAttribute(
    'placeholder',
    'Add a subtask',
  )
  const read = await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  expect(read.tasks.map((x) => [x.text, x.parentId])).toEqual([['Code', null]])
})
