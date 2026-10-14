import path from 'node:path'

import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { Attachment, CleanupReport, PrRow, ReviewResult, TicketFull } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { MAX_TAG_LENGTH } from '#/lib/tags'
import { AGENT, e2eEnv, git, HUMAN } from './env'
import { pdf, png } from './files'
import { expect, expectTooltip, ok, test, tooltip } from './fixtures'

/*
 * Every hover tooltip is the app's shared one (`[data-slot="tooltip-content"]`), never a native title:
 * it shows the same text on hover and on keyboard focus, keeps line breaks, leaves the elements as they
 * were, and works on triggers that are also something else's (a dialog's, a select's, a tab).
 */

/** Every tooltip in the page, open or on its way out. */
const anyTooltip = (page: Page) => page.locator('[data-slot="tooltip-content"]')

/** Longer than the tooltips' open delay: a tooltip that has not opened by then is not opening. */
const PAST_THE_DELAY = 1000

/** Rests the pointer on `target` for longer than the open delay, and expects no tooltip at all. */
async function expectNoTooltip(target: Locator) {
  const page = target.page()
  await page.mouse.move(0, 0)
  await target.hover()
  await page.waitForTimeout(PAST_THE_DELAY)
  await expect(anyTooltip(page)).toHaveCount(0)
}

const tagOf = (l: Locator) => l.evaluate((el) => el.tagName.toLowerCase())

/** Elements with a native title, leaving out what users write (`.prose`) and the PDF frame. */
const nativeTitles = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[title]')]
      .filter((el) => !el.closest('.prose') && el.tagName !== 'IFRAME')
      .map((el) => el.outerHTML.slice(0, 160)),
  )

/** Whether the open tooltip is drawn over everything at its middle (a dialog, a backdrop). */
const onTop = (page: Page) =>
  tooltip(page).evaluate((el) => {
    // It lets the pointer through, so hit-testing skips it: let it take hits for this one look.
    const outer = el.parentElement as HTMLElement
    const before = outer.style.pointerEvents
    outer.style.pointerEvents = 'auto'
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    outer.style.pointerEvents = before
    return el.contains(hit)
  })

/** The open tooltip keeps its text inside the bubble, at most the bubble's width, and on screen. */
async function expectWrappedOnScreen(page: Page) {
  const fits = await tooltip(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    return {
      inside: r.left >= 0 && r.right <= clientWidth && r.top >= 0 && r.bottom <= clientHeight,
      width: r.width,
      overflows: el.scrollWidth > el.clientWidth + 1,
    }
  })
  expect(fits.inside).toBe(true)
  expect(fits.overflows).toBe(false)
  // At most the bubble's width (max-w-xs, 20rem).
  expect(fits.width).toBeLessThanOrEqual(320)
}

/** Presses Tab until `target` has the focus, the way a person reaches it from the keyboard. */
async function tabTo(target: Locator) {
  const page = target.page()
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

/** The board, as columns. */
async function board(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}/features?view=board`)
  return (status: string, title: RegExp) =>
    page.locator(`[data-column="${status}"]`).getByRole('link', { name: title })
}

/** A post on the ticket by the human, not marked as progress, with a picture. */
async function postWithPicture(human: APIRequestContext, ticketId: number, body: string) {
  const file = await ok<Attachment>(
    human.post('/api/uploads', {
      multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: png(40) } },
    }),
  )
  await ok(
    human.post(`/api/tickets/${ticketId}/updates`, {
      data: { body, attachmentIds: [file.id], progress: false },
    }),
  )
}

/** A row of the PR queue as the API answers it (e2e has no GitHub). */
function prRow(projectId: number, n: number, extra: Partial<PrRow> = {}): PrRow {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    id: n,
    projectId,
    repoId: null,
    repo: null,
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/example/repo/pull/${n}`,
    author: 'someone',
    headRef: `branch-${n}`,
    baseRef: 'main',
    headSha: 'abcdef0123456789',
    isDraft: false,
    reviewDecision: null,
    myReview: 'none',
    waitingOn: 'me',
    reviewStage: 'pending',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    merge: 'clean',
    mergeCheck: { source: 'github', at, base: 'main', outdated: false },
    ci: 'none',
    updatedAt: at,
    fetchedAt: at,
    open: true,
    mergedAt: null,
    closedAt: null,
    hold: false,
    holdNote: '',
    status: 'pending',
    latestReview: null,
    tickets: [],
    mergeAfter: [],
    ...extra,
  }
}

