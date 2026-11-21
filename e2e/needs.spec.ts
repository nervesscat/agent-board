import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketFull, TicketGit } from '#/lib/api'
import { commitFile, commitFiles, git } from './env'
import { expect, ok, test } from './fixtures'

/**
 * Drags a board card onto a column: the drag events a browser sends, with one DataTransfer (the Done
 * column sits beyond the edge of the board's sideways scroller, out of the mouse's reach).
 */
async function drag(page: Page, card: Locator, column: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await card.dispatchEvent('dragstart', { dataTransfer })
  await column.dispatchEvent('dragenter', { dataTransfer })
  await column.dispatchEvent('dragover', { dataTransfer })
  await column.dispatchEvent('drop', { dataTransfer })
  await card.dispatchEvent('dragend', { dataTransfer })
}

test('a ticket that needs another one merged first is held out of Done; the human can mark it done anyway', async ({
  page,
  api,
  project,
}) => {
  const base = await api.ticket({ title: 'Foundation', status: 'todo' })
  const t = await api.ticket({ title: 'Built on it', status: 'in_progress' })
  await page.goto(`/projects/${project.id}/features/${t.id}`)

  // Add the need in Details.
  const details = page.getByRole('region', { name: 'Details' })
  await details.locator('#needs').click()
  await page.getByRole('option', { name: `#${base.id} Foundation` }).click()
  await expect(details.getByRole('listitem').filter({ hasText: `#${base.id} Foundation` })).toBeVisible()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · not merged yet` })).toBeVisible()
  await expect
    .poll(async () => (await api.getTicket(t.id)).needs)
    .toMatchObject([{ id: base.id, merged: false }])

  // The board card says what it waits on.
  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Built on it/ })
  await expect(card).toContainText(`needs #${base.id}`)

  // Dragged to Done, it is refused and goes back to its column.
  await drag(page, card, page.locator('[data-column="done"]'))
  const refusal = page.locator('[data-sonner-toast]').filter({ hasText: `needs #${base.id}` })
  await expect(refusal).toBeVisible()
  await expect(refusal.getByRole('button', { name: 'Mark done anyway' })).toBeVisible()
  await expect(card).toBeVisible()
  await expect(page.locator('[data-column="done"]').getByRole('link', { name: /Built on it/ })).toHaveCount(0)
  expect((await api.getTicket(t.id)).status).toBe('in_progress')

  // On its page (loaded afresh, so the board's toast is gone), moving it to Done is refused the same
  // way, and the human can mark it done anyway.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'Done', exact: true }).click()
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: `needs #${base.id}` })
  await expect(toast).toBeVisible()
  expect((await api.getTicket(t.id)).status).toBe('in_progress')
  await toast.getByRole('button', { name: 'Mark done anyway' }).click()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('done')
  await expect(page.getByRole('combobox').filter({ hasText: 'Done' })).toBeVisible()
})

test('an agent cannot move a ticket past what it needs, with force or without', async ({
  api,
  human,
  agent,
}) => {
  const base = await api.ticket({ title: 'Foundation', status: 'todo' })
  const t = await api.ticket({ title: 'Built on it', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { needs: [base.id] } }))

  const refused = await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } })
  expect(refused.status()).toBe(409)
  expect(await refused.json()).toMatchObject({ code: 'needs' })
  const forced = await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done', force: true } })
  expect(forced.status()).toBe(403)
  expect((await api.getTicket(t.id)).status).toBe('in_progress')

  // Once what it needs is done (it has no branch to merge), the move goes through.
  await ok(human.patch(`/api/tickets/${base.id}`, { data: { status: 'done' } }))
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
})

/**
 * In the run's repo: a base for B, A's branch one commit past main, and B's branch built on A's. The
 * tickets of both, in progress.
 */
async function stacked(project: { id: number }, human: APIRequestContext) {
  const name = (what: string) => `e2e-${project.id}-${what}`
  git('branch', name('base'), 'main')
  const a = commitFile('main', 'foundation.txt', 'the foundation\n', 'the foundation')
  git('update-ref', `refs/heads/${name('a')}`, a)
  git(
    'update-ref',
    `refs/heads/${name('b')}`,
    commitFile(a, 'foundation.txt', 'built on it\n', 'built on it'),
  )
  const ticket = (data: Record<string, unknown>) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { status: 'in_progress', ...data } }),
    )
  const base = await ticket({ title: 'Foundation', branch: name('a') })
  const t = await ticket({ title: 'Built on it', branch: name('b'), baseBranch: name('base') })
  return { name, a, ticket, base, t }
}

