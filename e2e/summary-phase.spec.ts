import { execFileSync } from 'node:child_process'

import type { Locator, Page } from '@playwright/test'

import type { TicketFull } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, expectTooltip, ok, test } from './fixtures'

type Open = { taskId: number; ticketId: number; text: string; auto: boolean }[]

/**
 * A commit on top of `parent` dated a minute from now, so it reads as newer than any post the test
 * writes (git keeps whole seconds); answers its sha.
 */
function laterCommit(parent: string, file: string) {
  const at = new Date(Date.now() + 60_000).toISOString()
  const sha = commitFile(parent, file, `${file}\n`, file)
  // The same tree and parent, committed again with the later date.
  const tree = git('rev-parse', `${sha}^{tree}`).trim()
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=e2e',
      '-c',
      'user.email=e2e@example.com',
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      file,
    ],
    {
      cwd: e2eEnv().repoPath,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    },
  ).trim()
}

/** The Tasks card's top-level row of a phase. */
const phaseRow = (card: Locator, name: string) =>
  card.locator('> ul > li > div').filter({ has: card.page().getByRole('checkbox', { name, exact: true }) })

const noHandoffToast = (page: Page) =>
  expect(page.locator('[data-sonner-toast]').filter({ hasText: /hand-off/i })).toHaveCount(0)

test('a ticket moved to review has no Hand-off card; the board ticks Summary from the summary and the last commit', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A branch with a commit of its own.
  const branch = `e2e-${project.id}-summary`
  const work = commitFile('main', 'summary.txt', 'work\n', 'work')
  git('branch', branch, work)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Summed up', status: 'in_progress', branch, tasks: ['Build it'] },
    }),
  )
  const read = () => ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  const summaryDone = async () => (await read()).tasks.find((x) => x.text === 'Summary')!.done

  // The human moves it to review on its page: it goes, with no warning, and no Hand-off card shows.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Summed up')
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'In review', exact: true }).click()
  await expect(page.getByRole('combobox').filter({ hasText: 'In review' })).toBeVisible()
  await expect.poll(async () => (await read()).status).toBe('review')
  await noHandoffToast(page)
  await expect(page.getByRole('region', { name: 'Hand-off' })).toHaveCount(0)
  const card = page.getByRole('region', { name: 'Tasks' })
  await expect(card).toHaveAttribute('id', 'tasks')
  await page.screenshot({
    path: test.info().outputPath('ticket-in-review-no-handoff-card.png'),
    fullPage: true,
  })

  // An agent moving it there hears what is still open, from the tasks; Merged is the human's.
  const moved = await ok<TicketFull & { open: Open }>(
    agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }),
  )
  expect(moved.status).toBe('review')
  expect(moved).not.toHaveProperty('handoff')
  expect(moved.open.map((x) => [x.text, x.auto])).toEqual([
    ['Implementation', false],
    ['Build it', false],
    ['Pushed', true],
    ['PR', true],
    ['CI', true],
    ['Preview', true],
    ['Summary', true],
  ])
  expect((await read()).open).toEqual(moved.open)

  // Summary is a phase the board ticks: its box is off, with the rule in its tooltip.
  const summary = phaseRow(card, 'Summary')
  const box = summary.getByRole('checkbox', { name: 'Summary', exact: true })
  await expect(box).toBeDisabled()
  await expect(box).not.toBeChecked()
  await expectTooltip(
    summary.getByLabel('Ticked automatically'),
    "Ticked by the board from the ticket's posts (an agent wrote or updated its summary after the branch's last commit)",
  )

  // The agent writes the summary: the board ticks Summary, and it leaves the open list.
  await ok(agent.put(`/api/tickets/${t.id}/summary`, { data: { body: 'What it does, and how to try it.' } }))
  await expect.poll(summaryDone).toBe(true)
  expect((await read()).open!.map((x) => x.text)).not.toContain('Summary')
  await page.reload()
  await expect(box).toBeChecked()
  await expect(box).toBeDisabled()
  await card.screenshot({ path: test.info().outputPath('tasks-card-summary-phase.png') })

  // A new commit on the branch: the summary is behind the work, so the board unticks it.
  git('update-ref', `refs/heads/${branch}`, laterCommit(work, 'more.txt'))
  await expect.poll(summaryDone).toBe(false)
  await page.reload()
  await expect(box).not.toBeChecked()
  expect((await read()).open!.map((x) => x.text)).toContain('Summary')
})

test('dragging a ticket to In review on the board moves it with no hand-off warning', async ({
  page,
  project,
  api,
}) => {
  const t = await api.ticket({ title: 'Dragged to review', status: 'in_progress' })
  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Dragged to review/ })
  await expect(card).toBeVisible()
  // The drag events a browser sends, with one DataTransfer.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const column = page.locator('[data-column="review"]')
  await card.dispatchEvent('dragstart', { dataTransfer })
  await column.dispatchEvent('dragenter', { dataTransfer })
  await column.dispatchEvent('dragover', { dataTransfer })
  await column.dispatchEvent('drop', { dataTransfer })
  await card.dispatchEvent('dragend', { dataTransfer })
  await expect(column.getByRole('link', { name: /Dragged to review/ })).toBeVisible()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('review')
  await noHandoffToast(page)
})