const stubQueue = (page: Page, projectId: number, rows: PrRow[]) =>
  page.route(
    (url) => url.pathname === `/api/projects/${projectId}/prs`,
    (route) => route.fulfill({ json: rows }),
  )

test('hovering shows what the title said, and each element stays what it was, with its name', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const t = await api.ticket({ title: 'Hover over me', status: 'in_progress' })
  await postWithPicture(human, t.id, 'A post to act on.')
  await ok(human.post(`/api/tickets/${t.id}/tasks`, { data: { tasks: ['One task'] } }))
  await ok(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'sandbox', branch: 'sb' } }))
  const byAgent = await ok<TicketFull>(
    agent.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Opened by an agent' } }),
  )

  // A board card: still one link, with no button inside, its title in the tooltip.
  const card = (await board(page, project.id))('in_progress', /Hover over me/)
  await expectTooltip(card, 'Hover over me')
  expect(await tagOf(card)).toBe('a')
  await expect(card.getByRole('button')).toHaveCount(0)

  // The ticket page.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const openedBy = page.locator('span').filter({ hasText: /^opened by / })
  const actor = openedBy.locator('span[data-slot="tooltip-trigger"]')
  await expectTooltip(actor, `${HUMAN} (you, signed in with a passkey)`)
  expect(await tagOf(actor)).toBe('span')
  await expect(openedBy.getByRole('button')).toHaveCount(0)

  // The post's actions: the same buttons, by the same names, each with its tooltip.
  const post = page.getByRole('article').filter({ hasText: 'A post to act on.' })
  const actions = post.getByRole('group', { name: 'Post actions' })
  expect(await actions.getByRole('button').evaluateAll((all) => all.map((b) => b.ariaLabel))).toEqual([
    'reply',
    'mark progress',
    'edit',
    'delete',
  ])
  for (const [name, tip] of [
    ['reply', 'Reply'],
    ['mark progress', 'Mark as progress'],
    ['edit', 'Edit'],
    ['delete', 'Delete'],
  ])
    await expectTooltip(actions.getByRole('button', { name, exact: true }), tip)

  // The New post editor's toolbar.
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' }).first()
  await expectTooltip(toolbar.getByRole('button', { name: 'Attach files' }), 'Attach files')
  await expectTooltip(toolbar.getByRole('button', { name: 'Bold', exact: true }), 'Bold')

  // Icon buttons whose only name was their title keep it as their name.
  const sectionOf = (heading: string) =>
    page.getByRole('heading', { name: heading, exact: true }).locator('xpath=ancestor::section[1]')
  // A task's remove button is named by its task (the tooltip says what it removes).
  const removeTask = sectionOf('Tasks').getByRole('button', { name: 'Remove One task', exact: true })
  await expect(removeTask).toHaveAccessibleName('Remove One task')
  await expectTooltip(removeTask, 'remove')
  const removeWorkspace = sectionOf('Workspaces').getByRole('button', { name: 'remove', exact: true })
  await expect(removeWorkspace).toHaveAccessibleName('remove')
  await expectTooltip(removeWorkspace, 'remove')

  // An agent's name.
  await page.goto(`/projects/${project.id}/features/${byAgent.id}`)
  await expectTooltip(
    page
      .locator('span')
      .filter({ hasText: /^opened by / })
      .locator('span[data-slot="tooltip-trigger"]'),
    `${AGENT} (agent, gate token)`,
  )

  // The project's agents: icon buttons named as their tooltips say.
  const name = DEFAULT_AGENT_NAMES[0]
  await page.goto(`/projects/${project.id}/agents`)
  const edit = page.getByRole('button', { name: 'Edit', exact: true }).first()
  await expect(edit).toHaveAccessibleName('Edit')
  await expectTooltip(edit, 'Edit')
  const remove = page.getByRole('button', { name: `Remove ${name}` })
  await expect(remove).toHaveAccessibleName(`Remove ${name}`)
  await expectTooltip(remove, `Remove ${name}`)
})

