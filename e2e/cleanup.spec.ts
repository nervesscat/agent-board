import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { CleanupReport, DailyPayload, JobState, TicketFull } from '#/lib/api'
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

  // The leftovers are the Cleanup module's: the Ongoing features page shows no line about them.
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(page.getByRole('link', { name: /closed ticket/ })).toHaveCount(0)

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

test('a reason that names the branch does not say it twice', async ({ page, human }) => {
  // A repository of the test's own: no other test's ref listing is cached for it.
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'A branch that moved' } }),
  )
  const dir = path.join(e2eEnv().root, `moved-repo-${id}`)
  const repo = ownRepo(dir)
  await ok(human.post('/api/repos', { data: { projectId: id, repoPath: dir, name: 'repo' } }))
  const branch = 'moved-work'
  const base = 'moved-base'
  const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'moved work')
  repo.git('update-ref', `refs/heads/${base}`, sha)
  repo.git('update-ref', `refs/heads/${branch}`, sha)
  await ok<TicketFull>(
    human.post(`/api/projects/${id}/tickets`, {
      data: { title: 'Moved after the page read it', status: 'done', branch, baseBranch: base },
    }),
  )

  await page.goto(`/projects/${id}/cleanup`)
  // The page has read the branch as it is: its delete button is there.
  const sweep = page.getByRole('button', { name: /^Delete every eligible local branch/ })
  await expect(sweep).toBeVisible()
  // The branch moves after that read: deleting it is refused, and the reason names the branch.
  const moved = repo.git('commit-tree', 'main^{tree}', '-p', sha, '-m', 'more work')
  repo.git('update-ref', `refs/heads/${branch}`, moved)
  expect(repo.git('rev-parse', `refs/heads/${branch}`)).toBe(moved)
  // The board lists the refs again before a delete, but reuses a listing a few seconds old.
  await page.waitForTimeout(3_500)
  await sweep.click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 1 local branch' }).click()

  const results = page.getByRole('region', { name: 'Deletion results' })
  await expect(results.locator('[data-outcome="refused"]')).toHaveCount(1)
  await expect(results).toContainText('moved since: now at')
  await expect(results).toContainText('Refresh, then confirm again on the new commit.')
  // The branch is named once, on its own line, not again at the start of the reason.
  const text = await results.innerText()
  expect(text.match(new RegExp(branch, 'g'))).toHaveLength(1)
})

test('the last deletion says a shared reason once and lists every ticket it kept', async ({
  page,
  human,
}) => {
  // A repository of the test's own: it adds a worktree, which races no other test's listing.
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'Last deletion, one reason' } }),
  )
  const dir = path.join(e2eEnv().root, `shared-repo-${id}`)
  const repo = ownRepo(dir)
  await ok(human.post('/api/repos', { data: { projectId: id, repoPath: dir, name: 'repo' } }))

  // One branch that landed, a worktree on it, and three tickets naming it: each is a leftover that
  // stays for the very same reason.
  const branch = 'shared-work'
  const base = 'shared-base'
  const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'shared work')
  repo.git('update-ref', `refs/heads/${base}`, sha)
  repo.git('update-ref', `refs/heads/${branch}`, sha)
  const tree = path.join(e2eEnv().root, `wt-shared-${id}`)
  repo.git('worktree', 'add', '-q', tree, branch)
  const ids: number[] = []
  for (const title of ['Lane one', 'Lane two', 'Lane three']) {
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${id}/tickets`, {
        data: { title, status: 'done', branch, baseBranch: base },
      }),
    )
    ids.push(t.id)
    await ok(
      human.post(`/api/tickets/${t.id}/workspaces`, {
        data: { name: `wt-${t.id}`, branch, path: tree },
      }),
    )
  }

  await page.goto(`/projects/${id}/cleanup`)
  // A file turns up in the worktree after the page read it: the page offers the removal, the board
  // refuses it, and all three items stay for that one reason.
  fs.writeFileSync(path.join(tree, 'untracked.txt'), 'x\n')
  await page.getByRole('button', { name: /^Remove every eligible worktree with its branch/ }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Remove worktrees and delete 3 branches' }).click()

  const results = page.getByRole('region', { name: 'Deletion results' })
  const kept = results.locator('[data-outcome="refused"]')
  // One line for all three: the branch and its kind once, with every ticket it kept.
  await expect(kept).toHaveCount(1)
  await expect(kept).toContainText(branch)
  await expect(kept).toContainText(`#${ids[0]}`)
  await expect(kept).toContainText(`#${ids[ids.length - 1]}`)
  // The reason reads once, not once per item, with what to do about it.
  await expect(results.getByText(/has changes or untracked files/)).toHaveCount(1)
  await expect(results).toContainText('Commit or stash them in the worktree, then refresh.')
  // Nothing was removed.
  expect(fs.existsSync(path.join(tree, 'untracked.txt'))).toBe(true)
  expect(repo.hasRef(`refs/heads/${branch}`)).toBe(true)
})

