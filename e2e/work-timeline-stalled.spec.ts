import type { Project } from '#/lib/api'
import { HUMAN } from './env'
import { expect, ok, section, test } from './fixtures'
import { as, age, create, record, workedTicket } from './workTimeline'

/**
 * Stalled tickets: the warning on a card, a list row and Needs you, who is named as last heard from, and the
 * threshold the human sets for it.
 */

test('a stalled ticket shows on its card, in the list and in Needs you, linking to it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await workedTicket(human, agent, project)
  const other = await create(human, project, { title: 'All quiet', status: 'in_progress' })
  await record(agent, project, other.id, { kind: 'heartbeat' })

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })
  await expect(card).toContainText('Stalled')
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('Stalled')
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })).toContainText(
    'Stalled',
  )
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('Stalled')

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const link = needsYou.getByRole('link', { name: `Stalled: #${t.id} Ship the importer` })
  await expect(link).toBeVisible()
  // `has` is matched inside each row, so it takes the link alone, not one scoped to the section.
  const row = needsYou
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Ship the importer` }) })
  await expect(row).toContainText(/silent 4\dm · last claude/)
  await expect(needsYou.getByRole('link', { name: /Stalled: .*All quiet/ })).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}$`))
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible()
})

test('a stalled row names who recorded the last event: a claimed name gets no badge of its own', async ({
  page,
  project,
  human,
  agent,
}) => {
  // A worker's heartbeat that claims the human's name.
  const t = await create(human, project, { title: 'Claimed heartbeat', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'heartbeat', agent: HUMAN })
  age(t.id, 40)

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const row = needsYou
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Claimed heartbeat` }) })
  await expect(row).toContainText(new RegExp(`silent 4\\dm · last ${HUMAN}\\s*by\\s*claude\\s*Agent`))
  await expect(row.getByTestId('claimed-name')).toHaveText(HUMAN)
  await expect(row.locator('[data-role="human"]')).toHaveCount(0)
  await expect(row.getByTestId('event-by').locator('[data-role="worker"]')).not.toHaveCount(0)
  await expect(row.locator('[data-role]:not([data-testid="event-by"] *)')).toHaveCount(0)
})

test("a worker's event under the name 'board' is a claim: no Board badge, and who recorded it", async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Board claims', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'board' })
  await record(agent, project, t.id, { kind: 'heartbeat', agent: 'board' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  await card.getByRole('button', { name: 'Show more' }).click()
  await card.getByRole('button', { name: 'Show heartbeats' }).click()
  // The story folds one actor's consecutive rows under one actor line: the claimed name and who
  // recorded it show once for the run, not on every row.
  const list = card.getByRole('list', { name: 'Timeline story' })
  const run = list
    .locator(':scope > li')
    .filter({ hasText: /board\s*by\s*claude\s*Agent/ })
    .filter({ hasText: 'heartbeat' })
  await expect(run).toHaveCount(1)
  await expect(run.getByTestId('claimed-name')).toHaveText('board')
  await expect(run.getByTestId('event-by')).toContainText(/^by\s*claude\s*Agent$/)
  await expect(run.locator('[data-role="board"]')).toHaveCount(0)
  await expect(run.getByRole('listitem').filter({ hasText: 'started build' })).toHaveCount(1)
  await expect(run.locator('[data-role]:not([data-testid="event-by"] *)')).toHaveCount(0)
  // The board's own event keeps its badge.
  const created = list.getByRole('listitem').filter({ hasText: 'created in In progress' })
  await expect(created.locator('[data-role="board"]').first()).toContainText(/^board\s*Board$/)
  await expect(created.getByTestId('event-by')).toHaveCount(0)
})

test("a stalled row names a worker's event under the name 'board' as a claim, with who recorded it", async ({
  page,
  project,
  human,
  agent,
}) => {
  // The worker's heartbeat is the last thing heard: not the board's own, so it is named, not skipped.
  const t = await create(human, project, { title: 'Board-named heartbeat', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'heartbeat', agent: 'board' })
  age(t.id, 40)

  await page.goto(`/projects/${project.id}`)
  const row = section(page, 'Needs you')
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Board-named heartbeat` }) })
  await expect(row).toContainText(/silent 4\dm · last board\s*by\s*claude\s*Agent/)
  await expect(row.getByTestId('claimed-name')).toHaveText('board')
  await expect(row.getByTestId('last-assignee')).toHaveCount(0)
  await expect(row.locator('[data-role="board"]')).toHaveCount(0)
  await expect(row.getByTestId('event-by').locator('[data-role="worker"]')).not.toHaveCount(0)
})

test('a stalled row with no agent heard from names the assignee as plain text, with no badge', async ({
  page,
  project,
  human,
  playwright,
  baseURL,
}, info) => {
  const name = `quiet-agent-${info.workerIndex}`
  // A name that signs in as an agent, so a badge would show if the row used Actor.
  const signedIn = await as(playwright, baseURL, `agent:${name}`)
  try {
    await ok(signedIn.get('/api/me'))
    const t = await create(human, project, {
      title: 'Assigned, silent',
      status: 'in_progress',
      assignee: name,
    })
    age(t.id, 40)

    await page.goto(`/projects/${project.id}`)
    const row = section(page, 'Needs you')
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Assigned, silent` }) })
    await expect(row).toContainText(new RegExp(`silent 4\\dm · last ${name}$`))
    await expect(row.getByTestId('last-assignee')).toHaveText(name)
    await expect(row.locator('[data-role]')).toHaveCount(0)
    await expect(row.getByTestId('event-by')).toHaveCount(0)
  } finally {
    await signedIn.dispose()
  }
})

test('the human sets after how many minutes a ticket reads as stalled', async ({
  page,
  project,
  human,
  agent,
}) => {
  await page.goto(`/projects/${project.id}/settings`)
  const settings = page.getByRole('region', { name: 'Stalled tickets' })
  const minutes = settings.getByLabel('Stalled after (minutes)')
  await expect(minutes).toHaveValue('30')
  await minutes.fill('45')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Stalled tickets' }).getByLabel('Stalled after (minutes)'),
  ).toHaveValue('45')
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).stallMinutes).toBe(45)
  // An agent cannot change it.
  const refused = await agent.patch(`/api/projects/${project.id}`, { data: { stallMinutes: 5 } })
  expect(refused.status()).toBe(403)
})