test('keyboard focus opens the same tooltip as hover, and leaving or Escape closes it', async ({
  page,
  api,
  human,
  project,
}) => {
  // The top bar's Home link, the first stop of the page.
  await page.goto('/')
  await page.keyboard.press('Tab')
  const home = page.getByRole('banner').getByRole('link').first()
  await expect(home).toBeFocused()
  await expect(tooltip(page)).toHaveText('Home')
  await page.keyboard.press('Escape')
  await expect(tooltip(page)).toHaveCount(0)
  await expect(home).toBeFocused()

  // A post's edit, then delete: one tooltip at a time, gone when the focus leaves.
  const t = await api.ticket({ title: 'By keyboard' })
  await postWithPicture(human, t.id, 'Reached by keyboard.')
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await page.keyboard.press('Tab')
  const actions = page.getByRole('group', { name: 'Post actions' })
  const edit = actions.getByRole('button', { name: 'edit', exact: true })
  await edit.focus()
  await expect(tooltip(page)).toHaveText('Edit')
  await page.keyboard.press('Tab')
  await expect(actions.getByRole('button', { name: 'delete', exact: true })).toBeFocused()
  await expect(tooltip(page)).toHaveText('Delete')
  await page.keyboard.press('Tab')
  await expect(tooltip(page)).toHaveCount(0)

  // The editor's toolbar, reached with Tab from the text in the New ticket dialog.
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Title')).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.type('x')
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Attach files' })).toBeFocused()
  await expect(tooltip(page)).toHaveText('Attach files')
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
  await expect(tooltip(page)).toHaveText('Bold')
  await page.keyboard.press('Shift+Tab')
  await expect(tooltip(page)).toHaveText('Attach files')
})

test('a tooltip of several lines keeps them, each on its own row', async ({ page, api, human, project }) => {
  const base = await api.ticket({ title: 'Foundation', status: 'todo' })
  const t = await api.ticket({ title: 'Built on it', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { needs: [base.id] } }))

  const card = (await board(page, project.id))('in_progress', /Built on it/)
  const needs = card.locator('span[data-slot="tooltip-trigger"]').filter({ hasText: `needs #${base.id}` })
  await expectTooltip(needs, `Merge first:\n#${base.id} Foundation: not done, no branch`)
  // The rows its text is drawn on.
  const lines = await tooltip(page).evaluate((el) => {
    const tops = new Set<number>()
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) if (r.width) tops.add(Math.round(r.top))
    }
    return tops.size
  })
  expect(lines).toBe(2)

  await stubQueue(page, project.id, [
    prRow(project.id, 9, {
      mergeAfter: [
        {
          ticketId: base.id,
          title: 'Foundation',
          repoId: 1,
          number: 7,
          url: 'https://github.com/example/repo/pull/7',
        },
        { ticketId: t.id, title: 'Built on it', repoId: 1, number: 8, url: null },
      ],
    }),
  ])
  await page.goto(`/projects/${project.id}/prs`)
  const mergeAfter = page.locator('span[data-slot="tooltip-trigger"]').filter({ hasText: /merge after/ })
  await expectTooltip(
    mergeAfter,
    `Its ticket needs these merged first:\nPR #7 (from #${base.id} Foundation)\nPR #8 (from #${t.id} Built on it)`,
  )
})

