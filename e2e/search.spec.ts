import type { ProjectPush, TicketFull, TicketRow } from '#/lib/api'
import { git } from './env'
import { expect, ok, test } from './fixtures'

test('the List and the Archived tickets search by name first, then the thread, with the query in the URL', async ({
  page,
  api,
  human,
  project,
}) => {
  // Without a search the List shows the done ticket last (the latest stage), the archive the one
  // archived first last: the search puts the ones found by name first all the same.
  await api.ticket({ title: 'Alpha release', status: 'done' })
  const posted = await api.ticket({ title: 'Beta', status: 'todo' })
  await ok(human.post(`/api/tickets/${posted.id}/updates`, { data: { body: 'tried it on the alpha build' } }))
  const replied = await api.ticket({ title: 'Gamma', status: 'todo' })
  const post = await ok<{ id: number }>(
    human.post(`/api/tickets/${replied.id}/updates`, { data: { body: 'nothing to see' } }),
  )
  await ok(
    human.post('/api/comments', {
      data: { parentType: 'update', parentId: post.id, body: 'the ALPHA flag is still on' },
    }),
  )
  await api.ticket({ title: 'Unrelated', status: 'todo' })
  const oldAlpha = await api.ticket({ title: 'Alpha archived', status: 'done' })
  const lateDelta = await api.ticket({ title: 'Delta', status: 'done' })
  await ok(human.post(`/api/tickets/${lateDelta.id}/updates`, { data: { body: 'alpha leftovers' } }))
  await ok(human.post(`/api/tickets/${oldAlpha.id}/archive`))
  await ok(human.post(`/api/tickets/${lateDelta.id}/archive`))
  await api
    .ticket({ title: 'Epsilon', status: 'done' })
    .then((t) => ok(human.post(`/api/tickets/${t.id}/archive`)))

  const field = page.getByRole('searchbox', { name: 'Search tickets' })
  // The ticket rows: each links to its ticket.
  const rows = page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.locator('a[href*="/features/"]') })

  // The Board shows every ticket, with no search.
  await page.goto(`/projects/${project.id}/features?view=board&q=alpha`)
  await expect(page.locator('[data-column="todo"]').getByRole('link', { name: /Unrelated/ })).toBeVisible()
  await expect(field).toHaveCount(0)

  await page.goto(`/projects/${project.id}/features?view=list`)
  await expect(rows).toHaveCount(4)
  await expect(rows.last()).toContainText('Alpha release')

  // Typing sends one search once it pauses, not one per key.
  const searches: string[] = []
  page.on('request', (r) => {
    if (r.url().includes(`/api/projects/${project.id}/tickets`) && r.url().includes('q='))
      searches.push(r.url())
  })
  await field.pressSequentially('ALPHA', { delay: 60 })
  await expect(page).toHaveURL(/[?&]q=ALPHA(&|$)/)
  await expect(rows).toHaveCount(3)
  await expect(rows.first()).toContainText('Alpha release')
  expect(searches).toHaveLength(1)
  await expect(rows.filter({ hasText: 'Beta' })).toContainText('Post: tried it on the alpha build')
  await expect(rows.filter({ hasText: 'Gamma' })).toContainText('Reply: the ALPHA flag is still on')

  // The query goes with the view: the archive is searched on its own, and its count stays the total.
  await page.getByRole('tab', { name: /Archived/ }).click()
  await expect(page).toHaveURL(/view=archived/)
  await expect(field).toHaveValue('ALPHA')
  await expect(rows).toHaveText([/Alpha archived/, /Delta/])
  await expect(page.getByRole('tab', { name: /Archived/ })).toContainText('(3)')

  // Nothing found says so, and clearing brings the whole archive back, last archived first.
  await field.fill('nomatchxyz')
  await expect(page.getByText('No tickets match “nomatchxyz”.')).toBeVisible()
  await expect(rows).toHaveCount(0)
  await field.press('Escape')
  await expect(field).toHaveValue('')
  await expect(rows).toHaveText([/Epsilon/, /Delta/, /Alpha archived/])
  await expect(page).not.toHaveURL(/[?&]q=/)

  // A link with the query shows it found, in the field too; the clear button empties it.
  await page.goto(`/projects/${project.id}/features?view=list&q=gamma`)
  await expect(field).toHaveValue('gamma')
  await expect(rows).toHaveText([/Gamma/])
  await page.reload()
  await expect(field).toHaveValue('gamma')
  await expect(rows).toHaveText([/Gamma/])
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(rows).toHaveCount(4)

  // A ticket's number finds it; a query no list can read leaves the list whole.
  await page.goto(`/projects/${project.id}/features?view=list&q=${posted.id}`)
  await expect(field).toHaveValue(String(posted.id))
  await expect(rows.first()).toContainText('Beta')
  await page.goto(`/projects/${project.id}/features?view=list&q=%7B%22a%22%3A1%7D`)
  await expect(rows).toHaveCount(4)

  // The same over REST: the reply's ticket is found without the thread in the rows.
  const found = await ok<TicketRow[]>(
    human.get(`/api/projects/${project.id}/tickets?parent=root&q=${encodeURIComponent('flag is still')}`),
  )
  expect(found.map((t) => [t.id, t.match])).toEqual([[replied.id, 'reply']])
  expect(found[0]).not.toHaveProperty('updates')
})

