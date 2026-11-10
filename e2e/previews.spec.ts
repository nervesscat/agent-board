import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import type { APIRequestContext, Page } from '@playwright/test'

import type { ManagedPreview, ProjectPreview, ProjectPreviews, TicketFull, Workspace } from '#/lib/api'
import { END_BUILD as END, e2eEnv, git } from './env'
import { BOARD_RUNS, expect, expectTooltip, ok, seedProject, test } from './fixtures'
import { boardPreview } from './runs'

/** A server on this machine that answers, as a branch an agent runs would; closed when the test ends. */
async function answering() {
  const server = http.createServer((_req, res) => res.end('a preview'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A port nothing listens on: free a moment ago. */
async function closedPort() {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** Whether anything accepts a connection on the port. */
const listens = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

/** A git worktree of the run's repo, next to it, on a branch of its own. */
function worktreeOf(name: string) {
  const { root } = e2eEnv()
  const branch = `e2e-${name}`
  const worktree = path.join(root, `wt-${name}`)
  git('worktree', 'add', '-q', '-b', branch, worktree, 'main')
  return { worktree, branch }
}

/**
 * A worktree that reads as a checkout of the board with its dependencies installed, and whose build
 * never ends: the board starts it for real, and it stays building until it is stopped. `end()` makes
 * the build exit by itself as well: a stop on Windows (`taskkill /T`) can miss a process its tree starts
 * at that very moment, and a build left behind would outlive the run. Every test calls it as it ends.
 */
function buildingWorktree(name: string) {
  const { worktree, branch } = worktreeOf(name)
  const lock = "lockfileVersion: '9.0'\n"
  fs.writeFileSync(
    path.join(worktree, 'package.json'),
    JSON.stringify({
      name: 'agent-board',
      private: true,
      scripts: {
        build: `node -e "setInterval(() => { if (require('fs').existsSync('${END}')) process.exit() }, 200)"`,
      },
    }),
  )
  fs.writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), lock)
  fs.mkdirSync(path.join(worktree, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'node_modules', '.pnpm', 'lock.yaml'), lock)
  return { worktree, branch, end: () => fs.writeFileSync(path.join(worktree, END), '') }
}

/**
 * `node <worktree>/server.cjs`, started from the worktree as an agent's `pnpm dev` would be: a server
 * the board may stop. Killed when the test ends if it still runs.
 */
async function serveFrom(worktree: string) {
  const file = path.join(worktree, 'server.cjs')
  fs.writeFileSync(
    file,
    "const s = require('node:http').createServer((q, r) => r.end('a preview'))\n" +
      "s.listen(0, '127.0.0.1', () => process.stdout.write(s.address().port + '\\n'))\n",
  )
  const child = spawn(process.execPath, [file], { cwd: worktree, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += String(d)
      const m = /^(\d+)\s*$/m.exec(out)
      if (m) resolve(Number(m[1]))
    })
    child.once('exit', () => reject(new Error(`the server exited before it listened: ${out}`)))
  })
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid!,
    exited,
    running: () => child.exitCode === null && child.signalCode === null,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
}

const register = (human: APIRequestContext, t: TicketFull, data: Record<string, string>) =>
  ok<Workspace>(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'wt', ...data } }))

/**
 * The rows of the page: the Running and Not running sections only (a banner of another test's project,
 * such as a report due soon, is a region of its own).
 */
const previewRows = (page: Page) =>
  page.getByRole('region', { name: /^(Running|Not running)$/ }).getByRole('listitem')

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

