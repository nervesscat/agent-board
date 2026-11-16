import type { Page } from '@playwright/test'

import type { PrRow, Project } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { expect, expectTooltip, ok, test } from './fixtures'

test('the PR queue renders with its filter (no GitHub: empty)', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  for (const status of ['Pending', 'Reviewed', 'On hold', 'Done'])
    await expect(page.getByRole('tab', { name: new RegExp(`^${status}`) })).toBeVisible()

  // Two filters, To review first and picked until another is.
  const filter = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const filters = page
    .getByRole('tablist')
    .filter({ has: filter('To review') })
    .getByRole('tab')
  await expect(filters).toHaveCount(2)
  await expect(filters.nth(0)).toHaveText(/^To review\s*0$/)
  await expect(filters.nth(1)).toHaveText(/^Waiting on others\s*0$/)
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'false')
  // The To review switch, its own tab row beside the filters: All PRs, or the PRs GitHub still asks me
  // to review. All PRs until another is picked.
  const reviewSwitch = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'All PRs' }) })
  await expect(reviewSwitch.getByRole('tab')).toHaveText(['All PRs', 'Just me as reviewer'])
  await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Just me as reviewer' })).toHaveAttribute(
    'aria-selected',
    'false',
  )
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()
  await expect(page.getByText('Nothing pending.', { exact: true })).toHaveCount(0)
  await expectTooltip(
    filter('To review'),
    'PRs by others you review: pending your approval, approved by you, or on hold on your comments',
  )
  await expectTooltip(
    filter('Waiting on others'),
    "Your PRs (agents' too): pending approvals, approved by every reviewer, or on hold on their comments",
  )

  await filter('Waiting on others').click()
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'false')
  // The switch belongs to To review: Waiting on others has none.
  await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Just me as reviewer' })).toHaveCount(0)
  await expect(page.getByText('Nothing pending waiting on others.')).toBeVisible()
  await page.getByRole('tab', { name: /^On hold/ }).click()
  await expect(page.getByText('Nothing on hold waiting on others.')).toBeVisible()
  await page.getByRole('tab', { name: /^Done/ }).click()
  await expect(page.getByText('Nothing done waiting on others.')).toBeVisible()
  await filter('To review').click()
  // Back on To review: the switch returns with the choice it had.
  await expect(reviewSwitch.getByRole('tab')).toHaveText(['All PRs', 'Just me as reviewer'])
  await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing done to review.')).toBeVisible()
  await page.getByRole('tab', { name: /^Reviewed/ }).click()
  await expect(page.getByText('Nothing reviewed to review.')).toBeVisible()
  await page.getByRole('tab', { name: /^On hold/ }).click()
  await expect(page.getByText('Nothing on hold to review.')).toBeVisible()
})

test('the PR queue filter survives a reload, kept in the URL and remembered', async ({ page, project }) => {
  const filter = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const hydration: string[] = []
  page.on('console', (m) => /hydrat/i.test(m.text()) && hydration.push(m.text()))
  await page.goto(`/projects/${project.id}/prs`)
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
  await filter('Waiting on others').click()
  await expect(page).toHaveURL(/[?&]filter=others(&|$)/)

  // A full load renders the filter in the URL, on the server and in the browser alike: the tab and the
  // list agree.
  await page.reload()
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByText('Nothing pending waiting on others.')).toBeVisible()

  // Without one in the URL, the filter this browser remembers comes back, and the URL says so.
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page).toHaveURL(/[?&]filter=others(&|$)/)
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing pending waiting on others.')).toBeVisible()

  // A link that names one wins over what is remembered.
  await page.goto(`/projects/${project.id}/prs?filter=me`)
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()
  await page.reload()
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()
  expect(hydration).toEqual([])
})