test('a trigger that also opens a dialog, a select or a tab shows its tooltip and still does that', async ({
  page,
  api,
  human,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const t = await api.ticket({ title: 'Finished', status: 'done' })
  await postWithPicture(human, t.id, 'A post with a picture.')

  // Archive all, on the Done column.
  await board(page, project.id)
  const archiveAll = page.getByRole('button', { name: 'Archive all' })
  await expectTooltip(archiveAll, 'Archive the 1 ticket in Done')
  await archiveAll.click()
  await expect(page.getByRole('alertdialog')).toContainText('Archive 1 ticket?')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)

  // A post's delete.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const remove = page.getByRole('group', { name: 'Post actions' }).getByRole('button', { name: 'delete' })
  await expectTooltip(remove, 'Delete')
  await remove.click()
  await expect(page.getByRole('alertdialog')).toContainText('Delete this post?')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep' }).click()

  // The gallery's close.
  await page.getByRole('img', { name: 'shot.png' }).click()
  const gallery = page.getByRole('dialog')
  const close = gallery.getByRole('button', { name: 'Close (Esc)' })
  await expectTooltip(close, 'Close (Esc)')
  await close.click()
  await expect(gallery).toHaveCount(0)

  // A stage's kind, in the stages editor.
  await page.goto(`/projects/${project.id}/settings`)
  const kind = page.getByRole('combobox').filter({ hasText: 'Open' }).first()
  await expectTooltip(kind, 'waiting to be picked up; claiming moves it to the first active stage')
  await kind.click()
  await expect(page.getByRole('option', { name: 'Active' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option')).toHaveCount(0)

  // An agent's remove.
  const name = DEFAULT_AGENT_NAMES[0]
  await page.goto(`/projects/${project.id}/agents`)
  const removeAgent = page.getByRole('button', { name: `Remove ${name}` })
  await expectTooltip(removeAgent, `Remove ${name}`)
  await removeAgent.click()
  await expect(page.getByRole('alertdialog')).toContainText(`Remove ${name}?`)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep' }).click()

  // A PR filter.
  await page.goto(`/projects/${project.id}/prs`)
  const waiting = page.getByRole('tab', { name: /^Waiting on others/ })
  await expectTooltip(
    waiting,
    "Your PRs (agents' too): pending approvals, approved by every reviewer, or on hold on their comments",
  )
  await waiting.click()
  await expect(waiting).toHaveAttribute('aria-selected', 'true')

  // A review result in the daily log opens in its dialog.
  await ok(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: { prNumber: 3, sha: 'abcdef0123456789', verdict: 'SHIP IT', summaryMd: 'Looks right.' },
    }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  // The day's activity opens folded by the hour.
  await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).click()
  const result = page.getByRole('button', { name: /SHIP IT/ })
  await expectTooltip(result, 'Open the review result')
  await result.click()
  await expect(page.getByRole('dialog')).toContainText('Looks right.')
})

test('a tooltip with nothing to say shows no bubble', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('Tags (optional)')
  const chips = input.locator('..').locator(':scope > span')
  await input.fill('High,')
  await expect(chips).toHaveText(['High'])
  // The chip's name, away from its remove button.
  await expectNoTooltip(chips.first().getByText('High'))

  const long = 'x'.repeat(MAX_TAG_LENGTH + 1)
  await input.fill(`${long},`)
  await expect(chips).toHaveCount(2)
  await expectTooltip(chips.nth(1).getByText(long), `More than ${MAX_TAG_LENGTH} characters`)

  // A PR's draft badge has no tooltip; its merge state has.
  await stubQueue(page, project.id, [prRow(project.id, 4, { isDraft: true })])
  await page.goto(`/projects/${project.id}/prs`)
  await expectNoTooltip(page.locator('[data-slot="tooltip-trigger"]').filter({ hasText: /^draft$/ }))
  await expectTooltip(
    page.locator('[data-slot="tooltip-trigger"]').filter({ hasText: /^mergeable$/ }),
    /^No conflicts with the base\. GitHub's word as of .+\.$/,
  )
})

test('a button disabled for a reason says why on hover, and stays disabled', async ({
  page,
  human,
  project,
}) => {
  // Reports off: no report for claude to write.
  await page.goto(`/projects/${project.id}/daily`)
  const generate = page.getByRole('button', { name: 'Generate with claude' })
  await expect(generate).toBeDisabled()
  await expectTooltip(generate.locator('..'), 'Reports are off: set a cadence in the report settings first')
  await expect(generate).toBeDisabled()

  // The gallery's zoom out, before any zoom.
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'A picture' } }),
  )
  await postWithPicture(human, t.id, 'Zoom it.')
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await page.getByRole('img', { name: 'shot.png' }).click()
  const gallery = page.getByRole('dialog')
  const zoomOut = gallery.getByRole('button', { name: 'Zoom out (-)' })
  await expect(zoomOut).toBeDisabled()
  await expectTooltip(zoomOut.locator('..'), 'Zoom out (-)')
  await expect(zoomOut).toBeDisabled()
  await expect(gallery.getByText('100%')).toBeVisible()
  // On top of the gallery, not under it.
  expect(await onTop(page)).toBe(true)
  const zoomIn = gallery.getByRole('button', { name: 'Zoom in (+)' })
  await expectTooltip(zoomIn.locator('..'), 'Zoom in (+)')
  expect(await onTop(page)).toBe(true)

  // A report that must be a file, before one is attached.
  await ok(
    human.patch(`/api/projects/${project.id}/report-settings`, {
      data: { cadence: 'daily', format: 'file' },
    }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  const panel = page.getByRole('region', { name: 'Report', exact: true })
  await panel.getByRole('button', { name: 'post the report' }).click()
  const post = panel.getByRole('button', { name: 'Post', exact: true })
  await expect(post).toBeDisabled()
  await expectTooltip(post.locator('..'), 'Attach the report file first')
  await expect(post).toBeDisabled()
  // With the file it can be posted, and there is nothing left to explain.
  await panel
    .locator('input[type="file"]')
    .setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf('Daily report') })
  await expect(post).toBeEnabled()
  await expectNoTooltip(post.locator('..'))
})

