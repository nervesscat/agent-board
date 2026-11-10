import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import type { Page } from '@playwright/test'

import type { RunConfig, TicketFull, TicketRuns, Workspace } from '#/lib/api'
import { e2eEnv, git } from './env'
import { BOARD_RUNS, expect, ok, test } from './fixtures'
import { addRun } from './runs'

/*
 * A running preview shown inside CrossBoard (the embedded window): from a ticket's Runs card and from the
 * Previews page, with its title, reload, URL, Copy link and Open in browser, over the board while it is
 * navigated, full screen on a phone. The desktop app frames it in a real embedded browser view; the web
 * build, as here, in an iframe of the preview's path on the board's own origin.
 */

const FAKE_PREVIEW = `node -e "require('http').createServer((q, r) => r.end('fake preview')).listen(process.env.PORT, '127.0.0.1')"`

/** A server on this machine that answers, as an agent's preview would; closed when the test ends. */
async function answering() {
  const server = http.createServer((_req, res) => res.end('a preview'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A git worktree of the run's repo, next to it, on a branch of its own. */
function worktreeOf(name: string) {
  const branch = `e2e-${name}`
  const worktree = path.join(e2eEnv().root, `wt-${name}`)
  git('worktree', 'add', '-q', '-b', branch, worktree, 'main')
  return { worktree, branch }
}

const windowOf = (page: Page) => page.getByRole('region', { name: 'Preview window' })

test(
  'a running preview opens inside the board from its Runs card, stays as the board moves, and opens in a browser too',
  BOARD_RUNS,
  async ({ page, human, project }) => {
    test.setTimeout(120_000)
    const repo = project.repos[0]!
    const { worktree, branch } = worktreeOf(`${project.id}-embedded`)
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Try it inside', status: 'in_progress', branch },
      }),
    )
    const ws = await ok<Workspace>(
      human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'wt', branch, path: worktree } }),
    )
    const run: RunConfig = await addRun(human, repo.id, { name: 'Fake preview', start: FAKE_PREVIEW })
    const state = async () =>
      (await ok<TicketRuns>(human.get(`/api/tickets/${t.id}/runs`))).repos[0]!.runs.find(
        (r) => r.name === 'Fake preview',
      )!.state
    try {
      expect((await human.post(`/api/workspaces/${ws.id}/runs/${run.id}/start`)).status()).toBe(202)
      await expect.poll(async () => (await state())?.status, { timeout: 40_000 }).toBe('running')
      const url = (await state())!.url!

      await page.goto(`/projects/${project.id}/features/${t.id}`)
      const card = page.getByRole('region', { name: 'Runs' })
      const row = card.getByRole('listitem', { name: 'Fake preview' })
      await expect(row.getByTestId('run-status')).toHaveText('Running')

      // Open: the preview in the window, over the board, on its own URL.
      await row.getByRole('button', { name: 'Open', exact: true }).click()
      const win = windowOf(page)
      await expect(win).toBeVisible()
      await expect(win.getByTestId('preview-title')).toHaveText(`#${t.id} Try it inside`)
      const frame = win.getByTestId('preview-frame')
      await expect(frame).toHaveAttribute('src', url)
      // The preview itself answers in the frame, inside the board.
      await expect(page.frameLocator('[data-testid="preview-frame"]').getByText('fake preview')).toBeVisible()
      // Open in browser, for a tab (or another device); the URL the window shows.
      const browser = win.getByTestId('preview-open-browser')
      await expect(browser).toHaveAttribute('href', url)
      await expect(browser).toHaveAttribute('target', '_blank')
      await expect(win.getByTestId('preview-url')).toHaveValue(url)

      // It stays while the board moves on, and the run keeps going: the window starts and stops nothing.
      await page.getByRole('navigation').getByRole('link', { name: 'Previews', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews`))
      await expect(windowOf(page)).toBeVisible()
      await expect(page.getByTestId('preview-frame')).toHaveAttribute('src', url)

      // Reload loads it again; close takes the window away, not the run.
      await page.getByTestId('preview-reload').click()
      await expect(page.frameLocator('[data-testid="preview-frame"]').getByText('fake preview')).toBeVisible()
      await page.getByTestId('preview-close').click()
      await expect(windowOf(page)).toHaveCount(0)
      expect((await state())?.status).toBe('running')

      // With sign-in on the run is also proxied on the board's own origin. The test board has sign-in
      // off (so it proxies nothing): the proxy URL is put on the run's state, the shape a signed-in
      // board gives it, and the window loads and opens that path.
      const proxied = `http://localhost:47100/p/${ws.id}/${run.id}/`
      await page.route('**/api/tickets/*/runs', async (route) => {
        const res = await route.fetch()
        const body = (await res.json()) as TicketRuns
        for (const r of body.repos.flatMap((x) => x.runs))
          if (r.state?.status === 'running') r.state.proxyUrl = proxied
        await route.fulfill({ response: res, json: body })
      })
      await page.goto(`/projects/${project.id}/features/${t.id}`)
      await row.getByRole('button', { name: 'Open', exact: true }).click()
      await expect(windowOf(page).getByTestId('preview-frame')).toHaveAttribute(
        'src',
        `/p/${ws.id}/${run.id}/`,
      )
      await expect(windowOf(page).getByTestId('preview-open-browser')).toHaveAttribute('href', proxied)
      await expect(windowOf(page).getByTestId('preview-url')).toHaveValue(proxied)
    } finally {
      await human.post(`/api/tickets/${t.id}/runs/stop`)
    }
  },
)

