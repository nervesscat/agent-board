import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Repo, TicketFull, TicketRuns } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'
import { addRun } from './runs'

/*
 * A ticket whose work spans two repos of its project, two scratch repos of their own: a branch in
 * each, both in the Branch panel and the Runs card, and a repo taken off the ticket stops its runs.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'core.autocrlf=false', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  )

/** A repo of its own with main and `branch` (one commit on top), and a worktree of it next to it. */
function scratchRepo(name: string, branch: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, `${name}-`))
  const repoPath = path.join(dir, name)
  fs.mkdirSync(repoPath)
  git(repoPath, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repoPath, 'readme.txt'), `${name}\n`)
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-q', '-m', 'base')
  git(repoPath, 'branch', branch)
  const worktree = path.join(dir, `${name}-wt`)
  git(repoPath, 'worktree', 'add', '-q', worktree, branch)
  fs.writeFileSync(path.join(worktree, 'work.txt'), `${branch}\n`)
  git(worktree, 'add', '.')
  git(worktree, 'commit', '-q', '-m', `work on ${branch}`)
  return { repoPath, worktree }
}

test('a ticket spans two repos: a branch in each, both in the Branch panel and the Runs card', async ({
  page,
  human,
}) => {
  test.setTimeout(120_000)
  const api = scratchRepo('shop-api', 'feat/api')
  const web = scratchRepo('shop-web', 'feat/web')
  const created = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: `Two repos ${Date.now()}` } }),
  )
  const apiRepo = await ok<Repo>(
    human.post('/api/repos', { data: { projectId: created.id, repoPath: api.repoPath, name: 'shop-api' } }),
  )
  const webRepo = await ok<Repo>(
    human.post('/api/repos', { data: { projectId: created.id, repoPath: web.repoPath, name: 'shop-web' } }),
  )
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${created.id}/tickets`, {
      data: { title: 'Both ends', status: 'in_progress', repoId: apiRepo.id, branch: 'feat/api' },
    }),
  )
  // The web repo has a job.
  await addRun(human, webRepo.id, {
    name: 'Web worker',
    type: 'job',
    start: `node -e "console.log('worker up'); setInterval(() => {}, 1000)"`,
  })
  await page.goto(`/projects/${created.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  // One repo so far: one Branch panel, and the Runs card has nothing of the web repo's.
  await expect(page.getByRole('region', { name: /^Branch in / })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Runs' })).toHaveCount(0)

  // Add the web repo, and pick its branch.
  await details.getByRole('combobox', { name: 'Add a repository' }).click()
  await page.getByRole('option', { name: 'shop-web' }).click()
  const webField = details.getByRole('group', { name: 'Repository shop-web' })
  await expect(webField).toBeVisible()
  await webField.getByRole('combobox').click()
  await page.getByRole('option', { name: 'feat/web' }).click()
  await expect
    .poll(async () =>
      (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).repos.map((r) => [r.name, r.branch]),
    )
    .toEqual([
      ['shop-api', 'feat/api'],
      ['shop-web', 'feat/web'],
    ])

  // The web repo's worktree, registered as the web repo's now that the ticket spans it.
  await ok(
    human.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'web', branch: 'feat/web', path: web.worktree, repoId: webRepo.id },
    }),
  )

  await page.reload()

  // The Branch panel: one block per repo, each with its own branch and its last commit.
  const apiBranch = page.getByRole('region', { name: 'Branch in shop-api' })
  const webBranch = page.getByRole('region', { name: 'Branch in shop-web' })
  await expect(apiBranch).toContainText('feat/api')
  await expect(webBranch).toContainText('feat/web')
  await expect(webBranch).toContainText('work on feat/web')
  await expect(apiBranch).not.toContainText('feat/web')

  // The Runs card: the web repo's run, from its worktree; start it.
  const card = page.getByRole('region', { name: 'Runs' })
  const group = card.getByRole('group', { name: 'shop-web' })
  await expect(card.getByRole('group', { name: 'shop-api' })).toContainText('No runs')
  const row = group.getByRole('listitem', { name: 'Web worker' })
  await row.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(row.getByTestId('run-status')).toHaveText('Running', { timeout: 30_000 })

  try {
    // Taking the web repo off the ticket stops its run.
    await details.getByRole('button', { name: 'Remove shop-web' }).click()
    await expect(page.getByRole('region', { name: /^Branch in / })).toHaveCount(0)
    await expect
      .poll(async () => {
        const runs = await ok<{ results: unknown }>(human.get(`/api/tickets/${t.id}/runs`))
        return (runs as unknown as TicketRuns).repos.map((r) => r.name)
      })
      .toEqual(['shop-api'])
    const ws = (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).workspaces[0]!
    const runId = (await ok<{ id: number }[]>(human.get(`/api/repos/${webRepo.id}/runs`)))[0]!.id
    await expect
      .poll(async () => {
        const res = await human.get(`/api/workspaces/${ws.id}/runs/${runId}/log?name=server`)
        return res.status()
      })
      .toBe(200)
    await expect
      .poll(async () => {
        const stopped = await human.post(`/api/workspaces/${ws.id}/runs/${runId}/stop`)
        return stopped.status()
      })
      .toBe(409)
  } finally {
    await human.post(`/api/tickets/${t.id}/runs/stop`)
  }
})
