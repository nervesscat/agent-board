import type { Project } from '#/lib/api'
import { HUMAN } from './env'
import { expect, expectTooltip, ok, section, test } from './fixtures'
import {
  as,
  age,
  create,
  quietTicket,
  record,
  reviewTicket,
  stalledTicket,
  workedTicket,
} from './workTimeline'

/**
 * Stalled tickets: the warning on a card, a list row and Needs you (its why and since when, in the same words
 * as the badge), who is named as last heard from, and the threshold the human sets for it.
 */

test('a stalled ticket shows on its card, in the list and in Needs you, linking to it', async ({
  page,
  project,
  human,
  agent,
}) => {
  const { t } = await stalledTicket(human, agent, project)
  const other = await create(human, project, { title: 'All quiet', status: 'in_progress' })
  await record(agent, project, other.id, { kind: 'heartbeat' })
  const quiet = await quietTicket(human, agent, project)
  const turn = await reviewTicket(human, project)

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'no-word')
  await expect(line).toContainText(/No word \d+m/)
  // The line's tooltip keeps the why.
  await expectTooltip(line, /nothing open since the build ended/)
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('No word')
  // A live agent with no progress post in over a day reads Quiet, and a review ticket reads Your turn.
  const quietLine = page
    .getByRole('link', { name: new RegExp(`#${quiet.t.id} Quiet importer`) })
    .getByTestId('work-line')
  await expect(quietLine).toHaveAttribute('data-state', 'quiet')
  await expect(quietLine).toContainText('Quiet 1d')
  const turnLine = page
    .getByRole('link', { name: new RegExp(`#${turn.t.id} Waiting for a look`) })
    .getByTestId('work-line')
  await expect(turnLine).toHaveAttribute('data-state', 'your-turn')
  await expect(turnLine).toContainText('Your turn · waiting 2d')
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(
    page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) }).getByTestId('work-line'),
  ).toContainText(/No word \d+m/)
  await expect(page.getByRole('link', { name: /All quiet/ })).not.toContainText('No word')
  await expect(
    page.getByRole('link', { name: new RegExp(`#${quiet.t.id} Quiet importer`) }).getByTestId('work-line'),
  ).toContainText('Quiet 1d')
  await expect(
    page.getByRole('link', { name: new RegExp(`#${turn.t.id} Waiting for a look`) }).getByTestId('work-line'),
  ).toContainText('Your turn · waiting 2d')

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  const link = needsYou.getByRole('link', { name: new RegExp(`No word \\d+m: #${t.id} Ship the importer`) })
  await expect(link).toBeVisible()
  // `has` is matched inside each row, so it takes the link alone, not one scoped to the section.
  const row = needsYou.getByRole('listitem').filter({
    has: page.getByRole('link', { name: new RegExp(`No word \\d+m: #${t.id} Ship the importer`) }),
  })
  await expect(row.getByTestId('work-line')).toContainText(/No word \d+m/)
  await expectTooltip(row.getByTestId('work-line'), /nothing open since the build ended/)
  await expect(row).toContainText(/last\s*claude/)
  await expect(needsYou.getByRole('link', { name: /No word \d+m: .*All quiet/ })).toHaveCount(0)
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
  const row = needsYou.getByRole('listitem').filter({
    has: page.getByRole('link', { name: new RegExp(`No word \\d+m: #${t.id} Claimed heartbeat`) }),
  })
  await expect(row.getByTestId('work-line')).toContainText(/No word \d+m/)
  await expect(row).toContainText(new RegExp(`No word \\d+m: .*last ${HUMAN}\\s*by\\s*claude\\s*Agent`))
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
    .filter({
      has: page.getByRole('link', { name: new RegExp(`No word \\d+m: #${t.id} Board-named heartbeat`) }),
    })
  await expect(row.getByTestId('work-line')).toContainText(/No word \d+m/)
  await expect(row).toContainText(/No word \d+m: .*last board\s*by\s*claude\s*Agent/)
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
      .filter({
        has: page.getByRole('link', { name: new RegExp(`No word \\d+m: #${t.id} Assigned, silent`) }),
      })
    await expect(row.getByTestId('work-line')).toContainText(/No word \d+m/)
    await expect(row).toContainText(new RegExp(`No word \\d+m: .*last ${name}$`))
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
  // The settings copy names both clocks: the fixed lease and the human's stall threshold.
  await expect(settings).toContainText('Lost contact')
  await expect(settings).toContainText(/lease/i)
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

test('a run whose lease expired mid-span reads Lost contact, never Stalled and never in Needs you', async ({
  page,
  project,
  human,
  agent,
}) => {
  // The build span is 40 minutes old with nothing heard since: the agent is gone, its span still open.
  const { t } = await workedTicket(human, agent, project)

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Ship the importer`) })
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'lost')
  await expect(line).toContainText('Lost contact')
  await expectTooltip(line, /claude · build · \d+ min · last word \d+ min ago/)
  await expect(card.getByTestId('work-line')).toHaveCount(1)
  await expect(card).not.toContainText('No word')

  // The ticket card says whose span is open and when it last spoke, the detail under the one line.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const timeline = page.getByRole('region', { name: 'Timeline' })
  await expect(timeline.getByTestId('work-line')).toContainText('Lost contact')
  await expect(timeline.getByText(/^claude · build · \d+ min · last word \d+ min ago$/)).toBeVisible()

  // Needs you is the human's turn: the ticket is in the Overview's own Lost contact block instead.
  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  await expect(needsYou.getByRole('link', { name: /Lost contact: .*Ship the importer/ })).toHaveCount(0)
  await expect(needsYou.getByRole('link', { name: /No word \d+m: .*Ship the importer/ })).toHaveCount(0)
  const lost = section(page, 'Lost contact')
  const row = lost.getByRole('listitem').filter({ hasText: `#${t.id} Ship the importer` })
  await expect(row).toContainText(/claude · build · since .* · last word \d+ min ago/)
})

test('a long span kept alive by the agent’s posts reads Working, and stays out of Needs you', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Review round four', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'review', round: 4 })
  // The span opened 49 minutes ago; the posts came 6 to 31 minutes ago, inside the ten-minute lease.
  age(t.id, 49)
  for (const body of ['hunt: two candidates', 'verify: 25/25 pass', 'refute: neither holds'])
    await ok(agent.post(`/api/tickets/${t.id}/updates`, { data: { body, progress: true } }))
  await ok(agent.post(`/api/projects/${project.id}/tickets/${t.id}/events`, { data: { kind: 'heartbeat' } }))

  await page.goto(`/projects/${project.id}/features?view=board`)
  const card = page.getByRole('link', { name: new RegExp(`#${t.id} Review round four`) })
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'working')
  await expect(line).toContainText(/Working now · last word \d+m/)
  await expect(card.getByTestId('work-line')).toHaveCount(1)
  await expect(card).not.toContainText('No word')
  await expect(card).not.toContainText('Lost contact')

  await page.goto(`/projects/${project.id}`)
  const needsYou = section(page, 'Needs you')
  await expect(needsYou.getByRole('link', { name: /Review round four/ })).toHaveCount(0)
  await expect(section(page, 'In progress').getByRole('link', { name: /Review round four/ })).toBeVisible()
})
