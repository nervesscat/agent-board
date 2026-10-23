import fs from 'node:fs'
import path from 'node:path'

import type { TicketFull } from '#/lib/api'
import { e2eEnv, git } from './env'
import { expect, expectTooltip, ok, test } from './fixtures'
import { boardPreview } from './runs'

interface WorkspacePreview {
  running: boolean
  managed: unknown
  cannotStart: string | null
}

/*
 * Only what needs no real build: whether the Preview card offers Start, and what the board refuses.
 * Starting one would install and build a whole board in the worktree, which this suite does not do.
 */
test('the Preview card offers Start for a worktree of the repo, and the board refuses a path that is not one', async ({
  page,
  project,
  human,
}) => {
  const { root } = e2eEnv()
  // A worktree of the run's repo, next to it, that reads as a checkout of the board.
  const worktree = path.join(root, `wt-${project.id}`)
  git('worktree', 'add', '-q', '-b', `e2e-${project.id}-preview`, worktree, 'main')
  fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  // A folder next to it that is not a worktree.
  const plain = path.join(root, `plain-${project.id}`)
  fs.mkdirSync(plain)
  fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  // The repo runs the board's own preview, as a checkout of the board does.
  await boardPreview(human, project)

  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Try it out', status: 'in_progress', branch: `e2e-${project.id}-preview` },
    }),
  )
  const workspace = (name: string, at: string) =>
    ok<{ id: number }>(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name, path: at } }))
  const good = await workspace('worktree', worktree)
  const bad = await workspace('plain folder', plain)
  const relative = await workspace('relative', 'wt-somewhere')

  const preview = (id: number) => ok<WorkspacePreview>(human.get(`/api/workspaces/${id}/preview`))
  expect(await preview(good.id)).toMatchObject({ running: false, managed: null, cannotStart: null })
  expect((await preview(bad.id)).cannotStart).toBe(
    `${plain} is not a git worktree of ${project.repos[0]!.repoPath}`,
  )
  expect((await preview(relative.id)).cannotStart).toBe('wt-somewhere is not an absolute path')
  const refused = await human.post(`/api/workspaces/${bad.id}/preview/start`)
  expect(refused.status()).toBe(400)
  expect(await refused.text()).toContain('is not a git worktree of')

  // The card lists the repo's run from the worktree the board could run it from, with Start, and
  // leaves the others out.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Runs' })
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
  const branch = card.locator('span[data-slot="tooltip-trigger"]', {
    has: page.locator('svg.lucide-git-branch'),
  })
  await expect(branch).toBeVisible()
  await expectTooltip(branch, `workspace worktree in ${worktree}`)

  // Nothing starts on a finished ticket: the run stays listed, its Start off with the reason.
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
  expect((await preview(good.id)).cannotStart).toBe('the ticket is done')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Try it out')
  await expect(card.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
  await expect(card).toContainText('Cannot start: the ticket is done')
})
