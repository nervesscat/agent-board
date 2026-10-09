import type { Page } from '@playwright/test'

import type { TicketFull, TicketGit } from '#/lib/api'
import { commitFile, git } from './env'
import { expect, ok, test } from './fixtures'

/** What the Branch and Workspaces cards said, at every change of the page from now on. */
const recordCards = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames_: { branch: string; workspaces: string }[] }
    w.frames_ = []
    const card = (title: string) =>
      [...document.querySelectorAll('section')].find((s) =>
        s.querySelector(':scope > h2')?.textContent?.startsWith(title),
      )?.textContent ?? ''
    const note = () => w.frames_.push({ branch: card('Branch'), workspaces: card('Workspaces') })
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true })
    note()
  })
const recorded = (page: Page) =>
  page.evaluate(() => (window as unknown as { frames_: { branch: string; workspaces: string }[] }).frames_)

test('the ticket page shows a ticket’s git state only under that ticket, and at once when it has it', async ({
  page,
  project,
  human,
}) => {
  // Two tickets of the same column, each on a branch of its own with its own commit and workspace.
  const make = async (what: string) => {
    const branch = `e2e-${project.id}-${what}`
    const sha = commitFile('main', `${what}.txt`, `${what}\n`, `${what} commit`)
    git('update-ref', `refs/heads/${branch}`, sha)
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: `Ticket ${what}`, status: 'in_progress', branch },
      }),
    )
    await ok(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: `ws-${what}`, branch } }))
    // The board reads the checkout's refs a few seconds at a time: wait until it sees the branch.
    await expect
      .poll(async () => (await ok<TicketGit>(human.get(`/api/tickets/${t.id}/git`))).info.sha)
      .toBe(sha)
    return { t, branch, sha: sha.slice(0, 7), workspace: `ws-${what}` }
  }
  const a = await make('alpha')
  const b = await make('beta')
  const step = page.getByRole('link', { name: /^(Previous|Next) ticket in / })
  const branchCard = page.getByRole('heading', { level: 2, name: /^Branch/ }).locator('..')

  await page.goto(`/projects/${project.id}/features/${a.t.id}`)
  await expect(branchCard).toContainText(a.sha)
  await expect(step).toBeVisible()

  // To B, not visited yet: its git state answers first, while A is still on screen.
  const isPath = (p: string) => (url: URL) => url.pathname === p
  const bGit = page.waitForResponse((r) => isPath(`/api/tickets/${b.t.id}/git`)(new URL(r.url())))
  await page.route(isPath(`/api/tickets/${b.t.id}`), async (route) => {
    await bGit
    await page.waitForTimeout(500)
    await route.continue()
  })
  await recordCards(page)
  await step.click()
  await expect(branchCard).toContainText(b.branch)
  await expect(branchCard).toContainText(b.sha)
  const frames = await recorded(page)
  // A stayed on screen while B's git state was already there.
  expect(frames.some((f) => f.branch.includes(a.branch))).toBe(true)
  for (const f of frames) {
    if (f.branch.includes(a.branch)) {
      expect(f.branch).not.toContain(b.sha)
      expect(f.workspaces).not.toContain(b.workspace)
    }
    if (f.branch.includes(b.branch)) {
      expect(f.branch).not.toContain(a.sha)
      expect(f.workspaces).not.toContain(a.workspace)
    }
  }

  // Back to A: what the tab has shows in the first frame, while its git state is read again.
  await page.route(isPath(`/api/tickets/${a.t.id}/git`), async (route) => {
    await page.waitForTimeout(3_000)
    await route.continue()
  })
  await recordCards(page)
  await step.click()
  await expect(branchCard).toContainText(a.sha, { timeout: 1_000 })
  const first = (await recorded(page)).find((f) => f.branch.includes(a.branch))
  expect(first?.branch).toContain(a.sha)
  expect(first?.branch).toContain('vs base')
  expect(first?.workspaces).toContain(a.workspace)
})