test('a removal that fails part-way keeps the worktree it removed and its restore command', async ({
  page,
  human,
}) => {
  // A repository of the test's own: it adds worktrees, which race no other test's listing.
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'Removal that fails part-way' } }),
  )
  const dir = path.join(e2eEnv().root, `partial-repo-${id}`)
  const repo = ownRepo(dir)
  await ok(human.post('/api/repos', { data: { projectId: id, repoPath: dir, name: 'repo' } }))

  const branch = 'partial-work'
  const base = 'partial-base'
  const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'partial work')
  repo.git('update-ref', `refs/heads/${base}`, sha)
  repo.git('update-ref', `refs/heads/${branch}`, sha)
  // The branch's worktree, then a detached one at the same commit: one item, two worktrees.
  const wtA = path.join(e2eEnv().root, `wt-partial-a-${id}`)
  const wtB = path.join(e2eEnv().root, `wt-partial-b-${id}`)
  repo.git('worktree', 'add', '-q', wtA, branch)
  repo.git('worktree', 'add', '-q', '--detach', wtB, sha)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${id}/tickets`, {
      data: { title: 'Two worktrees', status: 'done', branch, baseBranch: base },
    }),
  )
  for (const [name, worktree] of [
    ['a', wtA],
    ['b', wtB],
  ] as const)
    await ok(
      human.post(`/api/tickets/${t.id}/workspaces`, {
        data: { name: `wt-${name}`, branch, path: worktree },
      }),
    )

  // Root ignores a folder's mode, so a `0500` folder does not stop `git worktree remove` there: an
  // immutable folder (`chattr +i`) does, as no process may delete it until the flag is cleared.
  const asRoot = process.getuid?.() === 0
  const lockFolder = (folder: string) =>
    asRoot ? execFileSync('chattr', ['+i', folder]) : fs.chmodSync(folder, 0o500)
  const unlockFolder = (folder: string) =>
    asRoot ? execFileSync('chattr', ['-i', folder]) : fs.chmodSync(folder, 0o700)

  // Git reports nothing changed in wtB (the folder is ignored), but it still cannot delete it there:
  // the board removes wtA, then fails on wtB, and wtA is really gone.
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'locked/\n')
  const locked = path.join(wtB, 'locked')
  fs.mkdirSync(locked)
  fs.writeFileSync(path.join(locked, 'file'), 'x\n')
  try {
    lockFolder(locked)
  } catch (error) {
    // Only a filesystem that has no immutable folders (tmpfs, Windows, macOS) may skip this test. Any other
    // failure (no chattr on PATH, a refused +i) is a broken runner and must fail the test, not hide it.
    const message = error instanceof Error ? error.message : String(error)
    if (!/Inappropriate ioctl|Operation not supported/i.test(message)) throw error
    test.skip(true, 'this filesystem has no immutable folders: the part-way removal cannot be staged as root')
  }

  try {
    await page.goto(`/projects/${id}/cleanup`)
    await page.getByRole('button', { name: /^Remove every eligible worktree with its branch/ }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Remove worktrees and delete 1 branch' }).click()

    const results = page.getByRole('region', { name: 'Deletion results' })
    // The failed item still says what did go, with the command that puts it back.
    await expect(results.locator('[data-outcome="failed"]')).toHaveCount(1)
    await expect(results).toContainText(`removed ${wtA.replace(/\\/g, '/')}`)
    const restore = results.getByRole('button', { name: /^Copy: git worktree add/ })
    await expect(restore).toHaveCount(1)
    expect(await restore.getAttribute('aria-label')).toContain(wtA.replace(/\\/g, '/'))
    // The worktree that could not go is the one the reason names.
    await expect(results).toContainText(wtB.replace(/\\/g, '/'))
    expect(fs.existsSync(wtA)).toBe(false)
    expect(fs.existsSync(wtB)).toBe(true)
    expect(repo.hasRef(`refs/heads/${branch}`)).toBe(true)
  } finally {
    unlockFolder(locked)
    fs.rmSync(wtB, { recursive: true, force: true })
    repo.git('worktree', 'prune')
  }
})

test('the bulk delete is a job: determinate progress, and the report refreshed by itself', async ({
  page,
  human,
}) => {
  // The wait for the job to finish is 60 s on its own, so this test's budget covers it.
  test.setTimeout(90_000)
  // A project on a repository of its own, with its branches' work landed in bases of their own.
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'A delete with progress' } }),
  )
  const dir = path.join(e2eEnv().root, `job-repo-${id}`)
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

  // Enough branches that the run outlasts the page's 500 ms poll of its job, so the bar is seen on the
  // way with its item: 8 finished inside one poll on a warm git listing, and the item never rendered.
  const BULK = 24
  const names = Array.from({ length: BULK }, (_, i) => `bulk-${i}`)
  for (const name of names) {
    landed(name)
    await done(name, name)
  }
  // One with a worktree: the job deletes local branches, so its removal is another kind of work and
  // stays usable while the job runs.
  const treeName = 'bulk-tree'
  landed(treeName)
  const tree = path.join(e2eEnv().root, `wt-bulk-${id}`)
  repo.git('worktree', 'add', '-q', tree, treeName)
  await done('Kept in a worktree', treeName)

  await page.goto(`/projects/${id}/cleanup`)
  const row = (branch: string) => page.locator(`tr[data-branch="${branch}"]`)
  const bulk = page.getByRole('button', {
    name: new RegExp(`^Delete every eligible local branch \\(${BULK}\\)`),
  })
  await expect(bulk).toBeVisible()
  await bulk.click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: `Delete ${BULK} local branches` }).click()

  // Determinate progress, with the item being handled, in the page's own bulk area.
  const progress = page.getByRole('region', { name: 'Delete progress' })
  const bar = progress.getByRole('progressbar')
  await expect(bar).toHaveAttribute('aria-valuemax', String(BULK))
  await expect(progress).toContainText(new RegExp(`\\d+ of ${BULK}`))
  await expect(progress).toContainText(/#\d+ \S+: (deleted|refused|failed|gone)/)
  // Only the job's own items are off meanwhile: another kind's removal and Refresh stay usable.
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  await expect(row(treeName).getByRole('button', { name: 'Remove worktree + branch' })).toBeEnabled()

  // It ends on its own, and what it did is read in counts rather than raw items.
  const status = progress.getByRole('status')
  await expect(status).toContainText(`${BULK} of ${BULK}`, { timeout: 60_000 })
  await expect(status).toContainText('Succeeded')
  await expect(status).toContainText(`${BULK} deleted`)
  await expect(status).not.toContainText('kept')
  // The running indicator is gone, and the outcomes read as they did before.
  await expect(progress.getByRole('progressbar')).toHaveCount(0)
  const results = page.getByRole('region', { name: 'Deletion results' })
  await expect(results.locator('[data-outcome="deleted"]')).toHaveCount(BULK)
  await expect(results.getByRole('button', { name: /^Copy: git branch / }).first()).toBeVisible()

  // No Refresh pressed: the deleted ones are gone from the report by itself…
  for (const name of names) await expect(row(name)).toHaveCount(0)
  // …the worktree's ticket is still there, and the rows are the report's own.
  await expect(row(treeName)).toHaveCount(1)
  const report = await ok<CleanupReport>(human.get(`/api/projects/${id}/cleanup`))
  const shown = await page
    .locator('tr[data-branch]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-branch')))
  expect(shown.sort()).toEqual(report.tickets.flatMap((t) => t.branches.map((b) => b.name)).sort())
  // The landed branches are really gone, and the worktree's branch is still where it was.
  for (const name of names) expect(repo.hasRef(`refs/heads/${name}`)).toBe(false)
  expect(repo.hasRef(`refs/heads/${treeName}`)).toBe(true)
})

test('the toast and the top-bar card say the counts, and both retries send only the kept items', async ({
  page,
  human,
}) => {
  const { id } = await ok<{ id: number }>(
    human.post('/api/projects', { data: { name: 'Kept items, retried' } }),
  )
  const dir = path.join(e2eEnv().root, `kept-repo-${id}`)
  const repo = ownRepo(dir)
  await ok(human.post('/api/repos', { data: { projectId: id, repoPath: dir, name: 'repo' } }))
  const landed = (branch: string) => {
    const sha = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', `${branch} work`)
    repo.git('update-ref', `refs/heads/${branch}`, sha)
    repo.git('update-ref', `refs/heads/${branch}-base`, sha)
    return sha
  }
  const ticket = (title: string, branch: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${id}/tickets`, {
        data: { title, status: 'done', branch, baseBranch: `${branch}-base` },
      }),
    )

  const deletedName = 'kept-deleted'
  const deletedSha = landed(deletedName)
  const deletedTicket = await ticket('One that goes', deletedName)
  const movedName = 'kept-moved'
  const movedSeen = landed(movedName)
  const movedTicket = await ticket('One that moved', movedName)

  const sent: { items: { ticketId: number; branch: string; kind: string; sha: string }[] }[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/cleanup/delete'))
      sent.push(r.postDataJSON() as (typeof sent)[number])
  })
  await page.goto(`/projects/${id}/cleanup`)
  const bulk = page.getByRole('button', { name: /^Delete every eligible local branch \(2\)/ })
  // The page has read the report: both branches are there to be asked for.
  await expect(bulk).toBeVisible()
  const moved = repo.git('commit-tree', 'main^{tree}', '-p', movedSeen, '-m', 'more work')
  repo.git('update-ref', `refs/heads/${movedName}`, moved)
  // The board lists the refs again before a delete, but reuses a listing a few seconds old.
  await page.waitForTimeout(3_500)

  await bulk.click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 2 local branches' }).click()

  const progress = page.getByRole('region', { name: 'Delete progress' })
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2')
  const status = progress.getByRole('status')
  await expect(status).toContainText('2 of 2', { timeout: 60_000 })
  await expect(status).toContainText('1 deleted, 1 kept')
  // A toast states both counts.
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: '1 deleted, 1 kept' }).first(),
  ).toBeVisible()
  // The results list what went and what stayed, and offer the kept one again.
  const results = page.getByRole('region', { name: 'Deletion results' })
  await expect(results.locator('[data-outcome="deleted"]')).toHaveCount(1)
  await expect(results.locator('[data-outcome="refused"]')).toHaveCount(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.items).toHaveLength(2)
  expect(sent[0]!.items).toEqual(
    expect.arrayContaining([
      { ticketId: deletedTicket.id, branch: deletedName, kind: 'local', sha: deletedSha },
      { ticketId: movedTicket.id, branch: movedName, kind: 'local', sha: movedSeen },
    ]),
  )

  // The page's retry: exactly the item that was kept, as it was asked for.
  await results.getByRole('button', { name: 'Retry kept items' }).click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).toEqual({
    items: [{ ticketId: movedTicket.id, branch: movedName, kind: 'local', sha: movedSeen }],
  })
  // That is a job of its own, and the page follows it the same way.
  await expect(status).toContainText('1 of 1', { timeout: 60_000 })
  await expect(status).toContainText('0 deleted, 1 kept')
  await expect(results.locator('[data-outcome="refused"]')).toHaveCount(1)

  // The top bar's card of the finished run says the same, and its retry sends the same one item.
  const bell = page.getByRole('button', { name: 'Notifications' })
  await bell.click()
  const panel = page.getByRole('dialog')
  const card = panel.getByRole('listitem').filter({ hasText: 'Delete 2 branches' }).first()
  const cardStatus = card.getByRole('status')
  await expect(cardStatus).toContainText('Succeeded')
  await expect(cardStatus).toContainText('1 deleted, 1 kept')
  await expect(card.getByRole('link', { name: 'Delete 2 branches' })).toHaveAttribute(
    'href',
    `/projects/${id}/cleanup`,
  )
  await card.getByRole('button', { name: 'Retry kept items' }).click()
  await expect.poll(() => sent.length).toBe(3)
  expect(sent[2]).toEqual({
    items: [{ ticketId: movedTicket.id, branch: movedName, kind: 'local', sha: movedSeen }],
  })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // With every item deleted, both say the deleted count alone and nothing offers a retry.
  await page.reload()
  await page.getByRole('button', { name: /^Delete every eligible local branch \(1\)/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 1 local branch' }).click()
  const last = page.getByRole('region', { name: 'Delete progress' })
  await expect(last.getByRole('status')).toContainText('1 of 1', { timeout: 60_000 })
  await expect(last.getByRole('status')).toContainText('Succeeded · 1 deleted')
  await expect(last.getByRole('status')).not.toContainText('kept')
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '1 deleted' }).first()).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Deletion results' }).getByRole('button', { name: 'Retry kept items' }),
  ).toHaveCount(0)
  await bell.click()
  const newest = page.getByRole('dialog').getByRole('listitem').first()
  await expect(newest.getByRole('status')).toContainText('Succeeded')
  await expect(newest.getByRole('status')).toContainText('1 deleted')
  await expect(newest.getByRole('status')).not.toContainText('kept')
  await expect(newest.getByRole('button', { name: 'Retry kept items' })).toHaveCount(0)

  // The kept item went on the second run of the page's retry; the first one was deleted.
  expect(repo.hasRef(`refs/heads/${deletedName}`)).toBe(false)
  expect(repo.hasRef(`refs/heads/${movedName}`)).toBe(false)
  expect(deletedTicket.id).not.toBe(movedTicket.id)
})