test('the Previews page opens a link preview inside the board, and a second one adds a tab', async ({
  page,
  human,
  project,
}) => {
  const first = await answering()
  const second = await answering()
  try {
    const preview = async (title: string, name: string, url: string) => {
      const t = await ok<TicketFull>(
        human.post(`/api/projects/${project.id}/tickets`, {
          data: { title, status: 'in_progress' },
        }),
      )
      await ok<Workspace>(
        human.post(`/api/tickets/${t.id}/workspaces`, {
          data: { name, previewUrl: url },
        }),
      )
    }
    await preview('First preview', 'feature-one', first.url)
    await preview('Second preview', 'feature-two', second.url)

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/projects/${project.id}/previews?stage=_all`)
    const rows = page.getByRole('region', { name: /^(Running|Not running)$/ }).getByRole('listitem')
    await rows.filter({ hasText: 'First preview' }).getByRole('button', { name: 'Open' }).click()

    const win = windowOf(page)
    await expect(win.getByTestId('preview-frame')).toHaveAttribute('src', first.url)
    await expect(page.frameLocator('[data-testid="preview-frame"]').getByText('a preview')).toBeVisible()
    // One preview: no tab strip over it.
    await expect(win.getByRole('tab')).toHaveCount(0)

    // A second preview: its own tab, showing.
    await rows.filter({ hasText: 'Second preview' }).getByRole('button', { name: 'Open' }).click()
    await expect(win.getByRole('tab')).toHaveCount(2)
    await expect(win.getByRole('tab', { selected: true })).toHaveText('feature-two')
    await expect(win.getByTestId('preview-frame')).toHaveAttribute('src', second.url)

    // The first tab switches back, and Copy link copies what the window shows.
    await win.getByRole('tab', { name: 'feature-one' }).click()
    await expect(win.getByTestId('preview-frame')).toHaveAttribute('src', first.url)
    await win.getByTestId('preview-copy').click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Link copied' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(first.url)

    // Closing the tab showing leaves the other one, alone in the window; closing it closes the window.
    await win.getByTestId('preview-close').click()
    await expect(win).toBeVisible()
    await expect(win.getByTestId('preview-title')).toContainText('Second preview')
    await expect(win.getByTestId('preview-frame')).toHaveAttribute('src', second.url)
    await win.getByTestId('preview-close').click()
    await expect(windowOf(page)).toHaveCount(0)
  } finally {
    await first.close()
    await second.close()
  }
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('a preview opens full screen with a close button', async ({ page, human, project }) => {
    const live = await answering()
    try {
      const t = await ok<TicketFull>(
        human.post(`/api/projects/${project.id}/tickets`, {
          data: { title: 'A preview on a phone', status: 'in_progress' },
        }),
      )
      await ok<Workspace>(
        human.post(`/api/tickets/${t.id}/workspaces`, {
          data: { name: 'wt', previewUrl: live.url },
        }),
      )
      await page.goto(`/projects/${project.id}/previews?stage=_all`)
      await page.getByRole('button', { name: 'Open', exact: true }).tap()

      const win = windowOf(page)
      await expect(win).toBeVisible()
      const box = await win.boundingBox()
      expect(Math.round(box!.width)).toBe(390)
      expect(Math.round(box!.height)).toBe(844)
      await expect(win.getByRole('button', { name: 'Close preview window' })).toBeVisible()
      await win.getByRole('button', { name: 'Close preview window' }).tap()
      await expect(win).toHaveCount(0)
    } finally {
      await live.close()
    }
  })
})