test('a branch that holds another ticket’s unmerged work gets the need by itself; once merged, it is met', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { name, a, base, t } = await stacked(project, human)
  // The board reads the checkout's refs a few seconds at a time: wait until it has seen these branches
  // and added the need.
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).needs)
    .toMatchObject([{ id: base.id, auto: true, merged: false }])
  expect((await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git?includes=1`))).includes).toEqual([])

  // On its page: the need with the board's mark, and no suggestion to add it.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  const chip = details.getByRole('listitem').filter({ hasText: `#${base.id} Foundation` })
  await expect(chip).toBeVisible()
  await expect(chip.getByLabel('Added by the board')).toBeVisible()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · not merged yet` })).toBeVisible()
  await expect(details.getByText('Includes unmerged work from')).toHaveCount(0)
  await expect(details.getByRole('button', { name: 'Add as a need' })).toHaveCount(0)
  expect((await agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } })).status()).toBe(409)

  // A's work lands in B's base: the need is met.
  git('update-ref', `refs/heads/${name('base')}`, a)
  await page.reload()
  await expect(page.getByRole('link', { name: `Needs #${base.id} · merged` })).toBeVisible()
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(
    page.locator('[data-column="in_progress"]').getByRole('link', { name: /Built on it/ }),
  ).not.toContainText('needs #')
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
})

test('removing a need the board added sticks, and is not added again for the same commits', async ({
  page,
  project,
  human,
}) => {
  const { name, a, ticket, base, t } = await stacked(project, human)
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).needs)
    .toMatchObject([{ id: base.id, auto: true }])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  const chip = details.getByRole('listitem').filter({ hasText: `#${base.id} Foundation` })
  await chip.getByRole('button', { name: `Remove the need for #${base.id}` }).click()
  await expect(chip).toHaveCount(0)
  await expect.poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).needs).toEqual([])

  // The board looks again (a ticket built on the same work gets its need, which says it did), and the
  // removed one is still gone.
  git('update-ref', `refs/heads/${name('c')}`, commitFile(a, 'c.txt', 'c\n', 'c'))
  const c = await ticket({ title: 'Also built on it', branch: name('c'), baseBranch: name('base') })
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${c.id}`))).needs)
    .toMatchObject([{ id: base.id, auto: true }])
  expect((await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).needs).toEqual([])
  await page.reload()
  await expect(details.getByRole('listitem').filter({ hasText: `#${base.id} Foundation` })).toHaveCount(0)
})