test('the folder picker says why Up is off at the top folder, over its dialog', async ({ page }) => {
  await page.goto('/repositories')
  await page.getByRole('button', { name: 'New repository' }).click()
  await page.getByRole('button', { name: 'Browse…' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose the checkout' })
  const up = picker.getByRole('button', { name: 'Up one folder' })
  const folder = picker.getByRole('textbox', { name: 'Folder path' })
  // In the home folder, where there is a folder above.
  await expect(up).toBeEnabled()
  await expectTooltip(up.locator('..'), 'Up one folder')
  expect(await onTop(page)).toBe(true)
  await expectTooltip(picker.getByRole('button', { name: 'Home' }), 'Home')
  expect(await onTop(page)).toBe(true)

  // The top of the drive (the filesystem's root elsewhere): nothing above it.
  await folder.fill('/')
  await folder.press('Enter')
  await expect(up).toBeDisabled()
  const top = await folder.inputValue()
  await expectTooltip(up.locator('..'), 'Up one folder')
  expect(await onTop(page)).toBe(true)
  await up.click({ force: true })
  await expect(up).toBeDisabled()
  await expect(folder).toHaveValue(top)
})

// A dialog opened from the keyboard puts the focus on its first control, focus-visible: on a tooltip's
// trigger, the tooltip would open with the dialog, and the first Escape would close only the tooltip.

test('the gallery opened from the keyboard shows no tooltip, and one Escape closes it', async ({
  page,
  api,
  human,
  project,
}) => {
  // From a picture on a post: the gallery's first buttons have tooltips.
  const t = await api.ticket({ title: 'Opened by keyboard' })
  await postWithPicture(human, t.id, 'A picture to open.')
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const picture = page.getByRole('link', { name: 'shot.png' })
  await tabTo(picture)
  await page.keyboard.press('Enter')
  const gallery = page.getByRole('dialog', { name: 'shot.png' })
  await expect(gallery).toBeVisible()
  await page.waitForTimeout(PAST_THE_DELAY)
  await expect(tooltip(page)).toHaveCount(0)
  await expect(gallery).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(gallery).toHaveCount(0)
  await expect(picture).toBeFocused()
})

test('the folder picker opened from the keyboard shows no tooltip, and one Escape closes it', async ({
  page,
}) => {
  // From the repository dialog: Up and Home, with their tooltips, come before the path.
  await page.goto('/repositories')
  await page.getByRole('button', { name: 'New repository' }).click()
  const repo = page.getByRole('dialog', { name: 'New repository' })
  const browse = repo.getByRole('button', { name: 'Browse…' })
  await tabTo(browse)
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'Choose the checkout' })
  await expect(picker).toBeVisible()
  await page.waitForTimeout(PAST_THE_DELAY)
  await expect(tooltip(page)).toHaveCount(0)
  // The picker itself has the focus, not Up or Home, nor the path further on.
  await expect(picker).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(repo).toBeVisible()
  await expect(browse).toBeFocused()

  // Tab from there reaches its first control, and that tooltip shows: the person moved the focus.
  await page.keyboard.press('Enter')
  await expect(picker).toBeFocused()
  const up = picker.getByRole('button', { name: 'Up one folder' })
  await expect(up).toBeEnabled()
  await page.keyboard.press('Tab')
  await expect(up).toBeFocused()
  await expect(tooltip(page)).toHaveText('Up one folder')
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })

  test('the folder picker opened by a tap focuses itself, not a text field, and shows no tooltip', async ({
    page,
  }) => {
    // Focus on the path's text field would raise a phone's keyboard, unasked.
    await page.goto('/repositories')
    await page.getByRole('button', { name: 'New repository' }).tap()
    const repo = page.getByRole('dialog', { name: 'New repository' })
    await repo.getByRole('button', { name: 'Browse…' }).tap()
    const picker = page.getByRole('dialog', { name: 'Choose the checkout' })
    await expect(picker).toBeVisible()
    await page.waitForTimeout(PAST_THE_DELAY)
    await expect(picker).toBeFocused()
    expect(
      await page.evaluate(() => document.activeElement?.matches('input, textarea, [contenteditable]')),
    ).toBe(false)
    await expect(tooltip(page)).toHaveCount(0)
  })
})

