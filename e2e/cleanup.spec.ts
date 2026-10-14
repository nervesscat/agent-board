import fs from 'node:fs'
import path from 'node:path'

import type { CleanupReport, TicketFull } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

const hasRef = (ref: string) => {
  try {
    git('show-ref', '--verify', '--quiet', ref)
    return true
  } catch {
    return false
  }
}

test('the human removes a worked branch with its worktree, after a dialog listing exactly that', async ({
  page,
  project,
  human,
}) => {
  // Branches of this test alone, in the run's repo: their work landed in a base of their own, so main
  // never moves under the other tests.
  const name = (what: string) => `e2e-${project.id}-${what}`
  const done = commitFile('main', 'done.txt', 'done\n', 'done work')
  const free = commitFile(done, 'free.txt', 'free\n', 'free work')
  const unique = commitFile('main', 'kept.txt', 'kept\n', 'work that never landed')
  git('update-ref', `refs/heads/${name('base')}`, free)
  git('update-ref', `refs/heads/${name('done')}`, done)
  git('update-ref', `refs/heads/${name('free')}`, free)
  git('update-ref', `refs/heads/${name('kept')}`, unique)
  const tree = path.join(e2eEnv().root, `wt-${project.id}`)
  git('worktree', 'add', '-q', tree, name('done'))
  // git lists worktree paths with forward slashes, also on Windows.
  const listed = tree.replace(/\\/g, '/')

  const ticket = (title: string, branch: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title, status: 'done', branch, baseBranch: name('base') },
      }),
    )
  const withTree = await ticket('Done with a worktree', name('done'))
  await ok(
    human.post(`/api/tickets/${withTree.id}/workspaces`, {
      data: { name: 'wt', branch: name('done'), path: tree },
    }),
  )
  const plain = await ticket('Done, branch only', name('free'))
  await ticket('Never landed', name('kept'))
  const report = await ok<CleanupReport>(human.get(`/api/projects/${project.id}/cleanup`))
  expect(report.tickets).toHaveLength(3)

  const sent: unknown[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/cleanup/delete')) sent.push(r.postDataJSON())
  })
  await page.goto(`/projects/${project.id}/cleanup`)
  const row = (what: string) => page.locator(`tr[data-branch="${name(what)}"]`)

  // Work that never landed offers nothing to press, only why it stays.
  await expect(row('kept')).toContainText('Kept: 1 commit of its own')
  await expect(row('kept').getByRole('button', { name: /Delete|Remove/ })).toHaveCount(0)

  const removeButton = row('done').getByRole('button', { name: 'Remove worktree + branch' })
  const dialog = page.getByRole('alertdialog')
  await removeButton.click()
  await expect(dialog).toContainText('Remove the worktrees of 1 branch, and the branches?')
  await expect(dialog).toContainText(`#${withTree.id} Done with a worktree`)
  await expect(dialog).toContainText(`${name('done')} @ ${done.slice(0, 7)} local`)
  await expect(dialog).toContainText(`worktree ${listed}`)
  await expect(dialog).not.toContainText(name('free'))

  // Escape and Keep send nothing.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await removeButton.click()
  await dialog.getByRole('button', { name: 'Keep' }).click()
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([])
  expect(fs.existsSync(tree)).toBe(true)

  await removeButton.click()
  await dialog.getByRole('button', { name: 'Remove worktrees and delete 1 branch' }).click()
  const results = page.getByRole('region', { name: 'Deletion results' })
  await expect(results.locator('[data-outcome="deleted"]')).toHaveCount(1)
  await expect(results).toContainText(`git branch ${name('done')} ${done}`)
  await expect(
    results.getByRole('button', { name: `Copy: git branch ${name('done')} ${done}` }),
  ).toBeVisible()
  expect(sent).toEqual([
    {
      items: [
        { ticketId: withTree.id, branch: name('done'), kind: 'worktrees', sha: done, worktrees: [listed] },
      ],
    },
  ])
  expect(fs.existsSync(tree)).toBe(false)
  expect(hasRef(`refs/heads/${name('done')}`)).toBe(false)
  await expect(row('done')).toHaveCount(0)

  // Every eligible local branch at once: only the one that landed, listed before anything goes.
  await page.getByRole('button', { name: /^Delete every eligible local branch \(1\)/ }).click()
  await expect(dialog).toContainText(`#${plain.id} Done, branch only`)
  await expect(dialog).toContainText(`${name('free')} @ ${free.slice(0, 7)} local`)
  await expect(dialog).not.toContainText(name('kept'))
  await dialog.getByRole('button', { name: 'Delete 1 local branch' }).click()
  await expect(results.locator('[data-outcome="deleted"]')).toHaveCount(1)
  await expect(results).toContainText(`git branch ${name('free')} ${free}`)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual({
    items: [{ ticketId: plain.id, branch: name('free'), kind: 'local', sha: free }],
  })
  expect(hasRef(`refs/heads/${name('free')}`)).toBe(false)
  expect(hasRef(`refs/heads/${name('kept')}`)).toBe(true)
})