test('a branch that holds work of another the board cannot tell is its own gets a row to add the need, and the ones it adds by itself get none', async ({
  page,
  project,
  human,
}) => {
  const name = (what: string) => `e2e-${project.id}-${what}`
  const ticket = (data: Record<string, unknown>) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { status: 'in_progress', ...data } }),
    )
  const root = git('rev-parse', 'main').trim()
  // What main holds, so a commit on top of it changes only what the test adds, and two commits that add
  // the same thing carry the same change over parents of their own.
  const listed = git('ls-tree', '-r', '--name-only', root).trim()
  const base = Object.fromEntries(
    (listed ? listed.split('\n') : []).map((file) => [file, git('show', `${root}:${file}`)]),
  )
  const at = (branch: string, sha: string) => git('update-ref', `refs/heads/${branch}`, sha)

  // 1. Stacked, and then the lower branch moved on: whose the shared commit is cannot be told.
  const lo1 = commitFiles([root], { ...base, 'lo.txt': 'lo\n' }, 'lo')
  at(name('lo'), commitFiles([lo1], { ...base, 'lo.txt': 'lo\n', 'lo2.txt': 'lo2\n' }, 'lo moved on'))
  at(name('up'), commitFiles([lo1], { ...base, 'lo.txt': 'lo\n', 'up.txt': 'up\n' }, 'up'))
  // 2. A partial merge-in: the other's first commit only, its tip is not in this branch.
  const pa1 = commitFiles([root], { ...base, 'pa.txt': 'pa\n' }, 'pa')
  at(name('pa'), commitFiles([pa1], { ...base, 'pa.txt': 'pa\n', 'pa2.txt': 'pa2\n' }, 'pa more'))
  const took = commitFiles([root, pa1], { ...base, 'pa.txt': 'pa\n' }, 'merge pa~1')
  at(name('took'), commitFiles([took], { ...base, 'pa.txt': 'pa\n', 'took.txt': 'took\n' }, 'took'))
  // 3. A copy of the commits under other shas (cherry-picked onto another parent).
  at(name('orig'), commitFiles([root], { ...base, 'x.txt': 'x\n' }, 'orig'))
  const other = commitFiles([root], { ...base, 'y.txt': 'y\n' }, 'other')
  const cp = commitFiles([other], { ...base, 'y.txt': 'y\n', 'x.txt': 'x\n' }, 'orig')
  at(name('copy'), commitFiles([cp], { ...base, 'y.txt': 'y\n', 'x.txt': 'x\n', 'z.txt': 'z\n' }, 'copy'))
  // And a stack the board can prove, beside them: it adds that need itself, so it gets no row.
  const s1 = commitFiles([root], { ...base, 's1.txt': 's1\n' }, 's1')
  at(name('s1'), s1)
  at(name('s2'), commitFiles([s1], { ...base, 's1.txt': 's1\n', 's2.txt': 's2\n' }, 's2'))

  const pairs = {
    stack: [
      await ticket({ title: 'Lower branch', branch: name('lo') }),
      await ticket({ title: 'Upper branch', branch: name('up') }),
    ],
    merge: [
      await ticket({ title: 'Merged from', branch: name('pa') }),
      await ticket({ title: 'Took part of it', branch: name('took') }),
    ],
    copy: [
      await ticket({ title: 'Original commits', branch: name('orig') }),
      await ticket({ title: 'Copied commits', branch: name('copy') }),
    ],
    proven: [
      await ticket({ title: 'Proven below', branch: name('s1') }),
      await ticket({ title: 'Proven above', branch: name('s2') }),
    ],
  }
  const row = (id: number) => `/api/tickets/${id}/git?includes=1`
  for (const key of ['stack', 'merge', 'copy'] as const) {
    const [lower, upper] = pairs[key]
    // The board reads the checkout's refs a few seconds at a time: wait until it has seen these branches.
    await expect
      .poll(async () => (await ok<TicketGit>(human.get(row(upper.id)))).includes, { message: key })
      .toEqual([lower.id])
    expect((await ok<TicketFull>(human.get(`/api/tickets/${upper.id}`))).needs).toEqual([])
  }
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${pairs.proven[1].id}`))).needs)
    .toMatchObject([{ id: pairs.proven[0].id, auto: true }])
  expect((await ok<TicketGit>(human.get(row(pairs.proven[1].id)))).includes).toEqual([])

  // The proven one: the need with the board's mark, and no row.
  const details = page.getByRole('region', { name: 'Details' })
  await page.goto(`/projects/${project.id}/features/${pairs.proven[1].id}`)
  await expect(details.getByLabel('Added by the board')).toBeVisible()
  await expect(details.getByTestId('includes-hint')).toHaveCount(0)

  // Each undecidable one: the row, naming the other ticket.
  for (const key of ['merge', 'copy'] as const) {
    const [lower, upper] = pairs[key]
    await page.goto(`/projects/${project.id}/features/${upper.id}`)
    const hint = details.getByTestId('includes-hint')
    await expect(hint).toHaveCount(1)
    await expect(hint.getByRole('link', { name: `#${lower.id} ${lower.title}` })).toBeVisible()
    await expect(details.getByLabel('Added by the board')).toHaveCount(0)
  }
  // Adding it by hand turns it into a need (not the board's), and the row goes.
  const [lower, upper] = pairs.stack
  await page.goto(`/projects/${project.id}/features/${upper.id}`)
  const hint = details.getByTestId('includes-hint')
  await expect(hint.getByRole('link', { name: `#${lower.id} ${lower.title}` })).toBeVisible()
  await hint.getByRole('button', { name: 'Add as a need' }).click()
  await expect(hint).toHaveCount(0)
  await expect(details.getByRole('listitem').filter({ hasText: `#${lower.id} ${lower.title}` })).toBeVisible()
  expect((await ok<TicketFull>(human.get(`/api/tickets/${upper.id}`))).needs).toMatchObject([
    { id: lower.id, auto: false },
  ])
})