test('the Previews module opens from the sidebar, and says so when the project has none', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}`)
  const link = page.getByRole('navigation').getByRole('link', { name: 'Previews', exact: true })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Previews' })).toBeVisible()
  await expect(link).toHaveClass(/(^|\s)active(\s|$)/)
  await expect(page.getByText(/^No previews yet\./)).toBeVisible()
  await expect(previewRows(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Running', exact: true })).toHaveCount(0)
})

test("lists the project's previews, the running ones apart, each with its ticket, branch, link and Open", async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const live = await answering()
  try {
    const dead = `http://127.0.0.1:${await closedPort()}`
    const workspace = (t: TicketFull, data: Record<string, string>) =>
      ok<Workspace>(human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'wt', ...data } }))

    const a = await api.ticket({ title: 'Link that is down', status: 'in_progress' })
    await workspace(a, { branch: 'feat/down', previewUrl: dead })
    const b = await api.ticket({ title: 'Link that answers', status: 'in_progress' })
    await workspace(b, { branch: 'feat/up', previewUrl: live.url })
    const c = await api.ticket({ title: 'Worktree without a preview', status: 'in_progress' })
    await workspace(c, { branch: 'feat/none', path: 'somewhere' })
    const d = await api.ticket({ title: 'Shipped with a hosted link', status: 'in_progress' })
    await workspace(d, { name: 'hosted', previewUrl: 'https://example.com/x' })
    await ok(human.patch(`/api/tickets/${d.id}`, { data: { status: 'done' } }))
    // Another project's preview is never on this one's page.
    const other = await seedProject(human, `Other previews (${project.id})`)
    const elsewhere = await ok<TicketFull>(
      human.post(`/api/projects/${other.id}/tickets`, {
        data: { title: 'Another project preview', status: 'in_progress' },
      }),
    )
    await workspace(elsewhere, { previewUrl: 'https://example.com/elsewhere' })

    // Agents read it too.
    const listed = await ok<{ previews: ProjectPreview[] }>(agent.get(`/api/projects/${project.id}/previews`))
    expect(listed.previews.map((p) => p.ticket.title)).toEqual([
      'Link that answers',
      // The rest, most recent first.
      'Shipped with a hosted link',
      'Link that is down',
    ])

    await page.goto(`/projects/${project.id}/previews?stage=_all`)
    // The rows sit in the Running and Not running sections.
    const rows = previewRows(page)
    const row = (title: string) => rows.filter({ hasText: title })
    const running = page.getByRole('region', { name: 'Running', exact: true })
    const stopped = page.getByRole('region', { name: 'Not running' })
    await expect(running.getByRole('listitem')).toHaveCount(1)
    await expect(running.getByRole('listitem')).toContainText('Link that answers')
    await expect(running.getByRole('listitem')).toContainText(/Running/)
    await expect(stopped.getByRole('listitem')).toHaveCount(2)
    await expect(rows).toHaveCount(3)
    await expect(row('Worktree without a preview')).toHaveCount(0)
    await expect(row('Another project preview')).toHaveCount(0)

    const down = stopped.getByRole('listitem').filter({ hasText: 'Link that is down' })
    await expect(down).toContainText('Not running')
    await expect(down).toContainText('feat/down')
    await expect(down).toContainText(dead)
    await expect(down).toContainText('In progress')
    const open = down.getByRole('link', { name: 'Open in browser' })
    await expect(open).toHaveAttribute('href', dead)
    await expect(open).toHaveAttribute('target', '_blank')
    await expect(open).toHaveAttribute('rel', /\bnoreferrer\b/)
    // The same link opens inside the board; nothing for the board to run, so no Start or Stop.
    await expect(down.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(down.getByRole('button', { name: /^(Start|Stop|Restart)$/ })).toHaveCount(0)

    // A closed ticket's preview stays, with its stage; a link off this machine is never checked.
    const hosted = stopped.getByRole('listitem').filter({ hasText: 'Shipped with a hosted link' })
    await expect(hosted).toContainText('Done')
    await expect(hosted).toContainText('Not checked')
    await expect(hosted).not.toContainText(/Running|Not running/)
    await expect(hosted).toContainText('hosted')

    const ticketLink = down.getByRole('link', { name: `#${a.id} Link that is down` })
    await expect(ticketLink).toHaveAttribute('href', `/projects/${project.id}/features/${a.id}`)
    await ticketLink.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${a.id}$`))
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Link that is down')

    // The other project's page has its own.
    await page.goto(`/projects/${other.id}/previews?stage=_all`)
    await expect(rows).toHaveCount(1)
    await expect(row('Another project preview')).toBeVisible()
  } finally {
    await live.close()
  }
})

test('a project route that does not exist answers 404', async ({ human }) => {
  const res = await human.get('/api/projects/999999/previews')
  expect(res.status()).toBe(404)
})

// The previews the board runs count against one board-wide limit, which some of these change: one test
// at a time (with every other test that starts a run, BOARD_RUNS), and the limit back to 8 after each,
// so no other test's Start is refused.
test.describe('board-run previews and the preview limit', BOARD_RUNS, () => {
  test.describe.configure({ mode: 'serial' })

  const limitBack = (human: APIRequestContext) =>
    ok(human.patch('/api/settings', { data: { previewLimit: 8 } }))
  const inUse = (page: Page) => page.getByText(/^Board-run previews: \d+ of \d+ in use \(board-wide\)$/)

  test("Start, Restart and Stop on a row run the board's own preview of the worktree; a refusal comes up as a toast", async ({
    page,
    human,
    project,
  }) => {
    const { worktree, branch, end } = buildingWorktree(`${project.id}-previews`)
    await boardPreview(human, project)

    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Run it from here', status: 'in_progress', branch },
      }),
    )
    const dead = `http://127.0.0.1:${await closedPort()}`
    const ws = await ok<Workspace>(
      human.post(`/api/tickets/${t.id}/workspaces`, {
        data: { name: 'worktree', branch, path: worktree, previewUrl: dead },
      }),
    )
    const managed = async () =>
      (await ok<{ managed: ManagedPreview | null }>(human.get(`/api/workspaces/${ws.id}/preview`))).managed

    try {
      await page.goto(`/projects/${project.id}/previews?stage=_all`)
      const running = page.getByRole('region', { name: 'Running', exact: true })
      const stopped = page.getByRole('region', { name: 'Not running' })
      const row = stopped.getByRole('listitem').filter({ hasText: 'Run it from here' })
      await expect(row).toContainText('Not running')
      await expect(row.getByRole('button', { name: 'Stop' })).toHaveCount(0)

      // Start: the board builds it, and the row says so once the page asked again.
      await expectTooltip(
        row.getByRole('button', { name: 'Start', exact: true }),
        'Build this worktree and run it on a free port, with a fresh copy of the live data',
      )
      await row.getByRole('button', { name: 'Start', exact: true }).click()
      const building = running.getByRole('listitem').filter({ hasText: 'Run it from here' })
      await expect(building).toContainText('Building…')
      await expect(building).toContainText('building')
      await expect(building.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
      await expect(row).toHaveCount(0)
      await expect.poll(async () => (await managed())?.step).toBe('build')
      const first = (await managed())!
      expect(first).toMatchObject({ status: 'building', path: worktree })

      await expectTooltip(
        building.getByRole('button', { name: 'Stop' }),
        'Stop the preview and free its port',
      )
      await expectTooltip(
        building.getByRole('button', { name: 'Restart' }),
        'Stop it, build again and start it with a fresh copy of the data',
      )

      // Restart: stopped and started again, still building.
      await building.getByRole('button', { name: 'Restart' }).click()
      await expect
        .poll(async () => {
          const m = await managed()
          return m && m.startedAt !== first.startedAt && m.status === 'building'
        })
        .toBe(true)
      await expect(building).toContainText('Building…')

      // Stop: back with the rest, with who stopped it, and Start offered again.
      await building.getByRole('button', { name: 'Stop' }).click()
      await expect(row).toContainText('Stopped by enrique')
      await expect(building).toHaveCount(0)
      expect(await managed()).toMatchObject({ status: 'stopped', reason: 'stopped by enrique', pid: null })
      await expect(row.getByRole('button', { name: 'Start', exact: true })).toBeVisible()

      // The board refuses a start the page still offers (the ticket was finished meanwhile): its reason
      // comes up as a toast. Refreshed just before, so the page does not ask again in between.
      const refresh = page.getByRole('button', { name: 'Refresh' })
      await refresh.click()
      await expect(refresh).toBeEnabled()
      await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
      await row.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: 'the ticket is done' }),
      ).toBeVisible()
      expect(await managed()).toMatchObject({ status: 'stopped' })
    } finally {
      await human.post(`/api/workspaces/${ws.id}/preview/stop`)
      end()
    }
  })

  test('the page shows the board-wide use of the limit and sets it; a bad value is refused', async ({
    page,
    human,
    project,
  }) => {
    const { worktree, branch, end } = buildingWorktree(`${project.id}-limit`)
    await boardPreview(human, project)
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Counted against the limit', status: 'in_progress', branch },
      }),
    )
    const ws = await register(human, t, { branch, path: worktree, previewUrl: 'https://example.com/limit' })
    try {
      await page.goto(`/projects/${project.id}/previews?stage=_all`)
      await expect(inUse(page)).toHaveText('Board-run previews: 0 of 8 in use (board-wide)')
      const limit = page.getByLabel('Preview limit')
      await expect(limit).toHaveValue('8')

      await limit.fill('3')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(toast(page, 'Saved')).toBeVisible()
      await expect(inUse(page)).toHaveText('Board-run previews: 0 of 3 in use (board-wide)')
      expect(await ok<{ previewLimit: number }>(human.get('/api/settings'))).toMatchObject({
        previewLimit: 3,
      })

      // A start counts, in any project.
      await page
        .getByRole('region', { name: /^(Running|Not running)$/ })
        .getByRole('listitem')
        .filter({ hasText: 'Counted against the limit' })
        .getByRole('button', { name: 'Start', exact: true })
        .click()
      await expect(inUse(page)).toHaveText('Board-run previews: 1 of 3 in use (board-wide)')

      // 0 is refused: a toast, and the limit stays.
      await limit.fill('0')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible()
      expect(await ok<{ previewLimit: number }>(human.get('/api/settings'))).toMatchObject({
        previewLimit: 3,
      })
      await page.getByRole('button', { name: 'Refresh' }).click()
      await expect(inUse(page)).toHaveText('Board-run previews: 1 of 3 in use (board-wide)')
    } finally {
      await human.post(`/api/workspaces/${ws.id}/preview/stop`)
      end()
      await limitBack(human)
    }
  })

  test('at the limit, Start comes back as a toast that names it, and the row does not build', async ({
    page,
    human,
    project,
  }) => {
    const first = buildingWorktree(`${project.id}-first`)
    const second = buildingWorktree(`${project.id}-second`)
    await boardPreview(human, project)
    const ticketFor = (title: string, branch: string) =>
      ok<TicketFull>(
        human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress', branch } }),
      )
    const a = await register(human, await ticketFor('Already building', first.branch), {
      branch: first.branch,
      path: first.worktree,
    })
    const b = await register(human, await ticketFor('One too many', second.branch), {
      branch: second.branch,
      path: second.worktree,
      previewUrl: `http://127.0.0.1:${await closedPort()}`,
    })
    try {
      await ok(human.patch('/api/settings', { data: { previewLimit: 1 } }))
      expect((await human.post(`/api/workspaces/${a.id}/preview/start`)).status()).toBe(202)
      await page.goto(`/projects/${project.id}/previews?stage=_all`)
      await expect(inUse(page)).toHaveText('Board-run previews: 1 of 1 in use (board-wide)')
      const row = page
        .getByRole('region', { name: 'Not running' })
        .getByRole('listitem')
        .filter({ hasText: 'One too many' })
      await row.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(toast(page, 'at most 1')).toBeVisible()
      await expect(row).not.toContainText('Building…')
      const managed = await ok<{ managed: ManagedPreview | null }>(
        human.get(`/api/workspaces/${b.id}/preview`),
      )
      expect(managed.managed).toBeNull()
    } finally {
      await human.post(`/api/workspaces/${a.id}/preview/stop`)
      await human.post(`/api/workspaces/${b.id}/preview/stop`)
      first.end()
      second.end()
      await limitBack(human)
    }
  })

  test('the Settings page edits the same limit', async ({ page, human, project }) => {
    try {
      await page.goto('/settings')
      const limit = page.getByLabel('Preview limit')
      await expect(limit).toHaveValue('8')
      await limit.fill('4')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(toast(page, 'Saved')).toBeVisible()
      await page.goto(`/projects/${project.id}/previews`)
      await expect(inUse(page)).toHaveText(/of 4 in use/)
      await expect(page.getByLabel('Preview limit')).toHaveValue('4')
      // Out of range there too.
      await page.goto('/settings')
      await page.getByLabel('Preview limit').fill('33')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible()
      expect(await ok<{ previewLimit: number }>(human.get('/api/settings'))).toMatchObject({
        previewLimit: 4,
      })
    } finally {
      await limitBack(human)
    }
  })

  test('Stop all, after a confirmation, stops the board-run preview and the link it may, and says what it could not', async ({
    page,
    human,
    agent,
    project,
  }) => {
    const board = buildingWorktree(`${project.id}-stop-all`)
    await boardPreview(human, project)
    const linked = worktreeOf(`${project.id}-stop-all-link`)
    const server = await serveFrom(linked.worktree)
    const stranger = await answering()
    try {
      const ticketFor = (title: string) =>
        ok<TicketFull>(
          human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress' } }),
        )
      const managed = await register(human, await ticketFor('Run by the board'), {
        branch: board.branch,
        path: board.worktree,
      })
      expect((await human.post(`/api/workspaces/${managed.id}/preview/start`)).status()).toBe(202)
      await register(human, await ticketFor('Started by an agent'), {
        branch: linked.branch,
        path: linked.worktree,
        previewUrl: server.url,
      })
      const strangerTicket = await ticketFor('Not from its worktree')
      await register(human, strangerTicket, {
        branch: linked.branch,
        path: linked.worktree,
        previewUrl: stranger.url,
      })

      // Not the agents'.
      expect((await agent.post(`/api/projects/${project.id}/previews/stop`)).status()).toBe(403)
      expect(server.running()).toBe(true)

      await page.goto(`/projects/${project.id}/previews?stage=_all`)
      const running = page.getByRole('region', { name: 'Running', exact: true })
      const stopped = page.getByRole('region', { name: 'Not running' })
      await expect(running.getByRole('listitem')).toHaveCount(3)
      await page.getByRole('button', { name: 'Stop all' }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText('Stop every running preview of this project?')
      // Keep them: nothing stops.
      await dialog.getByRole('button', { name: 'Keep them' }).click()
      await expect(dialog).toHaveCount(0)
      expect(server.running()).toBe(true)

      await page.getByRole('button', { name: 'Stop all' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop all' }).click()
      await expect(
        toast(
          page,
          new RegExp(
            `^Stopped 2 · could not stop 1: #${strangerTicket.id} the process on :\\d+ \\(pid \\d+\\) does not run from`,
          ),
        ),
      ).toBeVisible()
      await server.exited
      expect(await listens(server.port)).toBe(false)
      await expect(stopped.getByRole('listitem').filter({ hasText: 'Run by the board' })).toContainText(
        'Stopped by enrique',
      )
      await expect(stopped.getByRole('listitem').filter({ hasText: 'Started by an agent' })).toContainText(
        'Not running',
      )
      // The one it could not stop still runs.
      await expect(running.getByRole('listitem')).toHaveCount(1)
      await expect(running.getByRole('listitem')).toContainText('Not from its worktree')
      expect(await listens(Number(new URL(stranger.url).port))).toBe(true)
    } finally {
      server.stop()
      await stranger.close()
      await human.post(`/api/projects/${project.id}/previews/stop`)
      board.end()
    }
  })
})

test("Stop on a link row stops the agent's server when it runs from the workspace's worktree; the link stays", async ({
  page,
  human,
  agent,
  project,
}) => {
  const { worktree, branch } = worktreeOf(`${project.id}-link`)
  const server = await serveFrom(worktree)
  try {
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Started by an agent', status: 'in_progress' },
      }),
    )
    const ws = await register(human, t, { branch, path: worktree, previewUrl: server.url })
    // The listing says the board may stop it; an agent may not.
    const listed = await ok<ProjectPreviews>(human.get(`/api/projects/${project.id}/previews`))
    expect(listed.previews.find((p) => p.workspace.id === ws.id)).toMatchObject({
      running: true,
      linkStop: null,
    })
    const refused = await agent.post(`/api/workspaces/${ws.id}/preview/stop-link`)
    expect(refused.status()).toBe(403)
    expect(server.running()).toBe(true)

    await page.goto(`/projects/${project.id}/previews?stage=_all`)
    const row = page
      .getByRole('region', { name: 'Running', exact: true })
      .getByRole('listitem')
      .filter({ hasText: 'Started by an agent' })
    await expect(row).toContainText('Running')
    await expect(row.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(row.getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', server.url)
    await expectTooltip(
      row.getByRole('button', { name: 'Stop', exact: true }),
      "Stop the server behind this link (it runs from the workspace's worktree) and free its port",
    )
    await row.getByRole('button', { name: 'Stop', exact: true }).click()

    // The process is gone and the port free; the row moves to Not running on its own, link and all.
    await server.exited
    expect(await listens(server.port)).toBe(false)
    const after = page
      .getByRole('region', { name: 'Not running' })
      .getByRole('listitem')
      .filter({ hasText: 'Started by an agent' })
    await expect(after).toContainText('Not running')
    await expect(after.getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', server.url)
    await expect(after.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    const ticket = await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))
    expect(ticket.workspaces.find((w) => w.id === ws.id)?.previewUrl).toBe(server.url)
  } finally {
    server.stop()
  }
})