test('an agent deletes landed local branches alone: a request with a worktree or a branch on origin is 403 whole', async ({
  agent,
  human,
  page,
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
  // A branch with a worktree, as the report lists them.
  const withTree = 'agent-tree'
  const treeSha = landed(withTree)
  const tree = path.join(e2eEnv().root, `wt-agent-${id}`)
  repo.git('worktree', 'add', '-q', tree, withTree)
  const tt = await done('Done in a worktree', withTree)
  const report = await ok<CleanupReport>(agent.get(`/api/projects/${id}/cleanup`))
  const listed = report.tickets.find((x) => x.id === tt.id)!.branches.find((b) => b.name === withTree)!
  const local = { ticketId: t.id, branch, kind: 'local', sha }
  const remote = { ticketId: t.id, branch, kind: 'remote', sha }
  const trees = {
    ticketId: tt.id,
    branch: withTree,
    kind: 'worktrees',
    sha: listed.local,
    worktrees: listed.worktrees.map((w) => w.path),
  }
  for (const items of [[remote], [local, remote], [remote, local]]) {
    const res = await agent.post(`/api/projects/${id}/cleanup/delete`, { data: { items } })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/only the human deletes branches on origin/),
    })
  }
  for (const items of [[trees], [local, trees]]) {
    const res = await agent.post(`/api/projects/${id}/cleanup/delete`, { data: { items } })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({ error: 'only the human removes worktrees, from the Cleanup page' })
  }
  expect(repo.git('rev-parse', `refs/heads/${branch}`)).toBe(sha)
  expect(repo.git('ls-remote', 'origin', `refs/heads/${branch}`)).toContain(sha)
  expect(fs.existsSync(path.join(tree, '.git'))).toBe(true)
  expect(repo.git('rev-parse', `refs/heads/${withTree}`)).toBe(treeSha)

  const since = new Date()
  const res = await agent.post(`/api/projects/${id}/cleanup/delete`, { data: { items: [local] } })
  expect(res.status()).toBe(202)
  // The agent follows its own job, as the page does: the work is the same.
  const started = (await res.json()) as JobState
  expect(started).toMatchObject({ kind: 'cleanup-delete', actor: AGENT, total: 1, state: 'running' })
  const jobs = async () => ok<JobState[]>(agent.get(`/api/projects/${id}/jobs`))
  await expect.poll(async () => (await jobs()).find((job) => job.id === started.id)?.state).toBe('succeeded')
  const job = (await jobs()).find((job) => job.id === started.id)!
  expect(job).toMatchObject({ done: 1, total: 1, step: null, reason: null })
  expect(job.result).toEqual([
    expect.objectContaining({
      branch,
      ok: true,
      outcome: 'deleted',
      restore: [`git branch ${branch} ${sha}`],
    }),
  ])
  expect(repo.hasRef(`refs/heads/${branch}`)).toBe(false)
  expect(repo.git('ls-remote', 'origin', `refs/heads/${branch}`)).toContain(sha)

  // The deletion is logged on its ticket under the agent's name (the days the test spans).
  const days = [...new Set([since, new Date()].map(localDay))]
  const logged = (
    await Promise.all(days.map((d) => ok<DailyPayload>(human.get(`/api/daily?projectId=${id}&date=${d}`))))
  )
    .flatMap((r) => r.activity)
    .filter((a) => a.kind === 'git')
    .map((a) => [a.actor, a.text])
  expect(logged).toEqual([[AGENT, `deleted the branch ${branch} @ ${sha} of #${t.id}`]])

  // The Cleanup page says as much to the human.
  await page.goto(`/projects/${id}/cleanup`)
  const intro = page.locator('p', { hasText: 'Agents may delete local branches that landed' })
  await expect(intro).toContainText('cleanup_delete')
  await expect(intro).toContainText(
    'removing worktrees and deleting branches on origin stay yours, from this page',
  )
})
