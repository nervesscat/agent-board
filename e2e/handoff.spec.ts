import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Handoff, TicketFull, TicketGit } from '#/lib/api'
import { commitFile, e2eEnv, git } from './env'
import { expect, ok, test } from './fixtures'

const ALL = ['tasks_open', 'no_pr', 'not_pushed', 'no_preview', 'no_handoff_post']

/** The implementation's one step, added and ticked: the hand-off's Implementation item is met. */
async function implemented(agent: APIRequestContext, ticketId: number) {
  const [step] = await ok<{ id: number }[]>(
    agent.post(`/api/tickets/${ticketId}/tasks`, { data: { tasks: ['Build it'] } }),
  )
  await ok(agent.patch(`/api/tasks/${step!.id}`, { data: { done: true } }))
}

/** A CSS colour as the sRGB pixel it paints, whatever notation the browser computes it in. */
const rgb = (page: Page, color: string) =>
  page.evaluate((c) => {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.fillStyle = c
    ctx.fillRect(0, 0, 1, 1)
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, color)

/** The colour a section's border paints. */
const borderOf = async (section: Locator) =>
  rgb(section.page(), await section.evaluate((e) => getComputedStyle(e).borderTopColor))

/** Clearly green: the green channel well above red and blue. */
const green = ([r, g, b]: number[]) => g! - Math.max(r!, b!) >= 40

/**
 * Waits until the page has the ticket's git state, which the card's Merged item also goes by: the
 * Branch card's reach badge, against `into`. Without it a pending Merged proves nothing.
 */
const reachShown = (page: Page, into: string) =>
  expect(page.getByText(`→ ${into}`, { exact: true }).first()).toBeVisible()

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
  // Implementation, right after Merged: the ticket has no tasks yet.
  const rows = card.locator('[data-code]')
  await expect(rows.nth(0)).toHaveAttribute('data-code', 'not_merged')
  await expect(rows.nth(1)).toHaveAttribute('data-code', 'tasks_open')
  await expect(item('tasks_open')).toContainText('Implementation')
  await expect(item('tasks_open')).toContainText('No tasks')
  await expect(item('tasks_open')).toContainText('high-level phases (plan, code, tests…)')
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
  // Complete, though the branch is not merged yet: that is the human's step, not a missing item.
  await expect(card).toContainText('complete')
  await reachShown(page, 'main')
  await expect(item('not_merged')).toHaveAttribute('data-ok', 'false')
  for (const code of ALL) await expect(item(code)).toHaveAttribute('data-ok', 'true')
  await expect(item('tasks_open')).toContainText('3 of 3 tasks done')
  await expect(item('no_pr')).toContainText('PR #4242')
  await expect(item('not_pushed')).toContainText('Branch pushed')
  await expect(item('no_preview')).toContainText(`Running at ${e2eEnv().baseURL}`)
  await expect(item('no_handoff_post')).toContainText('Posted by claude after the last commit')
  await card.screenshot({ path: test.info().outputPath('handoff-card.png') })
})