test('a running link the board cannot tell runs from the worktree has no Stop, and says why', async ({
  page,
  human,
  project,
}) => {
  const { worktree, branch } = worktreeOf(`${project.id}-stranger`)
  // Served by this test's own process, which runs from nowhere near the worktree.
  const stranger = await answering()
  try {
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Not from its worktree', status: 'in_progress' },
      }),
    )
    await register(human, t, { branch, path: worktree, previewUrl: stranger.url })
    await page.goto(`/projects/${project.id}/previews?stage=_all`)
    const row = page
      .getByRole('region', { name: 'Running', exact: true })
      .getByRole('listitem')
      .filter({ hasText: 'Not from its worktree' })
    await expect(row).toContainText('Running')
    await expect(row).toContainText(
      new RegExp(
        `The board will not stop it: the process on :\\d+ \\(pid \\d+\\) does not run from .*wt-${project.id}-stranger`,
      ),
    )
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  } finally {
    await stranger.close()
  }
})

test('Refresh, and the page asking again on its own, pick up a preview registered meanwhile', async ({
  page,
  api,
  human,
  project,
}) => {
  const register = async (title: string) => {
    const t = await api.ticket({ title, status: 'in_progress' })
    await ok<Workspace>(
      human.post(`/api/tickets/${t.id}/workspaces`, {
        data: { name: 'hosted', previewUrl: `https://example.com/${t.id}` },
      }),
    )
  }
  // The page's timers run on a clock the test moves.
  await page.clock.install()
  await register('Registered first')
  await page.goto(`/projects/${project.id}/previews?stage=_all`)
  const rows = previewRows(page)
  await expect(rows).toHaveCount(1)

  // Nothing new shows before the page asks again...
  await register('Registered while the page is open')
  await page.clock.runFor('00:10')
  await expect(rows).toHaveCount(1)
  // ...and Refresh asks at once.
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(rows.filter({ hasText: 'Registered while the page is open' })).toBeVisible()
  await expect(rows).toHaveCount(2)

  // Without a click, the page asks again every 15 seconds.
  await register('Registered later still')
  await expect(rows).toHaveCount(2)
  await page.clock.fastForward('00:16')
  await expect(rows.filter({ hasText: 'Registered later still' })).toBeVisible()
  await expect(rows).toHaveCount(3)
})