test('a review result opened from the keyboard shows no tooltip, and one Escape closes it', async ({
  page,
  human,
  project,
}) => {
  // With a reply: once loaded, it opens on the reply's own buttons, which have tooltips.
  const result = await ok<ReviewResult>(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: { prNumber: 4, sha: 'abcdef0123456789', verdict: 'SHIP IT', summaryMd: 'Opened by keyboard.' },
    }),
  )
  await ok(
    human.post('/api/comments', { data: { parentType: 'review', parentId: result.id, body: 'Agreed.' } }),
  )
  await page.goto(`/projects/${project.id}/daily`)
  // The day's activity opens folded by the hour.
  await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).click()
  const open = page.getByRole('button', { name: /SHIP IT/ })
  await tabTo(open)
  const dialog = page.getByRole('dialog', { name: 'Review result' })
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Enter')
    await expect(dialog.getByText('Agreed.')).toBeVisible()
    await page.waitForTimeout(PAST_THE_DELAY)
    await expect(tooltip(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(open).toBeFocused()
  }
})

test('a long review result with replies opens at its top, every time, by click or by keyboard', async ({
  page,
  human,
  project,
}) => {
  // No link in the summary: the first control is a reply's own button, which has a tooltip, and the
  // reply editor is at the bottom. Cached from the second open on, it is all there as it opens.
  const result = await ok<ReviewResult>(
    human.post(`/api/projects/${project.id}/reviews/results`, {
      data: {
        prNumber: 5,
        sha: 'abcdef0123456789',
        verdict: 'SHIP IT',
        summaryMd: 'Nothing to follow here.',
      },
    }),
  )
  for (let n = 1; n <= 4; n++) {
    const body = Array.from({ length: 6 }, (_, i) => `Reply ${n}, paragraph ${i + 1}.`).join('\n\n')
    await ok(human.post('/api/comments', { data: { parentType: 'review', parentId: result.id, body } }))
  }
  await page.goto(`/projects/${project.id}/daily`)
  // The day's activity opens folded by the hour.
  await page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Open all' }).click()
  const open = page.getByRole('button', { name: /SHIP IT/ })
  const dialog = page.getByRole('dialog', { name: 'Review result' })
  for (const by of ['click', 'keyboard'] as const) {
    for (let i = 0; i < 2; i++) {
      const at = `${by}, open ${i + 1}`
      if (by === 'click') await open.click()
      else {
        await tabTo(open)
        await page.keyboard.press('Enter')
      }
      await expect(dialog.getByText('Reply 4, paragraph 6.')).toBeVisible()
      await page.waitForTimeout(PAST_THE_DELAY)
      const box = await dialog.evaluate((el) => ({
        top: el.scrollTop,
        scrolls: el.scrollHeight > el.clientHeight,
      }))
      expect(box.scrolls, at).toBe(true)
      expect(box.top, at).toBe(0)
      await expect(dialog.getByRole('heading', { name: 'Review result' })).toBeInViewport()
      await expect(dialog.getByText('Nothing to follow here.')).toBeInViewport()
      // Never in the reply editor. The first open focuses before the result is there (on Close);
      // from then on a reply's button comes first, so the dialog itself.
      expect(await page.evaluate(() => !!document.activeElement?.closest('[contenteditable]')), at).toBe(
        false,
      )
      if (i > 0) await expect(dialog, at).toBeFocused()
      await expect(tooltip(page)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  }
})

test('nested tooltips: the innermost shows, the outer one on its own part, never two at once', async ({
  page,
  api,
  agent,
  human,
}) => {
  const base = await api.ticket({ title: 'Below', status: 'todo' })
  const t = await api.ticket({ title: 'Above', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { needs: [base.id] } }))
  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Halfway there' } }))
  const at = (await api.getTicket(t.id)).resume.at!
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // "by <author> <when>": the author's own tooltip on the name, the time's on the rest of the line.
  const line = page.getByRole('region', { name: 'Resume here' }).getByText(/^by /)
  const author = line.locator('span[data-slot="tooltip-trigger"]')
  await expectTooltip(author, `${AGENT} (agent, gate token)`)
  await expect(anyTooltip(page)).toHaveCount(1)
  const when = await page.evaluate(
    (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
    at,
  )
  // From the name onto "by", the line's own text.
  await line.hover({ position: { x: 2, y: 6 } })
  await expect(tooltip(page)).toHaveText(when)
  await expect(tooltip(page)).toHaveCount(1)
  await author.hover()
  await expect(tooltip(page)).toHaveText(`${AGENT} (agent, gate token)`)
  await expect(tooltip(page)).toHaveCount(1)

  // A need's chip, and its remove button inside it.
  const chip = page
    .getByRole('region', { name: 'Details' })
    .getByRole('listitem')
    .filter({ hasText: 'Below' })
  const removeNeed = chip.getByRole('button', { name: `Remove the need for #${base.id}` })
  await expectTooltip(removeNeed, `Remove the need for #${base.id}`)
  await expect(tooltip(page)).toHaveCount(1)
  await expectTooltip(chip.getByRole('link'), `#${base.id} Below: not done, no branch`)
  await expect(tooltip(page)).toHaveCount(1)
})

test("nested tooltips on a board card: a badge's or a name's own, the card's title around them", async ({
  page,
  api,
  human,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const name = DEFAULT_AGENT_NAMES[0]
  const base = await api.ticket({ title: 'Underneath', status: 'todo' })
  const t = await api.ticket({ title: 'On the card', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { needs: [base.id], assignee: name } }))

  const card = (await board(page, project.id))('in_progress', /On the card/)
  const needs = card.locator('span[data-slot="tooltip-trigger"]').filter({ hasText: `needs #${base.id}` })
  const needsTip = `Merge first:\n#${base.id} Underneath: not done, no branch`
  const actor = card.locator('span[data-slot="tooltip-trigger"]').filter({ hasText: name })
  const actorTip = `${name} (one of the project's agents)`
  await expectTooltip(needs, needsTip)
  await expect(tooltip(page)).toHaveCount(1)
  // From the badge onto the card's own padding, and back: one bubble each time, the one under the pointer.
  await card.hover({ position: { x: 4, y: 4 } })
  await expect(tooltip(page)).toHaveText('On the card')
  await expect(tooltip(page)).toHaveCount(1)
  await needs.hover()
  await expect(tooltip(page)).toHaveText(needsTip)
  await expect(tooltip(page)).toHaveCount(1)
  // The assignee's name, and from it onto the card.
  await actor.hover()
  await expect(tooltip(page)).toHaveText(actorTip)
  await expect(tooltip(page)).toHaveCount(1)
  await card.hover({ position: { x: 4, y: 4 } })
  await expect(tooltip(page)).toHaveText('On the card')
  await expect(tooltip(page)).toHaveCount(1)

  // On the ticket, the reserved chip inside the Assignee label; the label itself says nothing.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const label = page.getByRole('region', { name: 'Details' }).locator('label[for="assignee"]')
  const reserved = label.locator('span[data-slot="tooltip-trigger"]')
  await expect(reserved).toHaveText('reserved')
  await expectTooltip(
    reserved,
    'Reserved for this project agent: other agents cannot take it, only you can reassign it',
  )
  await expect(tooltip(page)).toHaveCount(1)
  await expectNoTooltip(label.getByText('Assignee'))
})

test('a long unbroken text wraps inside its tooltip, on screen', async ({ page, api, project }) => {
  const title = `Long${'x'.repeat(150)}`
  await api.ticket({ title, status: 'todo' })
  const card = (await board(page, project.id))('todo', new RegExp(title))
  await expectTooltip(card, title)
  await expectWrappedOnScreen(page)
})

test('a truncated path or URL shows in full in its tooltip, wrapped on screen', async ({
  page,
  human,
  project,
}) => {
  const { root } = e2eEnv()
  // A finished ticket whose branch is still checked out, in a folder with a long unbroken name.
  const branch = `e2e-${project.id}-leftover`
  const folder = `wt-${project.id}-${'x'.repeat(100)}`
  git('worktree', 'add', '-q', '-b', branch, path.join(root, folder), 'main')
  const done = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Left a worktree', status: 'done', branch },
    }),
  )
  // The path as git lists it (forward slashes on Windows), which is what the page shows.
  const report = await ok<CleanupReport>(human.get(`/api/projects/${project.id}/cleanup?reach=0`))
  const worktree = report.tickets.find((t) => t.id === done.id)!.branches[0]!.worktrees[0]!.path
  expect(worktree).toContain(folder)

  await page.goto(`/projects/${project.id}/cleanup`)
  const cell = page
    .getByRole('row')
    .filter({ hasText: 'Left a worktree' })
    .locator('div[data-slot="tooltip-trigger"]')
    .filter({ hasText: folder })
  // Cut short on the page (the path's own text, beside the icon), whole in the tooltip.
  const shown = cell.getByText(worktree, { exact: true })
  expect(await shown.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expectTooltip(cell, worktree)
  await expectWrappedOnScreen(page)

  // The Preview card's link, on a ticket.
  const url = `http://localhost:9/${'p'.repeat(150)}`
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Has a preview' } }),
  )
  await ok(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'preview', previewUrl: url } }))
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const link = page
    .getByRole('region', { name: 'Preview' })
    .locator('div[data-slot="tooltip-trigger"]')
    .filter({ hasText: url })
  expect(await link.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expectTooltip(link, url)
  await expectWrappedOnScreen(page)
})