test('Merged comes first and waits on the human; once the branch is in its base the whole card turns green', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A base of the ticket's own (so the run's main never moves), long enough to wrap on a phone, and a
  // pushed branch one commit past it.
  const name = (what: string) => `e2e-${project.id}-${what}`
  const base = name('a-base-branch-with-a-rather-long-name-that-has-to-wrap-on-a-phone')
  git('branch', base, 'main')
  const branch = name('merge-me')
  const work = commitFile('main', 'merge-me.txt', 'work\n', 'work')
  git('branch', branch, work)
  git('push', '-q', 'origin', branch)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Merge it', status: 'in_progress', branch, baseBranch: base },
    }),
  )
  const read = () => ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
  const reach = async () => (await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))).info.reach?.state
  // Everything the hand-off asks for: its tasks done, a PR, a preview that answers, the hand-off post.
  await implemented(agent, t.id)
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { prNumber: 4343 } }))
  await ok(
    agent.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'worktree', branch, previewUrl: e2eEnv().baseURL },
    }),
  )
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: `PR #4343. Preview: ${e2eEnv().baseURL}.` },
    }),
  )
  await expect.poll(async () => (await read()).push.state).toBe('pushed')
  await expect.poll(reach).toBe('unique')

  // The human moves it to review: nothing lacks, so no warning; Merged is first, pending.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Merge it')
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'In review', exact: true }).click()
  const card = page.getByRole('region', { name: 'Hand-off' })
  const item = (code: string) => card.locator(`[data-code="${code}"]`)
  await expect(card).toContainText('complete')
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'the hand-off lacks' })).toHaveCount(0)
  const rows = card.locator('li')
  await expect(rows.nth(0)).toHaveAttribute('data-code', 'not_merged')
  await expect(rows.nth(1)).toHaveAttribute('data-code', 'tasks_open')
  await expect(rows.nth(2)).toHaveAttribute('data-code', 'no_pr')
  const merged = item('not_merged')
  await reachShown(page, base)
  await expect(merged).toHaveAttribute('data-ok', 'false')
  await expect(merged).toContainText('MergedNot merged yet')
  const marker = merged.getByRole('img')
  await expect(marker).toHaveAccessibleName('pending')
  await expect(marker).not.toHaveClass(/amber/)
  await expect(marker.locator('*')).not.toHaveClass(/amber/)
  for (const code of ALL) await expect(item(code)).toHaveAttribute('data-ok', 'true')
  // Only Merged pending: the card's border is the plain one every card has.
  const details = page.getByRole('region', { name: 'Details' })
  const plain = await borderOf(details)
  expect(green(plain), `${plain}`).toBe(false)
  expect(await borderOf(card)).toEqual(plain)
  await card.screenshot({ path: test.info().outputPath('handoff-pending-merge.png') })

  // An agent moving it there hears the same: nothing missing.
  const moved = await ok<TicketFull & { handoff: Handoff }>(
    agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }),
  )
  expect(moved.handoff.missing).toEqual([])
  expect(moved.handoff.checks[0]).toMatchObject({ code: 'not_merged', label: 'Merged', ok: false })

  // The branch lands in its base: the card's git state says so, and every row is green.
  git('update-ref', `refs/heads/${base}`, work)
  await expect.poll(reach).toBe('merged')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.reload()
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await expect(merged).toHaveAttribute('data-ok', 'true')
    await expect(merged).toContainText(`Merged into ${base}`)
    await expect(card.locator('li[data-ok="false"]')).toHaveCount(0)
    const border = await borderOf(card)
    expect(green(border), `${colorScheme}: ${border}`).toBe(true)
    expect(border).not.toEqual(await borderOf(details))
    await card.screenshot({ path: test.info().outputPath(`handoff-merged-${colorScheme}.png`) })
  }

  // On a phone the long base wraps inside the card, and the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(merged).toHaveAttribute('data-ok', 'true')
  await card.scrollIntoViewIfNeeded()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
  const box = (await card.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  const text = (await merged.locator('.block').boundingBox())!
  expect(text.x + text.width).toBeLessThanOrEqual(box.x + box.width)
  await card.screenshot({ path: test.info().outputPath('handoff-merged-phone.png') })
})

test('a local branch left behind its PR’s pushed commits is not taken as merged, until it catches up and lands', async ({
  page,
  project,
  human,
  agent,
}) => {
  // The local branch still sits at its base's commit (a worktree made from it and never advanced);
  // the PR's commit was pushed to origin's copy from elsewhere.
  const name = (what: string) => `e2e-${project.id}-${what}`
  const base = name('behind-base')
  const branch = name('behind')
  git('branch', base, 'main')
  git('branch', branch, 'main')
  const work = commitFile('main', 'behind.txt', 'work\n', 'work')
  git('push', '-q', 'origin', `${work}:refs/heads/${branch}`)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Pushed from elsewhere', status: 'in_progress', branch, baseBranch: base },
    }),
  )
  const gitState = async () => (await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))).info
  await implemented(agent, t.id)
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { prNumber: 4444 } }))
  await ok(
    agent.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'worktree', branch, previewUrl: e2eEnv().baseURL },
    }),
  )
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: `PR #4444. Preview: ${e2eEnv().baseURL}.` },
    }),
  )
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  // The local branch is in its base, and behind origin's copy, which holds the PR's commit.
  await expect
    .poll(async () => {
      const info = await gitState()
      return [info.reach?.state, info.push.state, info.push.behind]
    })
    .toEqual(['merged', 'pushed', 1])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Hand-off' })
  const merged = card.locator('[data-code="not_merged"]')
  await expect(card).toContainText('complete')
  for (const code of ALL)
    await expect(card.locator(`[data-code="${code}"]`)).toHaveAttribute('data-ok', 'true')
  await reachShown(page, base)
  await expect(merged).toHaveAttribute('data-ok', 'false')
  await expect(merged).toContainText('Not merged yet')
  const details = page.getByRole('region', { name: 'Details' })
  expect(await borderOf(card)).toEqual(await borderOf(details))

  // The local branch catches up, and its base takes it in: merged, and the card turns green.
  git('update-ref', `refs/heads/${branch}`, work)
  git('update-ref', `refs/heads/${base}`, work)
  await expect
    .poll(async () => {
      const info = await gitState()
      return [info.reach?.state, info.push.state, info.push.behind]
    })
    .toEqual(['merged', 'pushed', 0])
  await page.reload()
  await expect(merged).toHaveAttribute('data-ok', 'true')
  await expect(merged).toContainText(`Merged into ${base}`)
  await expect(card.locator('li[data-ok="false"]')).toHaveCount(0)
  const border = await borderOf(card)
  expect(green(border), `${border}`).toBe(true)
})