test('the dialog names a server linked on this machine at the worktree, which its removal stops', async ({
  page,
  project,
  human,
}) => {
  const branch = `e2e-${project.id}-linked`
  const sha = commitFile('main', 'linked.txt', 'linked\n', 'linked work')
  git('update-ref', `refs/heads/${branch}`, sha)
  git('update-ref', `refs/heads/${branch}-base`, sha)
  const tree = path.join(e2eEnv().root, `wt-linked-${project.id}`)
  git('worktree', 'add', '-q', tree, branch)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Done, served from its worktree', status: 'done', branch, baseBranch: `${branch}-base` },
    }),
  )
  const space = (name: string, previewUrl: string) =>
    ok(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name, branch, path: tree, previewUrl } }))
  await space('dev', 'http://127.0.0.1:8360')
  // Off this machine: nothing the board could stop.
  await space('deployed', 'https://linked.example.com')

  await page.goto(`/projects/${project.id}/cleanup`)
  await page
    .locator(`tr[data-branch="${branch}"]`)
    .getByRole('button', { name: 'Remove worktree + branch' })
    .click()
  const dialog = page.getByRole('alertdialog')
  // git lists worktree paths with forward slashes, also on Windows.
  await expect(dialog).toContainText(`worktree ${tree.replace(/\\/g, '/')}`)
  await expect(dialog).toContainText('stops the server on :8360 if it runs from this worktree')
  await expect(dialog.getByText(/stops the server/)).toHaveCount(1)
  await expect(dialog).not.toContainText('linked.example.com')
  await dialog.getByRole('button', { name: 'Keep' }).click()
  await expect(dialog).toBeHidden()
  expect(fs.existsSync(tree)).toBe(true)
})

test('deleting branches is the human’s: an agent gets 403 and nothing changes', async ({
  agent,
  human,
  project,
}) => {
  const branch = `e2e-${project.id}-agent`
  const sha = commitFile('main', 'agent.txt', 'agent\n', 'agent work')
  git('update-ref', `refs/heads/${branch}`, sha)
  git('update-ref', `refs/heads/e2e-${project.id}-agent-base`, sha)
  git('push', '-q', 'origin', branch)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Done by an agent', status: 'done', branch, baseBranch: `e2e-${project.id}-agent-base` },
    }),
  )
  for (const kind of ['local', 'remote', 'worktrees'] as const) {
    const res = await agent.post(`/api/projects/${project.id}/cleanup/delete`, {
      data: { items: [{ ticketId: t.id, branch, kind, sha, worktrees: [] }] },
    })
    expect(res.status()).toBe(403)
  }
  expect(git('rev-parse', `refs/heads/${branch}`).trim()).toBe(sha)
  expect(git('ls-remote', 'origin', `refs/heads/${branch}`)).toContain(sha)
})