test('the search keeps to the branches not pushed when that line is on, in the List alone', async ({
  page,
  api,
  project,
  human,
}) => {
  const name = (what: string) => `e2e-${project.id}-${what}`
  git('branch', name('local'), 'main')
  git('branch', name('other'), 'main')
  git('branch', name('pushed'), 'main')
  git('push', '-q', 'origin', name('pushed'))
  const ticket = (title: string, branch: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress', branch } }),
    )
  const local = await ticket('Kiwi here', name('local'))
  const other = await ticket('Mango here', name('other'))
  const pushed = await ticket('Kiwi on origin', name('pushed'))
  await expect
    .poll(async () => {
      const res = await ok<ProjectPush>(human.get(`/api/projects/${project.id}/push`))
      return Object.fromEntries(res.tickets.map((t) => [t.id, t.push.state]))
    })
    .toEqual({ [local.id]: 'local-only', [other.id]: 'local-only', [pushed.id]: 'pushed' })

  await page.goto(`/projects/${project.id}/features?view=list&q=kiwi`)
  // The ticket rows: each links to its ticket.
  const rows = page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.locator('a[href*="/features/"]') })
  await expect(rows).toHaveText([/Kiwi/, /Kiwi/])
  await page.getByRole('button', { name: /^2 branches not pushed/ }).click()
  await expect(rows).toHaveText([/Kiwi here/])

  // The line is the List's: left on, the archive still shows every ticket its search finds, though
  // none of them has a branch to push.
  const gone = await api.ticket({ title: 'Kiwi gone', status: 'done' })
  await ok(human.post(`/api/tickets/${gone.id}/archive`))
  const field = page.getByRole('searchbox', { name: 'Search tickets' })
  await page.getByRole('tab', { name: /Archived/ }).click()
  await expect(page).toHaveURL(/view=archived/)
  await expect(rows).toHaveText([/Kiwi gone/])
  await field.fill('gone')
  await expect(page).toHaveURL(/[?&]q=gone(&|$)/)
  await expect(rows).toHaveText([/Kiwi gone/])

  // Back in the List, the line still narrows the search.
  await page.getByRole('tab', { name: /List/ }).click()
  await field.fill('kiwi')
  await expect(page).toHaveURL(/[?&]q=kiwi(&|$)/)
  await expect(rows).toHaveText([/Kiwi here/])
})

test('the first search shows a skeleton, not the whole list, and the next keeps the last results dimmed, if it found any', async ({
  page,
  api,
  project,
}) => {
  await api.ticket({ title: 'Kiwi one', status: 'todo' })
  await api.ticket({ title: 'Kiwi two', status: 'todo' })
  await api.ticket({ title: 'Lemon', status: 'todo' })
  await api.ticket({ title: 'Unrelated', status: 'todo' })
  const rows = page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.locator('a[href*="/features/"]') })
  const skeleton = page.getByRole('main').locator('[data-slot="skeleton"]')
  const field = page.getByRole('searchbox', { name: 'Search tickets' })
  await page.goto(`/projects/${project.id}/features?view=list`)
  await expect(rows).toHaveCount(4)

  // Each search waits until released, to see the page while it is on its way.
  const isSearch = (url: URL) =>
    url.pathname === `/api/projects/${project.id}/tickets` && url.searchParams.has('q')
  let release = () => {}
  let held = Promise.resolve()
  const hold = () => (held = new Promise<void>((r) => (release = r)))
  await page.route(isSearch, async (route) => {
    await held
    await route.continue()
  })

  // The first search: no rows until it answers, the unsearched ones neither.
  hold()
  let sent = page.waitForRequest((r) => isSearch(new URL(r.url())))
  await field.fill('kiwi')
  await sent
  await expect(skeleton).toBeVisible()
  await expect(rows).toHaveCount(0)
  release()
  await expect(rows).toHaveText([/Kiwi/, /Kiwi/])
  await expect(skeleton).toHaveCount(0)

  // The next search keeps the last one's rows, dimmed, until it answers.
  hold()
  sent = page.waitForRequest((r) => isSearch(new URL(r.url())) && r.url().includes('two'))
  await field.fill('kiwi two')
  await sent
  await expect(page.getByRole('main').locator('.opacity-60').getByRole('listitem')).toHaveCount(2)
  await expect(skeleton).toHaveCount(0)
  release()
  await expect(rows).toHaveText([/Kiwi two/])
  await expect(page.getByRole('main').locator('.opacity-60')).toHaveCount(0)

  // After a search that found nothing, the next one has no rows to keep: the skeleton shows until it
  // answers, not a "no match" naming a query not answered yet.
  const noMatch = page.getByText(/No tickets match/)
  await field.fill('zzqq')
  await expect(page.getByText('No tickets match “zzqq”.')).toBeVisible()
  hold()
  sent = page.waitForRequest((r) => isSearch(new URL(r.url())) && r.url().includes('lemon'))
  await field.fill('lemon')
  await sent
  await expect(skeleton).toBeVisible()
  await expect(noMatch).toHaveCount(0)
  await expect(rows).toHaveCount(0)
  release()
  await expect(rows).toHaveText([/Lemon/])
  await expect(skeleton).toHaveCount(0)
  await expect(noMatch).toHaveCount(0)
})
