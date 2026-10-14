import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { CleanupReport, DailyPayload, TicketFull } from '#/lib/api'
import { AGENT, commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

const hasRef = (ref: string) => {
  try {
    git('show-ref', '--verify', '--quiet', ref)
    return true
  } catch {
    return false
  }
}
/** The local day of `d`, as `/api/daily` takes it. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * A repository of a test's own at `dir`, with a bare origin beside it: a worktree it adds or removes
 * races no other test's listing of the run's repo, nor does one of theirs its listings (git fails to
 * list a repository's worktrees while another process adds one).
 */
function ownRepo(dir: string) {
  const run = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', `${dir}.git`])
  fs.mkdirSync(dir)
  run('init', '-q', '-b', 'main')
  run('commit', '-q', '--allow-empty', '-m', 'init')
  run('remote', 'add', 'origin', `${dir}.git`)
  run('push', '-q', '-u', 'origin', 'main')
  const has = (ref: string) => {
    try {
      run('show-ref', '--verify', '--quiet', ref)
      return true
    } catch {
      return false
    }
  }
  return { git: run, hasRef: has }
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

test('an agent deletes landed local branches and worktrees, never on origin: a request with one is 403 whole', async ({
  agent,
  human,
}) => {
  // A project on a repository of its own (ownRepo), with its branches' work landed in their bases.
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'Cleaned up by an agent' } }),
  )
  const dir = path.join(e2eEnv().root, `agent-repo-${id}`)
  const repo = ownRepo(dir)
  await ok(human.post('/api/repos', { data: { projectId: id, repoPath: dir, name: 'repo' } }))
  const landed = (branch: string) => {
    const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', `${branch} work`)
    repo.git('update-ref', `refs/heads/${branch}`, sha)
    repo.git('update-ref', `refs/heads/${branch}-base`, sha)
    return sha
  }
  const done = (title: string, branch: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${id}/tickets`, {
        data: { title, status: 'done', branch, baseBranch: `${branch}-base` },
      }),
    )

  const branch = 'agent-local'
  const sha = landed(branch)
  repo.git('push', '-q', 'origin', branch)
  const t = await done('Done by an agent', branch)
  const local = { ticketId: t.id, branch, kind: 'local', sha }
  const remote = { ticketId: t.id, branch, kind: 'remote', sha }
  for (const items of [[remote], [local, remote], [remote, local]]) {
    const res = await agent.post(`/api/projects/${id}/cleanup/delete`, { data: { items } })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/only the human deletes branches on origin/),
    })
  }
  expect(repo.git('rev-parse', `refs/heads/${branch}`)).toBe(sha)
  expect(repo.git('ls-remote', 'origin', `refs/heads/${branch}`)).toContain(sha)

  const since = new Date()
  const res = await agent.post(`/api/projects/${id}/cleanup/delete`, { data: { items: [local] } })
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual([
    expect.objectContaining({
      branch,
      ok: true,
      outcome: 'deleted',
      restore: [`git branch ${branch} ${sha}`],
    }),
  ])
  expect(repo.hasRef(`refs/heads/${branch}`)).toBe(false)
  expect(repo.git('ls-remote', 'origin', `refs/heads/${branch}`)).toContain(sha)

  // A branch's worktree, then the branch, as the report lists them.
  const withTree = 'agent-tree'
  const treeSha = landed(withTree)
  const tree = path.join(e2eEnv().root, `wt-agent-${id}`)
  repo.git('worktree', 'add', '-q', tree, withTree)
  const tt = await done('Done in a worktree', withTree)
  const report = await ok<CleanupReport>(agent.get(`/api/projects/${id}/cleanup`))
  const listed = report.tickets.find((x) => x.id === tt.id)!.branches.find((b) => b.name === withTree)!
  expect(listed.can.worktrees).toEqual({ ok: true, reason: null })
  const paths = listed.worktrees.map((w) => w.path)
  const trees = await agent.post(`/api/projects/${id}/cleanup/delete`, {
    data: {
      items: [{ ticketId: tt.id, branch: withTree, kind: 'worktrees', sha: listed.local, worktrees: paths }],
    },
  })
  expect(trees.status()).toBe(200)
  expect(await trees.json()).toEqual([
    expect.objectContaining({
      outcome: 'deleted',
      removed: paths,
      restore: [
        `git branch ${withTree} ${treeSha}`,
        expect.stringMatching(new RegExp(`^git worktree add .+ ${withTree}$`)),
      ],
    }),
  ])
  expect(fs.existsSync(tree)).toBe(false)
  expect(repo.hasRef(`refs/heads/${withTree}`)).toBe(false)

  // Each deletion is logged on its ticket under the agent's name (the days the test spans).
  const days = [...new Set([since, new Date()].map(localDay))]
  const logged = (
    await Promise.all(days.map((d) => ok<DailyPayload>(human.get(`/api/daily?projectId=${id}&date=${d}`))))
  )
    .flatMap((r) => r.activity)
    .filter((a) => a.kind === 'git')
    .map((a) => [a.actor, a.text])
  expect(logged).toEqual([
    [AGENT, `deleted the branch ${branch} @ ${sha} of #${t.id}`],
    [
      AGENT,
      expect.stringMatching(
        new RegExp(`^removed the worktree .+wt-agent-${id} \\(${withTree}\\) of #${tt.id}$`),
      ),
    ],
    [AGENT, `deleted the branch ${withTree} @ ${treeSha} of #${tt.id}`],
  ])
})