test("a tooltip in the projects' dialog shows over it", async ({ page, project }) => {
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('button', { name: 'Project' }).click()
  await page.getByText('Manage projects…').click()
  const dialog = page.getByRole('dialog')
  const remove = dialog.getByRole('button', { name: `Delete ${project.name}` })
  await expect(remove).toHaveAccessibleName(`Delete ${project.name}`)
  await expectTooltip(remove, `Delete ${project.name}`)
  expect(await onTop(page)).toBe(true)
  await remove.click()
  await expect(page.getByRole('alertdialog')).toContainText(`Delete ${project.name}?`)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep' }).click()
})

test('a card dragged to another column moves, and leaves no tooltip behind', async ({
  page,
  api,
  project,
}) => {
  const t = await api.ticket({ title: 'Drag me', status: 'todo' })
  const card = await board(page, project.id)
  await expectTooltip(card('todo', /Drag me/), 'Drag me')
  await card('todo', /Drag me/).dragTo(page.locator('[data-column="in_progress"]'))
  await expect(card('in_progress', /Drag me/)).toBeVisible()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('in_progress')
  await page.mouse.move(0, 0)
  await expect(anyTooltip(page)).toHaveCount(0)
})

test("the Previews page's hints are tooltips: the limit's use, a row's state, link and workspace", async ({
  page,
  api,
  human,
  project,
}) => {
  const t = await api.ticket({ title: 'Hosted elsewhere', status: 'in_progress' })
  const url = 'https://example.com/hosted-preview'
  await ok(
    human.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'hosted', branch: 'feat/hosted', path: 'somewhere', previewUrl: url },
    }),
  )
  await page.goto(`/projects/${project.id}/previews`)
  await expectTooltip(page.locator('#previews-stage'), 'Shows the previews of the tickets in this stage')
  // The stage filter starts on the review stage, where this ticket (in progress) is not: All stages lists it.
  await page.getByRole('combobox', { name: 'Stage' }).click()
  await page.getByRole('option', { name: /^All stages \d+$/ }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expectTooltip(
    page.getByText(/^Board-run previews: \d+ of \d+ in use \(board-wide\)$/),
    'Previews the board builds or runs, in every project, and how many it runs at most at once',
  )
  const row = page.getByRole('listitem').filter({ hasText: 'Hosted elsewhere' })
  // A link off this machine is never checked, and its badge says why.
  await expectTooltip(
    row.getByText('Not checked', { exact: true }),
    'The board checks links on this machine only',
  )
  await expectTooltip(row.locator('div[data-slot="tooltip-trigger"]').filter({ hasText: url }), url)
  await expectTooltip(row.getByText('feat/hosted', { exact: true }), 'workspace hosted in somewhere')
  expect(await nativeTitles(page)).toEqual([])
})