test('a branch with no work of its own and no PR is not taken as merged', async ({
  page,
  project,
  human,
  agent,
}) => {
  // At main's commit, and pushed: in its base already, with nothing of its own.
  const branch = `e2e-${project.id}-empty`
  git('branch', branch, 'main')
  git('push', '-q', 'origin', branch)
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Nothing yet', status: 'in_progress', branch },
    }),
  )
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  await expect
    .poll(async () => {
      const { info } = await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))
      return [info.reach?.state, info.push.state, info.push.behind]
    })
    .toEqual(['merged', 'pushed', 0])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const merged = page.getByRole('region', { name: 'Hand-off' }).locator('[data-code="not_merged"]')
  await reachShown(page, 'main')
  await expect(merged).toHaveAttribute('data-ok', 'false')
  await expect(merged).toContainText('Not merged yet')
})

test('a branch with a PR whose copy on origin is gone is not taken as merged', async ({
  page,
  project,
  human,
  agent,
}) => {
  // The PR was closed without merging and its branch deleted on origin; the local branch, never
  // advanced, still sits at its base's commit.
  const branch = `e2e-${project.id}-closed`
  git('branch', branch, 'main')
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Closed, not merged', status: 'in_progress', branch },
    }),
  )
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review', prNumber: 4545 } }))
  await expect
    .poll(async () => {
      const { info } = await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))
      return [info.reach?.state, info.push.state, info.push.behind]
    })
    .toEqual(['merged', 'local-only', 0])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Hand-off' })
  await expect(card.locator('[data-code="no_pr"]')).toHaveAttribute('data-ok', 'true')
  const merged = card.locator('[data-code="not_merged"]')
  await reachShown(page, 'main')
  await expect(merged).toHaveAttribute('data-ok', 'false')
  await expect(merged).toContainText('Not merged yet')
})

test('work that reached another base of the chain, not the ticket’s own, is not taken as merged', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A backport. The parent ticket's base stands in for main (the run's main never moves): the fix is
  // already there. The lane's own base, its release branch, does not have it yet; the lane's branch
  // carries the same patch as a commit of its own, pushed, its PR open against the release branch.
  const name = (what: string) => `e2e-${project.id}-${what}`
  const upstream = name('upstream')
  const release = name('release')
  const branch = name('backport')
  git('branch', upstream, commitFile('main', 'fix.txt', 'fixed\n', 'fix'))
  git('branch', release, 'main')
  const work = commitFile('main', 'fix.txt', 'fixed\n', 'fix (backport)')
  git('branch', branch, work)
  git('push', '-q', 'origin', branch)
  const parent = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Fix it', status: 'in_progress', baseBranch: upstream },
    }),
  )
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Backport it', status: 'in_progress', parentId: parent.id, branch, baseBranch: release },
    }),
  )
  const gitState = async () => (await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))).info
  await implemented(agent, t.id)
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { prNumber: 4646 } }))
  await ok(
    agent.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'worktree', branch, previewUrl: e2eEnv().baseURL },
    }),
  )
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, {
      data: { body: `PR #4646. Preview: ${e2eEnv().baseURL}.` },
    }),
  )
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  // Its patch is in the parent's base, so the chain's best verdict is rebased into that one.
  await expect
    .poll(async () => {
      const info = await gitState()
      return [info.reach?.state, info.reach?.into, info.push.state, info.push.behind]
    })
    .toEqual(['rebased', upstream, 'pushed', 0])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Hand-off' })
  const merged = card.locator('[data-code="not_merged"]')
  await expect(card).toContainText('complete')
  for (const code of ALL)
    await expect(card.locator(`[data-code="${code}"]`)).toHaveAttribute('data-ok', 'true')
  await reachShown(page, upstream)
  await expect(merged).toHaveAttribute('data-ok', 'false')
  await expect(merged).toContainText('Not merged yet')
  const details = page.getByRole('region', { name: 'Details' })
  expect(await borderOf(card)).toEqual(await borderOf(details))

  // The release branch takes the backport: merged into the lane's own base, and the card turns green.
  git('update-ref', `refs/heads/${release}`, work)
  await expect
    .poll(async () => {
      const info = await gitState()
      return [info.reach?.state, info.reach?.into]
    })
    .toEqual(['merged', release])
  await page.reload()
  await reachShown(page, release)
  await expect(merged).toHaveAttribute('data-ok', 'true')
  await expect(merged).toContainText(`Merged into ${release}`)
  await expect(card.locator('li[data-ok="false"]')).toHaveCount(0)
  const border = await borderOf(card)
  expect(green(border), `${border}`).toBe(true)
})