// --- the Stage filter ---

const stageFilter = (page: Page) => page.getByRole('combobox', { name: 'Stage' })
/** What the Stage filter shows picked: the stage's name and its count. */
const shownStage = (page: Page) => stageFilter(page).locator('[data-slot="select-value"]')
/** An option of the open Stage filter, by its stage's name (its count follows the name). */
const stageOption = (page: Page, name: string) =>
  page.getByRole('option', { name: new RegExp(`^${name} \\d+$`) })
async function pickStage(page: Page, name: string) {
  await stageFilter(page).click()
  await stageOption(page, name).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}
const group = (page: Page, title: 'Running' | 'Not running') =>
  page.getByRole('region', { name: title, exact: true })

/** A ticket in the stage with a hosted link: a preview that is not running (never checked). */
async function hosted(human: APIRequestContext, projectId: number, title: string, status: string) {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${projectId}/tickets`, { data: { title, status } }),
  )
  await register(human, t, { previewUrl: `https://example.com/${t.id}` })
  return t
}

test('the Stage filter starts on In review, offers every stage in board order with its count, and filters the groups', async ({
  page,
  human,
  project,
}) => {
  const live = await answering()
  try {
    const working = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Running in progress', status: 'in_progress' },
      }),
    )
    await register(human, working, { previewUrl: live.url })
    const waiting = await hosted(human, project.id, 'Waiting for review', 'review')
    await hosted(human, project.id, 'Shipped one', 'done')
    await hosted(human, project.id, 'Shipped two', 'done')

    await page.goto(`/projects/${project.id}/previews`)
    // In review, without saying so in the URL.
    await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews$`))
    await expect(previewRows(page)).toHaveCount(1)
    await expect(group(page, 'Not running').getByRole('listitem')).toContainText('Waiting for review')
    await expect(group(page, 'Not running').getByRole('heading')).toHaveText('Not running · 1')
    await expect(group(page, 'Running')).toHaveCount(0)
    // The usage bar and Stop all are the project's: a preview runs, if not in this stage.
    await expect(page.getByRole('button', { name: 'Stop all' })).toBeVisible()

    // Every stage of the project, in board order, each with its previews; All stages with all of them.
    await stageFilter(page).click()
    const names = ['All stages', ...project.stages.map((s) => s.name)]
    const counts: Record<string, number> = { 'All stages': 4, 'In progress': 1, 'In review': 1, Done: 2 }
    await expect(page.getByRole('option')).toHaveText(
      names.map((n) => new RegExp(`^${n}\\s*${counts[n] ?? 0}$`)),
    )
    await expect(stageOption(page, 'In review')).toHaveAttribute('aria-selected', 'true')
    await stageOption(page, 'Done').click()

    // One stage at a time, in the URL.
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=done$`))
    await expect(shownStage(page)).toHaveText(/^Done\s*2$/)
    await expect(previewRows(page)).toHaveCount(2)
    await expect(previewRows(page).filter({ hasText: 'Waiting for review' })).toHaveCount(0)
    await expect(group(page, 'Not running').getByRole('heading')).toHaveText('Not running · 2')
    await stageFilter(page).click()
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1)
    await expect(stageOption(page, 'Done')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')

    await pickStage(page, 'All stages')
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=_all$`))
    await expect(group(page, 'Running').getByRole('heading')).toHaveText('Running · 1')
    await expect(group(page, 'Not running').getByRole('heading')).toHaveText('Not running · 3')
    // A reload keeps it.
    await page.reload()
    await expect(shownStage(page)).toHaveText(/^All stages\s*4$/)
    await expect(previewRows(page)).toHaveCount(4)

    // A link to a stage shows that stage.
    await page.goto(`/projects/${project.id}/previews?stage=in_progress`)
    await expect(shownStage(page)).toHaveText(/^In progress\s*1$/)
    await expect(group(page, 'Running').getByRole('listitem')).toHaveCount(1)
    await expect(group(page, 'Running').getByRole('listitem')).toContainText('Running in progress')
    await expect(group(page, 'Not running')).toHaveCount(0)

    // A ticket that moves on leaves the stage at the next fetch; the stage stays picked.
    await page.goto(`/projects/${project.id}/previews?stage=review`)
    await expect(previewRows(page)).toHaveCount(1)
    await ok(human.patch(`/api/tickets/${waiting.id}`, { data: { status: 'done' } }))
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.getByText('No previews in In review.')).toBeVisible()
    await expect(previewRows(page)).toHaveCount(0)
    await expect(shownStage(page)).toHaveText(/^In review\s*0$/)
    await stageFilter(page).click()
    await expect(stageOption(page, 'Done')).toHaveText(/^Done\s*3$/)
  } finally {
    await live.close()
  }
})

test('the Stage filter starts on the review stage by its kind, renamed or not, and on All stages when the project has none', async ({
  page,
  human,
  project,
}) => {
  await hosted(human, project.id, 'Waiting for review', 'review')
  await hosted(human, project.id, 'Being built', 'in_progress')
  const review = project.stages.find((s) => s.key === 'review')!
  await ok(
    human.patch(`/api/projects/${project.id}/stages/${review.id}`, { data: { name: 'Waiting for me' } }),
  )

  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^Waiting for me\s*1$/)
  await expect(previewRows(page)).toHaveCount(1)
  await expect(previewRows(page)).toContainText('Waiting for review')
  await stageFilter(page).click()
  await expect(stageOption(page, 'Waiting for me')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: /^In review/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // No stage of kind review any more: every preview shows.
  await ok(human.patch(`/api/projects/${project.id}/stages/${review.id}`, { data: { kind: 'active' } }))
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^All stages\s*2$/)
  await expect(previewRows(page)).toHaveCount(2)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews$`))
})

