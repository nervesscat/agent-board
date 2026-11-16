import type { ProjectPush, TicketFull } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

test('a branch on origin shows a green dot, one that is not a red one', async ({ page, project, human }) => {
  // Branches of this test alone, in the run's repo (origin is a bare repo beside it).
  const name = (what: string) => `e2e-${project.id}-${what}`
  git('branch', name('pushed'), 'main')
  git('push', '-q', 'origin', name('pushed'))
  git('branch', name('local'), 'main')
  git('branch', name('ahead'), 'main')
  git('push', '-q', 'origin', name('ahead'))
  const commit = git('commit-tree', 'main^{tree}', '-p', name('ahead'), '-m', 'not pushed').trim()
  git('update-ref', `refs/heads/${name('ahead')}`, commit)

  const ticket = (title: string, branch: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress', branch } }),
    )
  const pushed = await ticket('On origin', name('pushed'))
  const local = await ticket('Only here', name('local'))
  const ahead = await ticket('A commit ahead', name('ahead'))

  // The board reads the checkout's refs a few seconds at a time: wait until it sees these branches.
  await expect
    .poll(async () => {
      const res = await ok<ProjectPush>(human.get(`/api/projects/${project.id}/push`))
      return Object.fromEntries(res.tickets.map((t) => [t.id, t.push.state]))
    })
    .toEqual({ [pushed.id]: 'pushed', [local.id]: 'local-only', [ahead.id]: 'ahead' })

  // The dots are the tickets': the page itself says nothing about branches not pushed.
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByRole('button', { name: /branches not pushed/ })).toHaveCount(0)

  // The ticket page says it in words.
  await page.goto(`/projects/${project.id}/features/${local.id}`)
  await expect(page.getByText('not on origin', { exact: true })).toBeVisible()
  await page.goto(`/projects/${project.id}/features/${pushed.id}`)
  await expect(page.getByText('pushed', { exact: true })).toBeVisible()

  // A workspace's branch carries the dot: green when it is on origin, red when it is not.
  for (const [t, title] of [
    [pushed, 'On origin'],
    [local, 'Only here'],
    [ahead, 'A commit ahead'],
  ] as const) {
    await ok(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: title, branch: t.branch! } }))
  }
  const dotOf = async (t: TicketFull) => {
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const panel = page.getByRole('heading', { name: 'Workspaces' }).locator('..')
    await expect(panel).toContainText(t.branch!)
    return panel.getByRole('img')
  }
  const green = await dotOf(pushed)
  await expect(green).toHaveAttribute('aria-label', /^pushed\n/)
  await expect(green).toHaveClass(/bg-emerald-500/)
  const red = await dotOf(local)
  await expect(red).toHaveAttribute('aria-label', /^not pushed: no such branch on origin/)
  await expect(red).toHaveClass(/bg-red-500/)
  const aheadDot = await dotOf(ahead)
  await expect(aheadDot).toHaveAttribute('aria-label', /^not pushed: 1 commit only here/)
  await expect(aheadDot).toHaveClass(/bg-red-500/)

  // Someone else pushes to the branch: the checkout learns of it when origin is fetched, which the
  // page does on demand.
  await page.goto(`/projects/${project.id}/features/${pushed.id}`)
  const theirs = commitFile(name('pushed'), 'theirs.txt', 'from elsewhere\n', 'from elsewhere')
  git('push', '-q', 'origin', `${theirs}:refs/heads/${name('elsewhere')}`)
  git('--git-dir', e2eEnv().originPath, 'update-ref', `refs/heads/${name('pushed')}`, theirs)
  await page.getByRole('button', { name: 'Fetch origin now' }).click()
  await expect(page.getByText('pushed, behind 1', { exact: true })).toBeVisible()
})
