import { expect, expectTooltip, ok, test } from './fixtures'
import { inDatabase } from './db'
import {
  age,
  as,
  create,
  errorsOn,
  quietTicket,
  record,
  reviewTicket,
  scrollsSideways,
  workedTicket,
} from './workTimeline'

/**
 * The work timeline on the ticket page: the Timeline card's header (what is open, stalled and why, last
 * heard), its story (behind "Show more", oldest first, folded runs, paired waits), its heartbeats, and an
 * event row on a phone.
 */

test('the ticket page has a Timeline card: what is open, the story, heartbeats folded', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  // The browser clock runs ten minutes behind the server's: the one line still counts on the server's, once.
  await page.clock.setFixedTime(new Date(Date.now() - 10 * 60_000))
  const { t } = await workedTicket(human, agent, project)
  await record(agent, project, t.id, { kind: 'heartbeat', note: 'reading the importer' })
  await record(agent, project, t.id, { kind: 'heartbeat', note: 'writing the parser' })
  await record(agent, project, t.id, { kind: 'heartbeat', note: 'running the tests' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  await expect(card.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await expect(
    card.getByTestId('work-timeline').locator('[data-kind="span"][data-phase="build"]'),
  ).toBeVisible()

  // The header: what is open now, the worked and waited summary, the last heartbeat. A heartbeat just now:
  // not No word, and the story is folded away until it is asked for.
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'working')
  await expect(line).toHaveAccessibleName(/Working now · last word [01]m/)
  await expect(card.getByText(/^claude · build · \d+ min · last word \d+ min ago$/)).toBeVisible()
  await expect(card.getByTestId('work-summary')).toContainText('Waited 20 min')
  // The legend is gone: no key in the card, and no toggle for one.
  await expect(card.getByText('Key', { exact: true })).toHaveCount(0)
  await expect(card.locator('[data-state="no-word"]')).toHaveCount(0)
  await expect(card.getByTestId('last-heard')).toContainText('claude: running the tests')
  await expect(card.getByRole('list', { name: 'Timeline story' })).toHaveCount(0)
  const more = card.getByRole('button', { name: 'Show more' })
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')

  // The story: a sentence per row, the wait paired into one row with its duration, from the start to the end.
  const events = card.getByRole('list', { name: 'Timeline story' })
  const texts = await events.locator(':scope > li > ul > li').allTextContents()
  const at = (part: string) => texts.findIndex((x) => x.includes(part))
  expect(at('created in In progress')).toBeLessThan(at('waited for the lock'))
  expect(at('waited for the lock')).toBeLessThan(at('handed the work to builder-sub-1'))
  expect(at('handed the work to builder-sub-1')).toBeLessThan(at('started build'))
  await expect(events).toContainText('handed the work to builder-sub-1')
  await expect(events).toContainText('waited for the lock (test lock) · 20 min')
  await expect(events).toContainText('created in In progress')
  await expect(events).not.toContainText('stopped waiting')
  // The heartbeats are folded away: the count and the button say so, and their notes are not rows yet.
  await expect(events).not.toContainText('heartbeat: ')
  await expect(card.getByText(/^3 heartbeats, last /)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Show heartbeats' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await card.getByRole('button', { name: 'Show heartbeats' }).click()
  await expect(events.getByText(/^heartbeat: /)).toHaveCount(3)
  await expect(events).toContainText('heartbeat: running the tests')
  await expect(card.getByRole('button', { name: 'Hide heartbeats' })).toHaveAttribute('aria-expanded', 'true')

  // Each actor's run has its actor line once; the board's own run names the board, with its own badge.
  const created = events.locator(':scope > li').filter({ hasText: 'created in In progress' })
  await expect(created).toHaveCount(1)
  const board = created.locator('[data-role="board"]').first()
  await expect(board).toContainText(/^board\s*Board$/)
  await expect(created.locator('[data-role="human"]')).toHaveCount(0)
  await expectTooltip(board, 'the board, recorded automatically')
  // A claimed name is followed by who recorded it, with that caller's badge.
  const handoff = events.locator(':scope > li').filter({ hasText: 'handed the work to builder-sub-1' })
  await expect(handoff.getByTestId('event-by')).toContainText(/^by\s*claude\s*Agent$/)
  await expect(handoff.getByTestId('event-by').locator('[data-role="worker"]')).not.toHaveCount(0)
  // The claimed name is plain text: no badge and no tooltip of its own, since nobody signed in as it.
  const claimed = handoff.getByTestId('claimed-name')
  await expect(claimed).toHaveText('orchestrator')
  await expect(claimed).not.toHaveAttribute('data-slot', 'tooltip-trigger')
  // An event recorded under its caller's own name says nothing more.
  await expect(created.getByTestId('event-by')).toHaveCount(0)
  await card.screenshot({ path: test.info().outputPath('ticket-timeline-card.png') })

  // A ticket nothing was recorded on says so.
  const fresh = await create(human, project, { title: 'Nothing yet', status: 'todo' })
  await page.goto(`/projects/${project.id}/features/${fresh.id}`)
  const empty = page.getByRole('region', { name: 'Timeline' })
  await expect(empty).toContainText('No work recorded yet.')
  // Its creation is an event: the story has that one line, behind Show more.
  await empty.getByRole('button', { name: 'Show more' }).click()
  await expect(empty.getByRole('list', { name: 'Timeline story' })).toContainText('created in To do')
  // The ticket page draws the same one line: a day-long quiet and a review stage's turn.
  const quiet = await quietTicket(human, agent, project)
  await page.goto(`/projects/${project.id}/features/${quiet.t.id}`)
  const quietCard = page.getByRole('region', { name: 'Timeline' })
  await expect(quietCard.getByTestId('work-line')).toHaveAttribute('data-state', 'quiet')
  await expect(quietCard.getByTestId('work-line')).toHaveAccessibleName(/Quiet 1d/)
  const turn = await reviewTicket(human, project)
  await page.goto(`/projects/${project.id}/features/${turn.t.id}`)
  const turnCard = page.getByRole('region', { name: 'Timeline' })
  await expect(turnCard.getByTestId('work-line')).toHaveAttribute('data-state', 'your-turn')
  await expect(turnCard.getByTestId('work-line')).toHaveAccessibleName(/Your turn · waiting 2d/)
  expect(errors).toEqual([])
})

test('consecutive rows of one actor fold under one actor line; the heartbeats fold into the run', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Folded runs', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'spec' })
  await record(agent, project, t.id, { kind: 'heartbeat', note: 'drafting the spec' })
  await record(agent, project, t.id, { kind: 'span_end', phase: 'spec', note: 'spec written' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, t.id, { kind: 'heartbeat', note: 'writing the importer' })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  await card.getByRole('button', { name: 'Show more' }).click()
  const events = card.getByRole('list', { name: 'Timeline story' })
  // Two runs, oldest first: the board's creation, then the agent's (its events, one actor line).
  const runs = events.locator(':scope > li')
  await expect(runs).toHaveCount(2)
  const agentRun = runs.last()
  await expect(agentRun.locator(':scope > div')).toHaveCount(1)
  // Heartbeats stay out of the run until they are asked for; the rows keep their order, start to end.
  await expect(agentRun.locator(':scope > ul > li')).toHaveCount(3)
  await expect(agentRun.locator(':scope > ul > li').nth(0)).toContainText('started spec')
  await expect(agentRun.locator(':scope > ul > li').nth(1)).toContainText('ended spec: spec written')
  await expect(agentRun.locator(':scope > ul > li').nth(2)).toContainText('started build')
  await page.getByRole('button', { name: 'Show heartbeats' }).click()
  await expect(runs).toHaveCount(2)
  await expect(agentRun.locator(':scope > ul > li')).toHaveCount(5)
  await expect(agentRun.locator(':scope > ul > li').nth(1)).toContainText('heartbeat: drafting the spec')
  await expect(agentRun.locator(':scope > ul > li').nth(4)).toContainText('heartbeat: writing the importer')
})

test('the story is folded behind Show more, and reads from the start to the end', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'A long run', status: 'in_progress' })
  for (let i = 1; i <= 12; i++) await record(agent, project, t.id, { kind: 'handoff', to: `step-${i}` })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  // Collapsed by default: no rows, only the button with its arrow.
  await expect(card.getByRole('list', { name: 'Timeline story' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Show more' }).click()
  // Thirteen rows (the creation, then twelve hand-offs), oldest first.
  const rows = card.getByRole('list', { name: 'Timeline story' }).locator(':scope > li > ul > li')
  await expect(rows).toHaveCount(13)
  await expect(rows.first()).toContainText('created in In progress')
  await expect(rows.nth(1)).toContainText('handed the work to step-1')
  await expect(rows.last()).toContainText('handed the work to step-12')
  await card.getByRole('button', { name: 'Show less' }).click()
  await expect(card.getByRole('list', { name: 'Timeline story' })).toHaveCount(0)
})

test('a stalled build says why, and a wait pairs into one row with its duration', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Quiet build', status: 'in_progress' })
  const wait = await record(agent, project, t.id, {
    kind: 'wait_start',
    agent: 'orchestrator',
    reason: 'other',
    note: 'spec',
  })
  // The wait ran for 1 min 25 s: its start is put that long before now, as the rest is aged below.
  inDatabase((db) =>
    db
      .prepare('update ticket_events set at = ? where id = ?')
      .run(new Date(Date.now() - 85_000).toISOString(), wait.waitId),
  )
  await record(agent, project, t.id, { kind: 'wait_end', agent: 'orchestrator', note: 'spec approved' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, t.id, {
    kind: 'span_end',
    phase: 'build',
    note: 'run returned before the builder reported',
  })
  // Forty minutes of silence since the build ended: stalled, and the header says why.
  age(t.id, 40)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'no-word')
  await expect(line).toHaveAccessibleName(/No word (39|40)m/)
  await expectTooltip(line, /nothing open since the build ended at/)
  await card.getByRole('button', { name: 'Show more' }).click()
  const events = card.getByRole('list', { name: 'Timeline story' })
  await expect(events).toContainText('waited for spec · 1 min 25 s: spec approved')
  await expect(events).not.toContainText('waiting for spec')
  await expect(events).toContainText('ended build: run returned before the builder reported')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('an event row with a long claimed name and a long sub-identity fits 390px', async ({
    page,
    project,
    human,
    playwright,
    baseURL,
  }, info) => {
    const orchName = `orch-w${info.workerIndex}`
    const sub = `${orchName}/builder-with-a-long-sub-identity/importer-lane-one`
    const worker = await as(playwright, baseURL, `orchestrator:${orchName}`, { 'X-Agent-Name': sub })
    try {
      const t = await create(human, project, { title: 'Narrow timeline', status: 'in_progress' })
      await record(worker, project, t.id, {
        kind: 'span_start',
        phase: 'verification',
        agent: `${orchName}/verifier-for-the-importer-lane`,
        note: 'checking the importer against the sample files',
      })

      await page.goto(`/projects/${project.id}/features/${t.id}`)
      const card = page.getByRole('region', { name: 'Timeline' })
      await card.getByRole('button', { name: 'Show more' }).click()
      const events = card.getByRole('list', { name: 'Timeline story' })
      const run = events.locator(':scope > li').filter({ hasText: 'started verification' })
      await expect(run.getByTestId('event-by')).toContainText(sub)
      await expect(run.getByTestId('claimed-name')).toHaveText(`${orchName}/verifier-for-the-importer-lane`)
      expect(await scrollsSideways(page)).toBe(false)

      // The actor line sits above its run; the time and the sentence share one line.
      const row = run.locator(':scope > ul > li').first()
      const time = row.locator('time')
      const sentence = row.getByText(/^started verification/)
      const actor = run.getByTestId('claimed-name')
      const [tBox, sBox, aBox] = [
        await time.boundingBox(),
        await sentence.boundingBox(),
        await actor.boundingBox(),
      ]
      expect(Math.abs(tBox!.y - sBox!.y)).toBeLessThan(6)
      expect(aBox!.y + aBox!.height).toBeLessThanOrEqual(tBox!.y + 1)

      // Each part keeps a readable width: none is squeezed to a sliver.
      const recorder = run.getByTestId('event-by').locator('[data-role="worker"]').first()
      for (const part of [sentence, recorder, actor])
        expect((await part.boundingBox())!.width).toBeGreaterThan(150)
      // And none runs past the list's right edge, where a clipping card would hide it.
      const list = (await events.boundingBox())!
      for (const part of [sentence, recorder, actor]) {
        const box = (await part.boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(list.x + list.width + 1)
      }
      await run.screenshot({ path: test.info().outputPath('event-run-390.png') })
    } finally {
      await worker.dispose()
    }
  })
})

test('a stall in another active stage names that stage in its why, on the ticket page', async ({
  page,
  project,
  human,
  agent,
}) => {
  // An active stage after the first one (In progress), so the stall names it.
  await ok(human.post(`/api/projects/${project.id}/stages`, { data: { name: 'Bug Found', kind: 'active' } }))
  const stages = await ok<{ key: string; name: string }[]>(human.get(`/api/projects/${project.id}/stages`))
  const t = await create(human, project, {
    title: 'Crash on import',
    status: stages.find((s) => s.name === 'Bug Found')!.key,
  })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build' })
  await record(agent, project, t.id, { kind: 'span_end', phase: 'build' })
  age(t.id, 40)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Timeline' })
  const line = card.getByTestId('work-line')
  await expect(line).toHaveAttribute('data-state', 'no-word')
  await expect(line).toHaveAccessibleName(/No word \d+m/)
  await expectTooltip(line, /^in Bug Found, no agent heard from since/)
})