test('the To review switch survives a reload, kept in the URL and remembered', async ({ page, project }) => {
  const filter = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const reviewSwitch = (name: string) => page.getByRole('tab', { name })
  const hydration: string[] = []
  page.on('console', (m) => /hydrat/i.test(m.text()) && hydration.push(m.text()))
  await page.goto(`/projects/${project.id}/prs`)
  await expect(reviewSwitch('All PRs')).toHaveAttribute('aria-selected', 'true')

  // Picked: in the URL (the filter with it) and in this browser.
  await reviewSwitch('Just me as reviewer').click()
  await expect(reviewSwitch('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/[?&]filter=me(&.*)?/)
  await expect(page).toHaveURL(/[?&]reviewer=mine(&|$)/)
  expect(await page.evaluate(() => localStorage.getItem('prs.reviewer'))).toBe('mine')

  // A full load renders the switch in the URL, on the server and in the browser alike.
  await page.reload()
  await expect(reviewSwitch('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/[?&]reviewer=mine(&|$)/)

  // Without one in the URL, the choice this browser remembers comes back, and the URL says so.
  await page.goto(`/projects/${project.id}/prs`)
  await expect(page).toHaveURL(/[?&]reviewer=mine(&|$)/)
  await expect(reviewSwitch('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')

  // A link that names one wins over what is remembered.
  await page.goto(`/projects/${project.id}/prs?reviewer=all`)
  await expect(reviewSwitch('All PRs')).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(reviewSwitch('All PRs')).toHaveAttribute('aria-selected', 'true')

  // Waiting on others has no switch, and keeps the choice in the URL for the return to To review.
  await page.goto(`/projects/${project.id}/prs?filter=others`)
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Just me as reviewer' })).toHaveCount(0)
  await expect(page).toHaveURL(/[?&]reviewer=mine(&|$)/)
  await filter('To review').click()
  await expect(reviewSwitch('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')

  // Both remembered, a visit that names neither: both are put back in the URL, together.
  await page.evaluate(() => {
    localStorage.setItem('prs.filter', 'others')
    localStorage.setItem('prs.reviewer', 'mine')
  })
  await page.goto(`/projects/${project.id}/prs`)
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/[?&]filter=others(&|$)/)
  await expect(page).toHaveURL(/[?&]reviewer=mine(&|$)/)
  await filter('To review').click()
  await expect(reviewSwitch('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')
  expect(hydration).toEqual([])
})

test('an old link or a remembered All filter lands on To review, with no error', async ({
  page,
  project,
}) => {
  const filter = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => (m.type() === 'error' || /hydrat/i.test(m.text())) && errors.push(m.text()))
  const landsOnToReview = async () => {
    await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
    await expect(filter('To review')).toHaveAttribute('aria-selected', 'true')
    await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'false')
    // `all` is no filter any more: the filter row holds its two sides, and To review's switch is
    // All PRs.
    const filterRow = page.getByRole('tablist').filter({ has: filter('To review') })
    await expect(filterRow.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Nothing pending to review.')).toBeVisible()
  }

  // A link from before: `all` is no filter any more, so the page shows the default.
  await page.goto(`/projects/${project.id}/prs?filter=all`)
  await landsOnToReview()

  // `all` remembered in this browser from before is not restored, and the URL does not take it.
  await page.evaluate(() => localStorage.setItem('prs.filter', 'all'))
  await page.goto(`/projects/${project.id}/prs`)
  await landsOnToReview()
  await expect(page).not.toHaveURL(/filter=all/)
  await page.reload()
  await landsOnToReview()
  await expect(page).not.toHaveURL(/filter=all/)

  // An old link, with a filter this browser remembers: that one.
  await page.evaluate(() => localStorage.setItem('prs.filter', 'others'))
  await page.goto(`/projects/${project.id}/prs?filter=all`)
  await expect(page).toHaveURL(/[?&]filter=others(&|$)/)
  await expect(filter('Waiting on others')).toHaveAttribute('aria-selected', 'true')
  await expect(filter('To review')).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByText('Nothing pending waiting on others.')).toBeVisible()
  expect(errors).toEqual([])
})

/**
 * A row of the PR queue as the API answers it. e2e has no GitHub, so the queue is empty unless a test
 * answers `GET /api/projects/:id/prs` itself.
 */
function prRow(
  projectId: number,
  n: number,
  waitingOn: PrRow['waitingOn'],
  status: PrRow['status'],
  requested = false,
): PrRow {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: n,
    projectId,
    repoId: null,
    repo: null,
    ticket: null,
    number: n,
    title: `PR ${n} ${waitingOn} ${status}`,
    url: `https://github.com/example/repo/pull/${n}`,
    author: waitingOn === 'me' ? 'someone' : 'me',
    headRef: `branch-${n}`,
    baseRef: 'main',
    headSha: 'abcdef0123456789',
    isDraft: false,
    reviewDecision: null,
    myReview: 'none',
    requested,
    waitingOn,
    reviewStage: status === 'reviewed' ? 'reviewed' : 'pending',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    merge: 'clean',
    mergeCheck: { source: 'github', at, base: 'main', outdated: false },
    ci: 'none',
    updatedAt: at,
    fetchedAt: at,
    open: status !== 'done',
    mergedAt: status === 'done' ? at : null,
    closedAt: status === 'done' ? at : null,
    hold: status === 'on_hold',
    holdNote: '',
    localCiSha: null,
    leftAs: null,
    status,
    latestReview: null,
    tickets: [],
    mergeAfter: [],
  }
}

/** Answers the queue with `rows` in place of the real one (empty without GitHub). */
async function stubQueue(page: Page, projectId: number, rows: PrRow[]) {
  await page.route(
    (url) => url.pathname === `/api/projects/${projectId}/prs`,
    (route) => route.fulfill({ json: rows }),
  )
}

test('the PR queue counts what still waits, stage by stage, and narrows To review to my requested reviews', async ({
  page,
  project,
}) => {
  // To review: pending ×2 (one requested of me), on hold ×1 (requested), reviewed ×1, done ×1
  // (requested). Waiting on others: pending ×1, on hold ×1, reviewed ×1, done ×1.
  await stubQueue(page, project.id, [
    prRow(project.id, 1, 'me', 'pending', true),
    prRow(project.id, 2, 'me', 'pending'),
    prRow(project.id, 3, 'me', 'on_hold', true),
    prRow(project.id, 4, 'me', 'reviewed'),
    prRow(project.id, 5, 'me', 'done', true),
    prRow(project.id, 6, 'others', 'pending'),
    prRow(project.id, 7, 'others', 'on_hold'),
    prRow(project.id, 8, 'others', 'reviewed'),
    prRow(project.id, 9, 'others', 'done'),
  ])
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const count = (name: string) => tab(name).locator('span')
  const listed = page.getByRole('tabpanel').getByRole('link', { name: /^#\d+ PR / })
  const stages = async (filter: string, expected: Record<string, readonly number[]>) => {
    for (const [stage, numbers] of Object.entries(expected)) {
      const at = `${filter} ${stage}`
      await expect(count(stage), at).toHaveText(String(numbers.length))
      await tab(stage).click()
      await expect(listed, at).toHaveText(numbers.map((n) => new RegExp(`^#${n} PR `)))
      if (!numbers.length)
        await expect(
          page.getByText(`Nothing ${stage.toLowerCase()} ${filter.toLowerCase()}.`),
          at,
        ).toBeVisible()
    }
  }

  await page.goto(`/projects/${project.id}/prs`)
  // Each counter is its tab's Pending + On hold rows: Reviewed and Done are listed but not counted.
  await expect(count('To review')).toHaveText('3')
  await expect(count('Waiting on others')).toHaveText('2')
  await stages('To review', { Pending: [1, 2], Reviewed: [4], 'On hold': [3], Done: [5] })

  // Waiting on others has no switch: its counter and every chip count the whole side.
  await tab('Waiting on others').click()
  await expect(count('Waiting on others')).toHaveText('2')
  await expect(page.getByRole('tab', { name: 'All PRs' })).toHaveCount(0)
  await stages('Waiting on others', { Pending: [6], Reviewed: [8], 'On hold': [7], Done: [9] })

  // Just me as reviewer: the list, every chip and the counter narrow together, in one move.
  await tab('To review').click()
  await tab('Just me as reviewer').click()
  await expect(tab('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')
  await expect(count('To review')).toHaveText('2')
  await stages('To review', { Pending: [1], Reviewed: [], 'On hold': [3], Done: [5] })

  // All PRs again: back to the whole side.
  await tab('All PRs').click()
  await expect(count('To review')).toHaveText('3')
  await stages('To review', { Pending: [1, 2], Reviewed: [4], 'On hold': [3], Done: [5] })
})

test('Just me as reviewer with no review requested shows Nothing pending to review', async ({
  page,
  project,
}) => {
  await stubQueue(page, project.id, [
    prRow(project.id, 1, 'me', 'pending'),
    prRow(project.id, 2, 'me', 'on_hold'),
    prRow(project.id, 3, 'others', 'pending'),
  ])
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const count = (name: string) => tab(name).locator('span')

  await page.goto(`/projects/${project.id}/prs?filter=me&reviewer=mine`)
  await expect(tab('Just me as reviewer')).toHaveAttribute('aria-selected', 'true')
  // The narrowed side has nothing left: every chip and the counter say so, and the list its text.
  await expect(count('To review')).toHaveText('0')
  for (const stage of ['Pending', 'Reviewed', 'On hold', 'Done']) {
    await tab(stage).click()
    await expect(count(stage), stage).toHaveText('0')
    await expect(page.getByText(`Nothing ${stage.toLowerCase()} to review.`), stage).toBeVisible()
  }
  await tab('Pending').click()
  await expect(page.getByText('Nothing pending to review.')).toBeVisible()
})

test('the PR queue stage tabs and filter fit every width from 375 to 1440px without scrolling', async ({
  page,
  project,
}) => {
  // Two-digit counts in every stage of both filters, wider than most queues get.
  let n = 0
  const rows = (['me', 'others'] as const).flatMap((waitingOn) =>
    (['pending', 'reviewed', 'on_hold', 'done'] as const).flatMap((status) =>
      Array.from({ length: 12 }, () => prRow(project.id, ++n, waitingOn, status)),
    ),
  )
  await stubQueue(page, project.id, rows)
  // Each row group as its tab row draws it, with the count each tab reads (none on the switch).
  const tabs: { names: string[]; count?: string }[] = [
    { names: ['Pending', 'Reviewed', 'On hold', 'Done'], count: '12' },
    // Pending + On hold: what each counter counts.
    { names: ['To review', 'Waiting on others'], count: '24' },
    { names: ['All PRs', 'Just me as reviewer'] },
  ]
  const tabRows = tabs.map((t) => ({
    ...t,
    list: page
      .getByRole('tablist')
      .filter({ has: page.getByRole('tab', { name: new RegExp(`^${t.names[0]}`) }) }),
  }))

  await page.goto(`/projects/${project.id}/prs`)
  for (const width of [375, 390, 440, 640, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const { names, count, list } of tabRows) {
      const at = `${width}px ${names[0]}`
      // The list and each box around it up to the page's main: nothing overflows the list, nothing
      // around it is pushed sideways, and none of them scrolls.
      const boxes = await list.evaluate((list) => {
        const out = []
        for (let e: Element | null = list; e && e.tagName !== 'MAIN'; e = e.parentElement) {
          const s = getComputedStyle(e)
          out.push({
            el: `${e.tagName.toLowerCase()}.${e.className}`,
            sideways: e.scrollWidth - e.clientWidth,
            down: e.scrollHeight - e.clientHeight,
            scroller: [s.overflowX, s.overflowY].some((o) => o === 'auto' || o === 'scroll'),
          })
        }
        return out
      })
      expect(boxes[0]!.sideways, at).toBeLessThanOrEqual(0)
      expect(boxes[0]!.down, at).toBeLessThanOrEqual(0)
      for (const b of boxes) {
        expect(b.sideways, `${at} ${b.el}`).toBeLessThanOrEqual(0)
        expect(b.scroller && b.down > 0, `${at} ${b.el}`).toBe(false)
      }
      for (const name of names) {
        const tab = list.getByRole('tab', { name: new RegExp(`^${name}`) })
        await expect(tab, `${at} ${name}`).toHaveText(
          count === undefined ? new RegExp(`^${name}$`) : new RegExp(`^${name}\\s*${count}$`),
        )
        await expect(tab, `${at} ${name}`).toBeInViewport({ ratio: 1 })
        expect(await tab.evaluate((e) => e.scrollWidth <= e.clientWidth), `${at} ${name}`).toBe(true)
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `${width}px`,
    ).toBe(true)
  }
})

test('edits the project instructions with the rich editor', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/instructions`)
  const section = page.getByRole('region', { name: 'Project instructions' })
  await section.getByRole('button', { name: 'No instructions yet. Click to write them.' }).click()
  const editor = section.getByRole('textbox', { name: 'Project instructions' })
  await expect(editor).toBeFocused()
  await expect(section.getByText('No changes.')).toBeVisible()
  await section.getByRole('button', { name: 'Heading' }).click()
  await page.keyboard.type('Running it')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Use pnpm, never npm.')
  await expect(section.getByText('Unsaved changes. Ctrl/⌘+Enter saves.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(editor).toBeHidden()
  await expect(section.getByRole('heading', { name: 'Running it' })).toBeVisible()
  const saved = '## Running it\n\nUse pnpm, never npm.'
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).instructions).toBe(saved)

  // Unsaved changes are not dropped by accident: Cancel asks first; Keep editing keeps them, Discard
  // goes back to the saved text.
  await section.getByRole('button', { name: 'edit' }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.type(' Always.')
  await section.getByRole('button', { name: 'Cancel' }).click()
  const ask = page.getByRole('alertdialog')
  await expect(ask).toContainText('Discard your changes?')
  await ask.getByRole('button', { name: 'Keep editing' }).click()
  await expect(ask).toBeHidden()
  await expect(editor).toContainText('Use pnpm, never npm. Always.')
  await section.getByRole('button', { name: 'Cancel' }).click()
  await ask.getByRole('button', { name: 'Discard' }).click()
  await expect(editor).toBeHidden()
  await expect(section).not.toContainText('Always.')
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).instructions).toBe(saved)
})

test('Esc in the instructions editor asks once and waits for an answer', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/instructions`)
  const section = page.getByRole('region', { name: 'Project instructions' })
  await section.getByRole('button', { name: 'No instructions yet. Click to write them.' }).click()
  const editor = section.getByRole('textbox', { name: 'Project instructions' })
  await expect(editor).toBeFocused()
  await page.keyboard.type('A first draft.')

  await page.keyboard.press('Escape')
  const ask = page.getByRole('alertdialog')
  await expect(ask).toContainText('Discard your changes?')
  // The same Esc used to reach the dialog as it opened and close it again at once.
  await page.waitForTimeout(500)
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Keep editing' }).click()
  await expect(ask).toBeHidden()
  await expect(editor).toContainText('A first draft.')

  await editor.click()
  await page.keyboard.press('Escape')
  await expect(ask).toContainText('Discard your changes?')
  await page.waitForTimeout(500)
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Discard' }).click()
  await expect(editor).toBeHidden()
  await expect(
    section.getByRole('button', { name: 'No instructions yet. Click to write them.' }),
  ).toBeVisible()
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).instructions).toBe('')

  // With nothing changed, Esc just closes the editor.
  await section.getByRole('button', { name: 'No instructions yet. Click to write them.' }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  await expect(ask).toBeHidden()
})

test('the human adds the default agents; an agent gets 403 doing it', async ({ page, project, agent }) => {
  const refused = await agent.post(`/api/projects/${project.id}/agents/defaults`, { data: {} })
  expect(refused.status()).toBe(403)

  await page.goto(`/projects/${project.id}/agents`)
  await expect(page.getByText('No agents yet.')).toBeVisible()
  const defaults = page.getByRole('region', { name: 'Default agents' })
  await defaults.getByRole('button', { name: 'Add the default agents' }).click()
  await expect(page.getByText(`Added ${DEFAULT_AGENT_NAMES.join(', ')}`)).toBeVisible()
  await expect(defaults.getByText('All added')).toBeVisible()
  for (const name of DEFAULT_AGENT_NAMES)
    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible()

  const after = await ok<Project>(agent.get(`/api/projects/${project.id}`))
  expect(after.agents.map((a) => a.name).sort()).toEqual([...DEFAULT_AGENT_NAMES].sort())
})
