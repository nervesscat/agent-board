import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import type { ManagedPreview, ProjectPreview, TicketFull, Workspace } from '#/lib/api'
import { e2eEnv, git } from './env'
import { expect, ok, seedProject, test } from './fixtures'

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
  await expect(page.getByRole('region').getByRole('listitem')).toHaveCount(0)
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

    await page.goto(`/projects/${project.id}/previews`)
    // The rows sit in the Running and Not running sections.
    const rows = page.getByRole('region').getByRole('listitem')
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
    const open = down.getByRole('link', { name: 'Open preview' })
    await expect(open).toHaveAttribute('href', dead)
    await expect(open).toHaveAttribute('target', '_blank')
    await expect(open).toHaveAttribute('rel', /\bnoreferrer\b/)
    // Nothing for the board to run: a link only.
    await expect(down.getByRole('button')).toHaveCount(0)

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
    await page.goto(`/projects/${other.id}/previews`)
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

test("Start, Restart and Stop on a row run the board's own preview of the worktree; a refusal comes up as a toast", async ({
  page,
  human,
  project,
}) => {
  const { root } = e2eEnv()
  const branch = `e2e-${project.id}-previews`
  // A worktree of the run's repo, next to it, that reads as a checkout of the board with its
  // dependencies installed, and whose build never ends: the board starts it for real, and it stays
  // building until it is stopped.
  const worktree = path.join(root, `wt-previews-${project.id}`)
  git('worktree', 'add', '-q', '-b', branch, worktree, 'main')
  const lock = "lockfileVersion: '9.0'\n"
  fs.writeFileSync(
    path.join(worktree, 'package.json'),
    JSON.stringify({
      name: 'agent-board',
      private: true,
      scripts: { build: 'node -e "setInterval(() => {}, 1000)"' },
    }),
  )
  fs.writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), lock)
  fs.mkdirSync(path.join(worktree, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'node_modules', '.pnpm', 'lock.yaml'), lock)

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
    await page.goto(`/projects/${project.id}/previews`)
    const running = page.getByRole('region', { name: 'Running', exact: true })
    const stopped = page.getByRole('region', { name: 'Not running' })
    const row = stopped.getByRole('listitem').filter({ hasText: 'Run it from here' })
    await expect(row).toContainText('Not running')
    await expect(row.getByRole('button', { name: 'Stop' })).toHaveCount(0)

    // Start: the board builds it, and the row says so once the page asked again.
    await row.getByRole('button', { name: 'Start', exact: true }).click()
    const building = running.getByRole('listitem').filter({ hasText: 'Run it from here' })
    await expect(building).toContainText('Building…')
    await expect(building).toContainText('building')
    await expect(building.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
    await expect(row).toHaveCount(0)
    await expect.poll(async () => (await managed())?.step).toBe('build')
    const first = (await managed())!
    expect(first).toMatchObject({ status: 'building', path: worktree })

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
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'the ticket is done' })).toBeVisible()
    expect(await managed()).toMatchObject({ status: 'stopped' })
  } finally {
    await human.post(`/api/workspaces/${ws.id}/preview/stop`)
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
  await page.goto(`/projects/${project.id}/previews`)
  const rows = page.getByRole('region').getByRole('listitem')
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