test('no native title is left on the main pages', async ({ page, api, human, project }) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const t = await api.ticket({ title: 'Everything on it', status: 'in_progress' })
  await postWithPicture(human, t.id, 'A post with a picture.')
  await ok(human.post(`/api/tickets/${t.id}/tasks`, { data: { tasks: ['One task'] } }))
  await ok(
    human.post(`/api/tickets/${t.id}/workspaces`, {
      data: { name: 'sandbox', branch: 'sb', previewUrl: 'https://example.com/sandbox' },
    }),
  )
  await stubQueue(page, project.id, [
    prRow(project.id, 5, { isDraft: true, ci: 'failing', merge: 'conflicts' }),
    prRow(project.id, 6, {
      mergeAfter: [{ ticketId: t.id, title: 'Everything on it', repoId: 1, number: 5, url: null }],
    }),
  ])
  for (const url of [
    '/',
    `/projects/${project.id}`,
    `/projects/${project.id}/features?view=board`,
    `/projects/${project.id}/features?view=list`,
    `/projects/${project.id}/features/${t.id}`,
    `/projects/${project.id}/prs`,
    `/projects/${project.id}/previews`,
    `/projects/${project.id}/cleanup`,
    `/projects/${project.id}/agents`,
    `/projects/${project.id}/settings`,
    `/projects/${project.id}/daily`,
  ]) {
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    expect(await nativeTitles(page), url).toEqual([])
  }
})