test('the last stage picked is remembered per project and restored on a visit without one; a stage gone or unknown is ignored', async ({
  page,
  human,
  project,
}) => {
  const hydration: string[] = []
  page.on('console', (m) => {
    if (/hydrat|did not match/i.test(m.text())) hydration.push(m.text())
  })
  await hosted(human, project.id, 'Waiting for review', 'review')
  await hosted(human, project.id, 'Shipped', 'done')
  const qa = await ok<{ id: number; key: string }>(
    human.post(`/api/projects/${project.id}/stages`, { data: { name: 'QA', kind: 'active' } }),
  )
  await hosted(human, project.id, 'Under QA', qa.key)
  const other = await seedProject(human, `Other stage filter (${project.id})`)
  await hosted(human, other.id, 'Elsewhere in review', 'review')

  // Nothing remembered: an unknown stage in the URL is none, so the default shows and the URL drops it.
  await page.goto(`/projects/${project.id}/previews?stage=nope`)
  await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  await expect(previewRows(page)).toHaveCount(1)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews$`))

  await pickStage(page, 'Done')
  await expect(page).toHaveURL(/\?stage=done$/)
  // A visit without a stage, a cold load: Done again, put in the URL.
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^Done\s*1$/)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=done$`))
  await expect(previewRows(page)).toHaveCount(1)
  await expect(previewRows(page)).toContainText('Shipped')
  // A stage the project does not have, in the URL: the remembered one.
  await page.goto(`/projects/${project.id}/previews?stage=nope`)
  await expect(shownStage(page)).toHaveText(/^Done\s*1$/)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=done$`))
  // From the sidebar too.
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('navigation').getByRole('link', { name: 'Previews', exact: true }).click()
  await expect(shownStage(page)).toHaveText(/^Done\s*1$/)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=done$`))

  // Another project keeps its own: its review stage.
  await page.goto(`/projects/${other.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  await expect(previewRows(page)).toContainText('Elsewhere in review')
  await expect(page).toHaveURL(new RegExp(`/projects/${other.id}/previews$`))

  // All stages is remembered as well.
  await page.goto(`/projects/${project.id}/previews`)
  await pickStage(page, 'All stages')
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^All stages\s*3$/)
  await expect(page).toHaveURL(/\?stage=_all$/)

  // A remembered stage since removed is ignored: the default shows.
  await pickStage(page, 'QA')
  await expect(previewRows(page)).toHaveCount(1)
  await ok(human.delete(`/api/projects/${project.id}/stages/${qa.id}?moveTo=todo`))
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews$`))
  await page.goto(`/projects/${project.id}/previews?stage=${qa.key}`)
  await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  await expect(previewRows(page)).toContainText('Waiting for review')

  expect(hydration).toEqual([])
})

