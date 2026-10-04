import type { ProjectPush, TicketFull } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

test('a branch on origin shows a green dot, one that is not a red one, and the not-pushed line filters', async ({
  page,
  project,
  human,
}) => {
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

  await page.goto(`/projects/${project.id}/features?view=board`)
  const column = page.locator('[data-column="in_progress"]')
  const card = (title: string) => column.getByRole('link', { name: new RegExp(title) })
  const dot = (title: string) => card(title).getByRole('img')

  await expect(dot('On origin')).toHaveAttribute('aria-label', /^pushed\n/)
  await expect(dot('On origin')).toHaveClass(/bg-emerald-500/)
  await expect(dot('Only here')).toHaveAttribute('aria-label', /^not pushed: no such branch on origin/)
  await expect(dot('Only here')).toHaveClass(/bg-red-500/)
  await expect(dot('A commit ahead')).toHaveAttribute('aria-label', /^not pushed: 1 commit only here/)
  await expect(dot('A commit ahead')).toHaveClass(/bg-red-500/)

  // "2 branches not pushed" shows only those two, and again everything.
  const line = page.getByRole('button', { name: /^2 branches not pushed/ })
  await expect(line).toHaveAttribute('aria-pressed', 'false')
  await line.click()
  await expect(line).toHaveAttribute('aria-pressed', 'true')
  await expect(line).toContainText('showing only them')
  await expect(card('Only here')).toBeVisible()
  await expect(card('A commit ahead')).toBeVisible()
  await expect(card('On origin')).toHaveCount(0)
  await line.click()
  await expect(card('On origin')).toBeVisible()

  // The same filter on the list.
  await page.getByRole('tab', { name: 'List' }).click()
  await line.click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Only here' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'On origin' })).toHaveCount(0)

  // The ticket page says it in words.
  await page.goto(`/projects/${project.id}/features/${local.id}`)
  await expect(page.getByText('not on origin', { exact: true })).toBeVisible()
  await page.goto(`/projects/${project.id}/features/${pushed.id}`)
  await expect(page.getByText('pushed', { exact: true })).toBeVisible()

  // Someone else pushes to the branch: the checkout learns of it when origin is fetched, which the
  // page does on demand.
  const theirs = commitFile(name('pushed'), 'theirs.txt', 'from elsewhere\n', 'from elsewhere')
  git('push', '-q', 'origin', `${theirs}:refs/heads/${name('elsewhere')}`)
  git('--git-dir', e2eEnv().originPath, 'update-ref', `refs/heads/${name('pushed')}`, theirs)
  await page.getByRole('button', { name: 'Fetch origin now' }).click()
  await expect(page.getByText('pushed, behind 1', { exact: true })).toBeVisible()
})
