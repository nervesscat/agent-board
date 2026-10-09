import type { Handoff, TicketFull } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

const ALL = ['tasks_open', 'no_pr', 'not_pushed', 'no_preview', 'no_handoff_post']

test('a ticket moved to review lists what its hand-off lacks, and ticks each item once it is there', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A branch with a commit of its own, not pushed yet.
  const branch = `e2e-${project.id}-handoff`
  git('branch', branch, commitFile('main', 'handoff.txt', 'work\n', 'work'))
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Hand it off', status: 'in_progress', branch },
    }),
  )
  const read = () => ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  const missing = async () => (await read()).handoff?.missing.map((m) => m.code)
  // The board reads the checkout's refs a few seconds at a time: wait until it sees the branch.
  await expect.poll(async () => (await read()).push.state).toBe('local-only')

  // Not in review: no card.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hand it off')
  const card = page.getByRole('region', { name: 'Hand-off' })
  await expect(card).toHaveCount(0)

  // The human moves it to review on its page: it goes, with a warning of what the hand-off lacks.
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'In review', exact: true }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'the hand-off lacks' })).toBeVisible()
  await expect(page.getByRole('combobox').filter({ hasText: 'In review' })).toBeVisible()
  await expect(card).toContainText('5 missing')
  const item = (code: string) => card.locator(`[data-code="${code}"]`)
  for (const code of ALL) await expect(item(code)).toHaveAttribute('data-ok', 'false')
  await expect(item('not_pushed')).toContainText('Branch not on origin')
  // Implementation, first: the ticket has no tasks yet.
  await expect(card.locator('[data-code]').first()).toHaveAttribute('data-code', 'tasks_open')
  await expect(item('tasks_open')).toContainText('Implementation')
  await expect(item('tasks_open')).toContainText('No tasks')
  await card.screenshot({ path: test.info().outputPath('handoff-missing.png') })

  // An agent moving it there hears the same, by code.
  const moved = await ok<TicketFull & { handoff: Handoff }>(
    agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }),
  )
  expect(moved.status).toBe('review')
  expect(moved.handoff.missing.map((m) => m.code)).toEqual(ALL)

  // The agent pushes, links its PR and registers a preview that answers (this very board). The
  // human's question is not a hand-off post.
  git('push', '-q', 'origin', branch)
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { prNumber: 4242 } }))
  await ok(
    agent.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'worktree', branch, previewUrl: e2eEnv().baseURL },
    }),
  )
  await ok(human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'How do I try it?' } }))
  await expect.poll(missing).toEqual(['tasks_open', 'no_handoff_post'])

  // The implementation's steps, all ticked: one tick on a step ticks its parts.
  const [step] = await ok<{ id: number }[]>(
    agent.post(`/api/tickets/${t.id}/tasks`, {
      data: { tasks: [{ text: 'Build', subtasks: ['Code', 'Test'] }] },
    }),
  )
  await expect.poll(async () => (await read()).handoff?.missing[0]?.text).toBe('0 of 3 tasks done')
  await ok(agent.patch(`/api/tasks/${step!.id}`, { data: { done: true } }))
  await expect.poll(missing).toEqual(['no_handoff_post'])

  // Then the hand-off post: nothing is missing.
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: `PR #4242. Preview: ${e2eEnv().baseURL}, try the Hand-off card.` },
    }),
  )
  await expect.poll(missing).toEqual([])

  await page.reload()
  await expect(card).toContainText('complete')
  for (const code of ALL) await expect(item(code)).toHaveAttribute('data-ok', 'true')
  await expect(item('tasks_open')).toContainText('3 of 3 tasks done')
  await expect(item('no_pr')).toContainText('PR #4242')
  await expect(item('not_pushed')).toContainText('Branch pushed')
  await expect(item('no_preview')).toContainText(`Running at ${e2eEnv().baseURL}`)
  await expect(item('no_handoff_post')).toContainText('Posted by claude after the last commit')
  await card.screenshot({ path: test.info().outputPath('handoff-card.png') })
})