test("the sidebar's Previews link, clicked on the Previews page, shows the stage just picked, here or in another tab", async ({
  page,
  human,
  project,
}) => {
  await hosted(human, project.id, 'Waiting for review', 'review')
  await hosted(human, project.id, 'Shipped', 'done')
  await hosted(human, project.id, 'Being built', 'in_progress')
  const sidebarPreviews = () =>
    page.getByRole('navigation').getByRole('link', { name: 'Previews', exact: true }).click()

  // Nothing remembered: the default, then Done picked, then the sidebar's link without leaving the page.
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  await pickStage(page, 'Done')
  await expect(page).toHaveURL(/\?stage=done$/)
  await sidebarPreviews()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=done$`))
  await expect(shownStage(page)).toHaveText(/^Done\s*1$/)
  await expect(previewRows(page)).toHaveCount(1)
  await expect(previewRows(page)).toContainText('Shipped')

  // Done remembered, All stages picked: the sidebar's link shows All stages, and the URL says so.
  await pickStage(page, 'All stages')
  await expect(page).toHaveURL(/\?stage=_all$/)
  await sidebarPreviews()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=_all$`))
  await expect(shownStage(page)).toHaveText(/^All stages\s*3$/)
  await expect(previewRows(page)).toHaveCount(3)
  expect(await page.evaluate((k) => localStorage.getItem(k), `previews.stage.${project.id}`)).toBe('_all')

  // A stage picked in another tab: the sidebar's link here reads it.
  const other = await page.context().newPage()
  await other.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(other)).toHaveText(/^All stages\s*3$/)
  await pickStage(other, 'In progress')
  await expect(other).toHaveURL(/\?stage=in_progress$/)
  await other.close()
  await sidebarPreviews()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=in_progress$`))
  await expect(shownStage(page)).toHaveText(/^In progress\s*1$/)
  await expect(previewRows(page)).toContainText('Being built')
})

test('a stage whose key reads as a number or a boolean opens from ?stage=<key>, and one named Constructor shows its count', async ({
  page,
  human,
  project,
}) => {
  const stage = (name: string) =>
    ok<{ key: string }>(human.post(`/api/projects/${project.id}/stages`, { data: { name, kind: 'active' } }))
  const year = await stage('2026')
  const yes = await stage('True')
  const ctor = await stage('Constructor')
  expect([year.key, yes.key, ctor.key]).toEqual(['2026', 'true', 'constructor'])
  await hosted(human, project.id, 'Waiting for review', 'review')
  await hosted(human, project.id, 'Planned for the year', '2026')
  await hosted(human, project.id, 'Answered yes', 'true')

  // Written by hand, unquoted: the router reads 2026 as a number and true as a boolean.
  await page.goto(`/projects/${project.id}/previews?stage=2026`)
  await expect(shownStage(page)).toHaveText(/^2026\s*1$/)
  await expect(previewRows(page)).toHaveCount(1)
  await expect(previewRows(page)).toContainText('Planned for the year')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=2026$`))
  await page.goto(`/projects/${project.id}/previews?stage=true`)
  await expect(shownStage(page)).toHaveText(/^True\s*1$/)
  await expect(previewRows(page)).toContainText('Answered yes')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=true$`))

  // Picked, the app writes the key quoted, and that URL loads as well.
  await page.goto(`/projects/${project.id}/previews?stage=review`)
  await pickStage(page, '2026')
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/previews\\?stage=%222026%22$`))
  await expect(previewRows(page)).toContainText('Planned for the year')
  await page.reload()
  await expect(shownStage(page)).toHaveText(/^2026\s*1$/)
  await expect(previewRows(page)).toContainText('Planned for the year')
  // Remembered as well: a visit without a stage restores it.
  await page.goto(`/projects/${project.id}/previews`)
  await expect(shownStage(page)).toHaveText(/^2026\s*1$/)

  // A stage keyed `constructor`: 0 while it holds no preview, then 1.
  await stageFilter(page).click()
  await expect(stageOption(page, 'Constructor')).toHaveText(/^Constructor\s*0$/)
  await page.keyboard.press('Escape')
  await hosted(human, project.id, 'Built from scratch', ctor.key)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await stageFilter(page).click()
  await expect(stageOption(page, 'Constructor')).toHaveText(/^Constructor\s*1$/)
  await stageOption(page, 'Constructor').click()
  await expect(shownStage(page)).toHaveText(/^Constructor\s*1$/)
  await expect(previewRows(page)).toContainText('Built from scratch')
})

