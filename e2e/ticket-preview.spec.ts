import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Repo, TicketFull } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

/*
 * A ticket's preview, on the board and in the list, says what the ticket is: its number, title,
 * badges, tags and time. Where the work lives (its repo, its branch, who holds it) is the ticket
 * page's Details, not the preview.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  )

/** A repo of its own with main and one more branch, to give a ticket a real branch name. */
function scratchRepo(name: string, branch: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, `${name}-`))
  const repoPath = path.join(dir, name)
  fs.mkdirSync(repoPath)
  git(repoPath, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repoPath, 'readme.txt'), `${name}\n`)
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-q', '-m', 'base')
  if (branch !== 'main') git(repoPath, 'branch', branch)
  return repoPath
}

test('a ticket preview leaves out its repo, assignee and branch, and keeps its title, tag and time', async ({
  page,
  human,
}) => {
  const apiRepo = scratchRepo('preview-api', 'feat/preview-card')
  // A second repo, so the board has a repo name to show a ticket's repo with.
  const webRepo = scratchRepo('preview-web', 'main')
  const created = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: `Ticket previews ${Date.now()}` } }),
  )
  const api = await ok<Repo>(
    human.post('/api/repos', { data: { projectId: created.id, repoPath: apiRepo, name: 'preview-api' } }),
  )
  await ok<Repo>(
    human.post('/api/repos', { data: { projectId: created.id, repoPath: webRepo, name: 'preview-web' } }),
  )
  const title = 'A compact preview'
  const owner = 'preview-owner'
  const branch = 'feat/preview-card'
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${created.id}/tickets`, {
      data: {
        title,
        status: 'in_progress',
        repoId: api.id,
        branch,
        assignee: owner,
        tags: ['UI'],
      },
    }),
  )
  // A ticket with no tags: its preview still has its time, and no empty line where the tags would be.
  const bare = await ok<TicketFull>(
    human.post(`/api/projects/${created.id}/tickets`, {
      data: { title: 'A bare preview', status: 'todo', repoId: api.id },
    }),
  )

  // The board: the card says what the ticket is, and where it is, nowhere.
  await page.goto(`/projects/${created.id}/features?view=board`)
  const card = page.locator('[data-column="in_progress"]').getByRole('link', { name: new RegExp(title) })
  await expect(card).toBeVisible()
  for (const gone of ['preview-api', 'preview-web', owner, branch]) {
    await expect(card).not.toContainText(gone)
  }
  await expect(card).toContainText(title)
  await expect(card.getByText('UI', { exact: true })).toBeVisible()
  await expect(card.getByTestId('card-time')).toHaveText(/just now|min ago/)

  const bareCard = page.locator('[data-column="todo"]').getByRole('link', { name: /A bare preview/ })
  await expect(bareCard.getByTestId('card-time')).toBeVisible()

  // The list, the same ticket: the same three left out, its title, tag and time kept.
  await page.goto(`/projects/${created.id}/features?view=list`)
  const row = page.getByRole('listitem').filter({ hasText: title })
  for (const gone of ['preview-api', 'preview-web', owner, branch]) {
    await expect(row).not.toContainText(gone)
  }
  await expect(row).toContainText(title)
  await expect(row.getByText('UI', { exact: true })).toBeVisible()
  await expect(row.getByTestId('row-time')).toHaveText(/just now|min ago/)
  // No lanes: no metadata line under the title, not even an empty one.
  await expect(
    page.getByRole('listitem').filter({ hasText: bare.title }).getByTestId('row-meta'),
  ).toHaveCount(0)

  // Where the ticket's repo, assignee and branch live: the ticket page's Details, still there to edit.
  await page.goto(`/projects/${created.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  await expect(details.locator('#assignee')).toContainText(owner)
  await expect(details.locator('#branch')).toContainText(branch)
  // Two repos: the Repository field picks which one the ticket's work is on.
  await expect(details.locator('#repo')).toBeVisible()
})