test('a stage without previews says so, and Show all stages shows them all', async ({
  page,
  human,
  project,
}) => {
  await hosted(human, project.id, 'Being built', 'in_progress')
  await hosted(human, project.id, 'Being built too', 'in_progress')
  await page.goto(`/projects/${project.id}/previews`)
  await expect(page.getByText('No previews in In review.')).toBeVisible()
  await expect(page.getByText(/^No previews yet\./)).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^(Running|Not running)$/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Show all stages' }).click()
  await expect(shownStage(page)).toHaveText(/^All stages\s*2$/)
  await expect(page).toHaveURL(/\?stage=_all$/)
  await expect(group(page, 'Not running').getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText('No previews in In review.')).toHaveCount(0)
})

test('Stop all shows while a preview of the project runs outside the stage picked, and stops it', async ({
  page,
  human,
  project,
}) => {
  const { worktree, branch } = worktreeOf(`${project.id}-stop-all-filtered`)
  const server = await serveFrom(worktree)
  try {
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Started by an agent', status: 'in_progress' },
      }),
    )
    await register(human, t, { branch, path: worktree, previewUrl: server.url })
    await hosted(human, project.id, 'Waiting for review', 'review')
    await page.goto(`/projects/${project.id}/previews`)
    await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
    await expect(group(page, 'Running')).toHaveCount(0)
    await expect(group(page, 'Not running').getByRole('listitem')).toHaveCount(1)
    await page.getByRole('button', { name: 'Stop all' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop all' }).click()
    await expect(toast(page, /^Stopped 1$/)).toBeVisible()
    await server.exited
    expect(await listens(server.port)).toBe(false)
    await expect(page.getByRole('button', { name: 'Stop all' })).toHaveCount(0)
    await expect(shownStage(page)).toHaveText(/^In review\s*1$/)
  } finally {
    server.stop()
  }
})
