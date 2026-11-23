import type { APIRequestContext, Locator, Page, Route } from '@playwright/test'

import type { TicketFull, WorkflowEffective, WorkflowOverview } from '#/lib/api'
import { resolveWorkflow } from '#/lib/workflow'
import { graphNodes } from '#/lib/workflowGraph'
import { expect, expectTooltip, ok, test } from './fixtures'

/**
 * The Workflow page: the workflow as a vertical graph of nodes joined by arrows (the review step opened into its
 * round, with the phases that run side by side forking and joining, and the loop back), a node's settings in a
 * panel beside it (a sheet on a phone), and a ticket naming a workflow of its own.
 */

const STANDARD = [
  'Read and claim',
  'Spec',
  'Build',
  'Gate',
  'Review',
  'Preview',
  'Intent check',
  'Push',
  'Pull request',
  'CI',
  'Summary',
  'Hand-off',
]

const url = (projectId: number, search = '') => `/projects/${projectId}/workflow${search}`

/** The page, open with its graph drawn. */
async function open(page: Page, projectId: number, search = '') {
  await page.goto(url(projectId, search))
  await expect(page.locator('[data-graph]')).toBeVisible()
}

/** One node, by its id (`build`, `review.hunt-a`). */
const node = (page: Page, id: string) => page.locator(`[data-step="${id}"]`)
/** The graph's top-level nodes, in order: the steps (a phase's id has a dot). */
const tops = (page: Page) => page.locator('[data-graph] > ol > li > [data-step]')
/** Every top-level node's name as the graph reads it: its number and label, `1. Read and claim`. */
const names = (page: Page) =>
  tops(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')!.split(',')[0]!.trim()))
/** The labels alone, without the numbers. */
const labels = async (page: Page) => (await names(page)).map((n) => n.replace(/^\d+\.\s*/, ''))
/** The settings panel beside the graph. */
const panel = (page: Page) => page.locator('[data-panel="side"]')
/** Selects a node and waits for its settings: the panel is titled with its name. */
async function select(page: Page, id: string) {
  await node(page, id).click()
  await expect(node(page, id)).toHaveAttribute('aria-pressed', 'true')
  await expect(panel(page)).toBeVisible()
  return panel(page)
}
/** What the board has saved, for every preset. */
const overview = (human: APIRequestContext, projectId: number) =>
  ok<WorkflowOverview>(human.get(`/api/projects/${projectId}/workflow`))
const presetOf = async (human: APIRequestContext, projectId: number, id: string) =>
  (await overview(human, projectId)).presets.find((p) => p.id === id)!
const saved = (page: Page) => expect(page.getByText('Saved', { exact: true }).first()).toBeVisible()
const complexityTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name })

/** Whether the page itself scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

async function box(el: Locator) {
  const b = await el.boundingBox()
  expect(b, 'the element is drawn').not.toBeNull()
  return b!
}
const centreX = (b: { x: number; width: number }) => b.x + b.width / 2
/** The review's round counts as they are in the open panel. */
const roundsGroup = (page: Page) => panel(page).getByRole('group', { name: 'Review rounds per complexity' })
const refuseSaves = (route: Route) =>
  route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
    : route.fallback()

test("the project menu lists Workflow after Team, and it opens the project's Workflow page (F1)", async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}`)
  const links = page.locator('aside nav').getByRole('link')
  const texts = await links.allTextContents()
  expect(texts.indexOf('Workflow')).toBe(texts.indexOf('Team') + 1)
  await links.filter({ hasText: 'Workflow' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/workflow`))
  await expect(page.getByRole('heading', { name: 'Workflow', level: 1 })).toBeVisible()
  await expect(page.locator('[data-graph]')).toBeVisible()
})

test('Workflow is a menu page like the others: hideable in the layout, not locked (F1)', async ({
  page,
  project,
  human,
}) => {
  const layout = (
    await ok<{ layout: { id: string; hidden: boolean }[] }>(human.get(`/api/projects/${project.id}`))
  ).layout
  expect(layout.find((it) => it.id === 'nav.workflow')).toMatchObject({ hidden: false })
  // Hidden in the layout, it leaves the menu; the page still opens by its address.
  const hidden = layout.map((it) => (it.id === 'nav.workflow' ? { ...it, hidden: true } : it))
  await ok(human.patch(`/api/projects/${project.id}`, { data: { layout: hidden } }))
  await page.goto(`/projects/${project.id}`)
  await expect(page.locator('aside nav').getByRole('link', { name: 'Team' })).toBeVisible()
  await expect(page.locator('aside nav').getByRole('link', { name: 'Workflow' })).toHaveCount(0)
  await open(page, project.id)
})

test('the page offers the four presets with their descriptions, and picking one shows its graph without making it active (F2)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const presets = page.getByRole('group', { name: 'Workflow presets' })
  await expect(presets.getByRole('button')).toHaveCount(4)
  const buttons = presets.getByRole('button')
  for (const [i, name] of ['Light', 'Standard', 'Thorough', 'Maximum'].entries())
    await expect(buttons.nth(i)).toContainText(name)
  await expect(buttons.nth(0)).toContainText('no spec agent, no environment, no separate hunts')
  await expect(buttons.nth(1)).toContainText('The full cycle')
  await expect(buttons.nth(2)).toContainText('third hunt with the security checklist')
  await expect(buttons.nth(3)).toContainText('second, independent spec')
  // Standard is the project's, and the graph shown.
  await expect(buttons.nth(1)).toContainText('Active')
  await expect(buttons.nth(0)).not.toContainText('Active')
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true')

  await buttons.nth(0).click()
  await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Light workflow/)
  await expect(buttons.nth(1)).toContainText('Active')
  await expect(buttons.nth(0)).not.toContainText('Active')
  expect((await overview(human, project.id)).active).toBe('standard')
  await expect(page.getByRole('button', { name: 'Use this workflow' })).toBeVisible()

  await page.getByRole('button', { name: 'Use this workflow' }).click()
  await saved(page)
  await expect(buttons.nth(0)).toContainText('Active')
  await expect(buttons.nth(1)).not.toContainText('Active')
  await expect(page.getByRole('button', { name: 'Use this workflow' })).toHaveCount(0)
  expect((await overview(human, project.id)).active).toBe('light')

  // A reload keeps it, and opens on it.
  await page.goto(url(project.id))
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Light workflow/)
  await expect(buttons.nth(0)).toContainText('Active')
})

test('Standard at Mid is twelve nodes in the order agents run them, joined top to bottom by arrows (C1)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  expect(await names(page)).toEqual(STANDARD.map((label, i) => `${i + 1}. ${label}`))
  await expect(page.locator('[data-summary]')).toContainText('12 steps for a mid ticket')
  // The tree of the first version is gone: nodes are buttons in a named graph.
  await expect(page.getByRole('tree')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^3\. Build/ })).toBeVisible()

  const ids = [
    'claim',
    'spec',
    'build',
    'gate',
    'review',
    'preview',
    'intent',
    'push',
    'pr',
    'ci',
    'summary',
    'handoff',
  ]
  const boxes = await Promise.all(ids.map((id) => box(node(page, id))))
  for (const [i, b] of boxes.entries()) {
    if (i === 0) continue
    const above = boxes[i - 1]!
    // Each node is below the one before, on the same vertical axis.
    expect(b.y, `${ids[i]} is below ${ids[i - 1]}`).toBeGreaterThanOrEqual(above.y + above.height - 2)
    expect(Math.abs(centreX(b) - centreX(above)), `${ids[i]} is under ${ids[i - 1]}`).toBeLessThan(4)
  }
  // An arrow sits between each neighbouring pair and ends at the lower node (the review's round lies between
  // the review and the node after it, and has its own arrows in and out).
  for (const [i, id] of ids.entries()) {
    if (i === 0) continue
    const prev = ids[i - 1]!
    const edge = page.locator(`[data-edge="${prev === 'review' ? 'review.round' : prev}>${id}"]`)
    await expect(edge).toHaveAttribute('aria-hidden', 'true')
    const e = await box(edge)
    const above = boxes[i - 1]!
    const below = boxes[i]!
    expect(e.y + e.height).toBeLessThanOrEqual(below.y + 2)
    expect(e.y + e.height).toBeGreaterThanOrEqual(below.y - 2)
    expect(e.y).toBeGreaterThanOrEqual(prev === 'review' ? above.y : above.y + above.height - 2)
    expect(Math.abs(centreX(e) - centreX(below))).toBeLessThan(4)
  }
  // Every arrow is hidden from assistive technology, and none is a control.
  const edges = page.locator('[data-edge]')
  expect(await edges.count()).toBeGreaterThan(20)
  expect(await edges.evaluateAll((els) => els.every((el) => el.getAttribute('aria-hidden') === 'true'))).toBe(
    true,
  )
  expect(await scrollsSideways(page)).toBe(false)
})

test('a node shows its number, agent, effort, lock and what the human changed; a skipped or off one is dimmed and says why (C4)', async ({
  page,
  project,
  human,
}) => {
  const standard = await presetOf(human, project.id, 'standard')
  await open(page, project.id)
  const build = node(page, 'build')
  await expect(build.locator('[data-number]')).toHaveText('3')
  await expect(build).toContainText('builder')
  await expect(build).toContainText('Auto: medium')
  await expect(node(page, 'claim')).toContainText('you')
  // A step run by the ticket agent has no effort; the intent check runs at low effort.
  await expect(node(page, 'gate')).not.toContainText('Auto')
  await expect(node(page, 'intent')).toContainText('Low')

  // Locked steps show a lock whose accessible name and tooltip are the reason.
  for (const id of ['claim', 'build', 'gate', 'push', 'pr', 'summary', 'handoff', 'intent']) {
    const step = standard.steps.find((s) => s.id === id)!
    expect(step.lockReason, `${id} is locked`).toBeTruthy()
    await expect(node(page, id).getByRole('img', { name: step.lockReason! })).toBeVisible()
  }
  await expect(node(page, 'preview').locator('[data-lock]')).toHaveCount(0)
  await expectTooltip(
    node(page, 'build').getByRole('img'),
    'Locked: nothing is delivered without the change being built.',
  )

  // A step a low ticket skips says so at every complexity; at low it is dimmed and has no number.
  await expect(node(page, 'spec')).toContainText('Skipped on low')
  await expect(node(page, 'spec')).not.toHaveAttribute('data-skipped')
  await expect(node(page, 'build')).not.toContainText('Skipped on low')
  await complexityTab(page, 'Low').click()
  await expect(node(page, 'spec')).toHaveAttribute('data-skipped', 'true')
  await expect(node(page, 'spec')).toHaveCSS('opacity', '0.7')
  await expect(node(page, 'review')).toContainText('Skipped on low')
  await expect(node(page, 'spec').locator('[data-number]')).toHaveText('–')
  await expect(node(page, 'build')).not.toHaveCSS('opacity', '0.7')
  await expect(node(page, 'spec')).toHaveAccessibleName(/skipped on low/)

  // A step switched off reads Off and is dimmed; one the human changed carries a marker.
  await ok(
    human.put(`/api/projects/${project.id}/workflow/standard`, {
      data: { steps: { ci: { enabled: false }, build: { effort: 'high' } } },
    }),
  )
  await complexityTab(page, 'Mid').click()
  await page.reload()
  await expect(node(page, 'ci')).toContainText('Off')
  await expect(node(page, 'ci')).toHaveAttribute('data-skipped', 'true')
  await expect(node(page, 'ci')).toHaveAccessibleName(/\boff\b/)
  await expect(node(page, 'ci').getByText('changed', { exact: true })).toBeVisible()
  await expect(node(page, 'build').getByText('changed', { exact: true })).toBeVisible()
  await expect(node(page, 'build')).toContainText('High')
  await expect(node(page, 'gate').getByText('changed', { exact: true })).toHaveCount(0)
})

test('Review opens into its round: the phases in order, verify and the hunts side by side between a fork and a join (C2)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  const round = page.locator('[data-round="review"]')
  const phases = [
    'review.spec',
    'review.env',
    'review.verify',
    'review.hunt-a',
    'review.hunt-b',
    'review.refute',
    'review.merge',
  ]
  const found = await round
    .locator('[data-step]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-step')))
  expect(found).toEqual([...phases, 'review.fix', 'review.gate'])
  expect(
    await Promise.all(
      phases.map(async (id) => (await node(page, id).getAttribute('aria-label'))!.split(',')[0]),
    ),
  ).toEqual([
    '5.1 Spec',
    '5.2 Environment',
    '5.3 Verify',
    '5.4 Hunt A',
    '5.5 Hunt B',
    '5.6 Refute',
    '5.7 Merge check',
  ])

  const b = Object.fromEntries(
    await Promise.all(found.map(async (id) => [id!, await box(node(page, id!))] as const)),
  )
  // One column down: spec, environment, then the row, then refute and merge below it.
  expect(b['review.env']!.y).toBeGreaterThan(b['review.spec']!.y + b['review.spec']!.height - 2)
  const row = ['review.verify', 'review.hunt-a', 'review.hunt-b'].map((id) => b[id]!)
  for (const r of row) {
    expect(Math.abs(r.y - row[0]!.y), 'the row has one top').toBeLessThanOrEqual(2)
    expect(r.y).toBeGreaterThan(b['review.env']!.y + b['review.env']!.height)
  }
  // Side by side, none over another.
  expect(row[0]!.x + row[0]!.width).toBeLessThanOrEqual(row[1]!.x)
  expect(row[1]!.x + row[1]!.width).toBeLessThanOrEqual(row[2]!.x)
  const bottom = Math.max(...row.map((r) => r.y + r.height))
  expect(b['review.refute']!.y).toBeGreaterThanOrEqual(bottom)
  expect(b['review.merge']!.y).toBeGreaterThan(b['review.refute']!.y)
  // The fork leaves the environment and reaches the three; the join takes them into refute.
  await expect(page.locator('[data-parallel]')).toHaveCount(1)
  await expect(page.locator('[data-parallel]')).toContainText('In parallel')
  const fork = await box(page.locator('[data-edge="review.env>fork"]'))
  expect(fork.y).toBeGreaterThanOrEqual(b['review.env']!.y + b['review.env']!.height - 2)
  expect(fork.y + fork.height).toBeLessThanOrEqual(row[0]!.y + 2)
  expect(fork.x).toBeLessThanOrEqual(centreX(row[0]!) + 2)
  expect(fork.x + fork.width).toBeGreaterThanOrEqual(centreX(row[2]!) - 2)
  const join = await box(page.locator('[data-edge="join>review.refute"]'))
  expect(join.y).toBeGreaterThanOrEqual(bottom - 2)
  expect(join.y + join.height).toBeLessThanOrEqual(b['review.refute']!.y + 2)
  // The whole round is on the column of the steps.
  const roundBox = await box(round)
  expect(Math.abs(centreX(roundBox) - centreX(await box(node(page, 'review'))))).toBeLessThan(4)
  expect(await scrollsSideways(page)).toBe(false)
})

test('the round loops back: the fix pass and the gate lead up to its start, labelled with the rounds the complexity gets (C3)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const label = page.locator('[data-loop-label]')
  await expect(label).toHaveText('1 round')
  const loop = await box(page.locator('[data-edge="loop"]'))
  const first = await box(node(page, 'review.spec'))
  const fix = await box(node(page, 'review.fix'))
  const gate = await box(node(page, 'review.gate'))
  // After the round's last phase come the fix pass and the gate, in order; the arrow goes back up past all of it.
  expect(fix.y).toBeGreaterThan((await box(node(page, 'review.merge'))).y)
  expect(gate.y).toBeGreaterThan(fix.y + fix.height - 2)
  expect(loop.y).toBeLessThanOrEqual(first.y)
  expect(loop.y + loop.height).toBeGreaterThanOrEqual(gate.y + gate.height)
  expect(loop.x).toBeGreaterThanOrEqual(centreX(gate) - 4)
  await expect(page.locator('[data-edge="review.merge>review.fix"]')).toBeAttached()
  await expect(page.locator('[data-edge="review.fix>review.gate"]')).toBeAttached()

  // The picker changes the label without a reload.
  await complexityTab(page, 'High').click()
  await expect(label).toHaveText('3 rounds')
  await complexityTab(page, 'Max').click()
  await expect(label).toHaveText('10 rounds')
  await complexityTab(page, 'Low').click()
  await expect(label).toHaveText('No review rounds on low')
  await expect(node(page, 'review')).toContainText('Skipped on low')
  await expect(page.locator('[data-round="review"]')).toHaveCSS('opacity', '0.6')
  // A round count of none for a complexity that is not low says so too, and the node says No review rounds.
  await ok(human.put(`/api/projects/${project.id}/workflow/standard`, { data: { rounds: { mid: 0 } } }))
  await complexityTab(page, 'Mid').click()
  await page.reload()
  await expect(label).toHaveText('No review rounds on mid')
  await expect(node(page, 'review')).toContainText('No review rounds')
})

test('the complexity picker changes what the graph shows: the rounds, and the steps a low ticket skips (F6)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  const picker = page.getByRole('tablist', { name: 'Complexity' })
  await expect(picker.getByRole('tab', { name: 'Mid' })).toHaveAttribute('aria-selected', 'true')
  await complexityTab(page, 'High').click()
  await expect(page.locator('[data-summary]')).toContainText('review: 3 rounds')
  expect((await names(page)).length).toBe(12)
  await complexityTab(page, 'Low').click()
  // Spec and Review are not run: no number, the numbering of the rest closes up.
  expect(await names(page)).toEqual([
    '1. Read and claim',
    'Spec',
    '2. Build',
    '3. Gate',
    'Review',
    '4. Preview',
    '5. Intent check',
    '6. Push',
    '7. Pull request',
    '8. CI',
    '9. Summary',
    '10. Hand-off',
  ])
  await expect(node(page, 'build').locator('[data-number]')).toHaveText('2')
  await expect(node(page, 'handoff').locator('[data-number]')).toHaveText('10')
  await expect(page.locator('[data-summary]')).toContainText('10 steps for a low ticket')
  // The choice is in the address, so a link can point at it.
  await expect(page).toHaveURL(/complexity=low/)
  await page.reload()
  await expect(picker.getByRole('tab', { name: 'Low' })).toHaveAttribute('aria-selected', 'true')
})

test('each preset has its own graph: Light, Thorough and Maximum (F7)', async ({ page, project }) => {
  // Light: eleven steps, one reviewer, nothing in parallel.
  await open(page, project.id, '?preset=light')
  expect(await labels(page)).toEqual(STANDARD.filter((l) => l !== 'Spec'))
  const light = page.locator('[data-round="review"]')
  expect(
    await light.locator('[data-step]').evaluateAll((els) => els.map((el) => el.getAttribute('data-step'))),
  ).toEqual(['review.reviewer', 'review.fix', 'review.gate'])
  await expect(page.locator('[data-parallel]')).toHaveCount(0)
  await expect(page.locator('[data-loop-label]')).toHaveText('1 round')

  // Thorough: thirteen steps, the test-writing pass, a security hunt in the row, the intent check in each round.
  await open(page, project.id, '?preset=thorough')
  const thorough = await labels(page)
  expect(thorough).toHaveLength(13)
  expect(thorough.slice(2, 5)).toEqual(['Build', 'Test-writing pass', 'Gate'])
  const row = ['review.verify', 'review.hunt-a', 'review.hunt-b', 'review.hunt-security']
  const tops4 = await Promise.all(row.map(async (id) => (await box(node(page, id))).y))
  for (const y of tops4) expect(Math.abs(y - tops4[0]!)).toBeLessThanOrEqual(2)
  await expect(page.locator('[data-parallel] [data-step="review.hunt-security"]')).toContainText(
    'Security hunt',
  )
  const refute = await box(node(page, 'review.refute'))
  expect(refute.y).toBeGreaterThan(tops4[0]!)
  await expect(node(page, 'review.intent')).toContainText('Intent check')
  expect((await box(node(page, 'review.intent'))).y).toBeGreaterThan(
    (await box(node(page, 'review.merge'))).y,
  )
  await expect(page.locator('[data-loop-label]')).toHaveText('2 rounds')
  expect(await scrollsSideways(page)).toBe(false)

  // Maximum: fourteen steps with the second spec, two full reviews drawn one after the other, high effort.
  await open(page, project.id, '?preset=maximum')
  const maximum = await labels(page)
  expect(maximum).toHaveLength(14)
  expect(maximum.slice(1, 3)).toEqual(['Spec', 'Second spec (independent)'])
  const first = page.locator('[data-group="review.first"]')
  const second = page.locator('[data-group="review.second"]')
  await expect(first).toContainText('First review')
  await expect(second).toContainText('Second review (different agent)')
  // The second review is not inside the first: its own frame, below it, one round around both.
  await expect(first.locator('[data-group="review.second"]')).toHaveCount(0)
  await expect(first.locator('[data-step^="review.second"]')).toHaveCount(0)
  const a = await box(first)
  const c = await box(second)
  expect(c.y).toBeGreaterThanOrEqual(a.y + a.height - 1)
  expect(Math.abs(centreX(a) - centreX(c))).toBeLessThan(4)
  await expect(page.locator('[data-round="review"] [data-group]')).toHaveCount(2)
  await expect(page.locator('[data-loop-label]')).toHaveText('3 rounds')
  await expect(page.locator('[data-loop-label]')).toHaveCount(1)
  await expect(first.locator('[data-parallel] [data-step="review.first.hunt-security"]')).toBeVisible()
  await expect(second.locator('[data-parallel] [data-step="review.second.hunt-security"]')).toBeVisible()
  const hunts = await Promise.all(
    ['verify', 'hunt-a', 'hunt-b', 'hunt-security'].map(
      async (n) => (await box(node(page, `review.first.${n}`))).y,
    ),
  )
  for (const y of hunts) expect(Math.abs(y - hunts[0]!)).toBeLessThanOrEqual(2)
  await expect(node(page, 'review.reconcile')).toContainText('Reconcile')
  expect((await box(node(page, 'review.reconcile'))).y).toBeGreaterThan(c.y + c.height - 2)
  for (const id of ['spec', 'spec2', 'build', 'tests', 'review'])
    await expect(node(page, id)).toContainText('High')
  await expect(node(page, 'intent')).toContainText('Low')
  expect(await scrollsSideways(page)).toBe(false)
})

test('clicking a node opens its settings in a panel beside the graph; another node swaps it; the close button and Escape close it (C5)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await expect(panel(page)).toHaveCount(0)
  await node(page, 'build').click()
  const side = page.getByRole('complementary', { name: '3. Build' })
  await expect(side).toBeVisible()
  await expect(node(page, 'build')).toHaveAttribute('aria-pressed', 'true')
  await expect(node(page, 'build')).toHaveAttribute('aria-current', 'true')
  await expect(node(page, 'spec')).toHaveAttribute('aria-pressed', 'false')
  // Beside the graph, not over any node.
  const p = await box(side)
  for (const id of ['claim', 'build', 'review', 'handoff']) {
    const n = await box(node(page, id))
    expect(n.x + n.width, `${id} ends before the panel`).toBeLessThanOrEqual(p.x)
  }
  // The graph did not move to make room.
  await expect(side.getByRole('combobox', { name: 'Team agent' })).toBeVisible()
  await expect(side.getByRole('combobox', { name: 'Effort' })).toContainText('Auto: medium')
  await expect(side.getByRole('switch', { name: 'Run Build' })).toBeVisible()
  await expect(side.getByRole('button', { name: 'Move up' })).toBeVisible()
  await expect(side.getByRole('button', { name: 'Move down' })).toBeVisible()
  await expect(side.locator('[data-what]')).toContainText('The builder writes the change')
  await expect(side.getByText('Auto follows the ticket')).toBeVisible()

  await node(page, 'preview').click()
  await expect(page.getByRole('complementary', { name: '6. Preview' })).toBeVisible()
  await expect(panel(page)).toHaveCount(1)
  await expect(node(page, 'build')).toHaveAttribute('aria-pressed', 'false')
  await expect(node(page, 'build')).not.toHaveAttribute('aria-current')
  await expect(node(page, 'preview')).toHaveAttribute('aria-pressed', 'true')

  await panel(page).getByRole('button', { name: 'Close' }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(node(page, 'preview')).toHaveAttribute('aria-pressed', 'false')
  await expect(node(page, 'preview')).toBeFocused()

  await node(page, 'build').click()
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(node(page, 'build')).toHaveAttribute('aria-pressed', 'false')
})

test('Escape on an open list closes the list and leaves the settings open (C5)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await select(page, 'build')
  await panel(page).getByRole('combobox', { name: 'Effort' }).click()
  await expect(page.getByRole('option', { name: 'High' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option', { name: 'High' })).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
})

test('the panel shows what a step does and the hand-off to the next, in the preset’s words and read-only (F5, A9)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const standard = await presetOf(human, project.id, 'standard')
  for (const s of standard.steps) {
    const side = await select(page, s.id)
    await expect(side.locator('[data-handoff-text]')).toHaveText(s.handoff)
    await expect(side.locator('[data-what]')).toHaveText(s.what)
  }
  await select(page, 'claim')
  await expect(panel(page)).toContainText('Hand-off to Spec')
  await select(page, 'build')
  await expect(panel(page)).toContainText('Hand-off to Gate')
  await select(page, 'handoff')
  await expect(panel(page)).toContainText('Result')

  // Nothing of the hand-off is editable: no button, no field, no counter, and a saved edit of a step's text is refused.
  await expect(page.getByRole('button', { name: /^Edit the .* hand-off/ })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: /hand-off instruction/i })).toHaveCount(0)
  await expect(page.getByText(/\d+\/4000/)).toHaveCount(0)
  const refused = await human.put(`/api/projects/${project.id}/workflow/standard`, {
    data: { steps: { build: { instructions: 'Hand over the diff and the criteria table.' } } },
  })
  expect(refused.status()).toBe(400)
})

test('the page offers no way to edit a hand-off or any text of a step, for every preset and complexity (A9)', async ({
  page,
  project,
  human,
}) => {
  for (const preset of ['light', 'standard', 'thorough', 'maximum'])
    for (const complexity of ['low', 'mid', 'high', 'max']) {
      await open(page, project.id, `?preset=${preset}&complexity=${complexity}`)
      await select(page, 'build')
      await expect(page.getByRole('textbox', { name: /hand-off instruction/i })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Edit the .*hand-off/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Reset the .* hand-off/ })).toHaveCount(0)
      await expect(page.getByText(/hand-off instruction/i)).toHaveCount(0)
      await expect(page.getByText(/\d+\/4000/)).toHaveCount(0)
    }
  // The reset dialog no longer lists hand-off instructions among what it clears.
  await ok(
    human.put(`/api/projects/${project.id}/workflow/standard`, {
      data: { steps: { ci: { enabled: false } } },
    }),
  )
  await open(page, project.id)
  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Reset the Standard workflow?')
  await expect(dialog).toContainText('Team agents')
  await expect(dialog).not.toContainText(/hand-off instruction/i)
})

test('a step is switched off and on in its panel, and a locked one shows why it cannot be (F8)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const side = await select(page, 'preview')
  const toggle = side.getByRole('switch', { name: 'Run Preview' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await saved(page)
  await expect(toggle).not.toBeChecked()
  await expect(node(page, 'preview')).toHaveAttribute('data-skipped', 'true')
  await expect(node(page, 'preview')).toContainText('Off')
  // The numbering skips it, and the panel and the node stay on the same step.
  await expect(node(page, 'preview').locator('[data-number]')).toHaveText('–')
  await expect(node(page, 'intent').locator('[data-number]')).toHaveText('6')
  await expect(page.locator('[data-summary]')).toContainText('11 steps')
  await expect(node(page, 'preview')).toHaveAttribute('aria-pressed', 'true')
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { preview: { enabled: false } },
  })
  await page.reload()
  await select(page, 'preview')
  await expect(panel(page).getByRole('switch', { name: 'Run Preview' })).not.toBeChecked()
  // And on again.
  await panel(page).getByRole('switch', { name: 'Run Preview' }).click()
  await saved(page)
  await expect(node(page, 'preview')).not.toHaveAttribute('data-skipped')
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)

  // Build is locked: its switch is on and cannot be turned off, and says why.
  await select(page, 'build')
  const build = panel(page).getByRole('switch', { name: 'Run Build' })
  await expect(build).toBeChecked()
  await expect(build).toBeDisabled()
  await expect(panel(page).locator('[data-lock-reason]')).toHaveText(
    'Locked: nothing is delivered without the change being built.',
  )
  await expectTooltip(
    build.locator('xpath=..'),
    'Locked: nothing is delivered without the change being built.',
  )
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)
  // The intent check is locked above low: its switch says whether it also runs for a low ticket.
  await select(page, 'intent')
  const intent = panel(page).getByRole('switch', { name: 'Also run Intent check on low tickets' })
  await expect(intent).toBeChecked()
  await expect(intent).toBeEnabled()
  await intent.click()
  await saved(page)
  await expect(node(page, 'intent').locator('[data-number]')).toHaveText('7')
  await complexityTab(page, 'Low').click()
  await expect(node(page, 'intent')).toHaveAttribute('data-skipped', 'true')
  await expect(node(page, 'intent')).toContainText('Off')
})

test("a step's effort is chosen from Auto, Low, Medium and High in its panel, and survives a reload; steps with no agent have none (F9)", async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const side = await select(page, 'build')
  const effort = side.getByRole('combobox', { name: 'Effort' })
  await expect(effort).toContainText('Auto: medium')
  await effort.click()
  await expect(page.getByRole('option')).toHaveText(['Auto', 'Low', 'Medium', 'High'])
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await saved(page)
  await expect(effort).toContainText('High')
  await expect(node(page, 'build')).toContainText('High')
  await expect(node(page, 'build').getByText('changed', { exact: true })).toBeVisible()
  await expect(side.getByText('changed', { exact: true })).toBeVisible()
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { build: { effort: 'high' } },
  })
  await page.reload()
  await select(page, 'build')
  await expect(panel(page).getByRole('combobox', { name: 'Effort' })).toContainText('High')
  // Back to Auto, which follows the complexity: Max reads as high.
  await panel(page).getByRole('combobox', { name: 'Effort' }).click()
  await page.getByRole('option', { name: 'Auto', exact: true }).click()
  await saved(page)
  await complexityTab(page, 'Max').click()
  await expect(panel(page).getByRole('combobox', { name: 'Effort' })).toContainText('Auto: high')
  await expect(node(page, 'build')).toContainText('Auto: high')
  // The ticket agent's own steps run no agent, so they have no effort or Team agent to pick.
  for (const id of ['claim', 'gate', 'preview', 'push', 'pr', 'ci', 'summary', 'handoff']) {
    await select(page, id)
    await expect(panel(page).getByRole('combobox')).toHaveCount(0)
    await expect(panel(page)).toContainText('The ticket agent does this itself')
  }
})

test('a Team agent is picked for a step in its panel, shown on the node, saved, and put back to the default (B1, C6)', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'acme-dev', instructions: 'Build well.' },
    }),
  )
  await ok(
    human.post(`/api/projects/${project.id}/agents`, { data: { name: 'builder', instructions: 'Build.' } }),
  )
  await open(page, project.id)
  const side = await select(page, 'build')
  const picker = side.getByRole('combobox', { name: 'Team agent' })
  await expect(picker).toContainText('Default (builder)')
  await picker.click()
  // The Team's agents, and the default, which names the agent it comes to.
  await expect(page.getByRole('option')).toHaveText(['Default (builder)', 'acme-dev', 'builder'])
  await page.getByRole('option', { name: 'acme-dev', exact: true }).click()
  await saved(page)
  await expect(picker).toContainText('acme-dev')
  await expect(node(page, 'build')).toContainText('acme-dev')
  await expect(node(page, 'build')).toContainText('builder')
  await expect(node(page, 'build')).toHaveAccessibleName(/agent acme-dev/)
  await expect(node(page, 'build').getByText('changed', { exact: true })).toBeVisible()
  const kept = await presetOf(human, project.id, 'standard')
  expect(kept.tweaks).toEqual({ agents: { build: 'acme-dev' } })
  expect(kept.steps.find((s) => s.id === 'build')!.teamAgent).toMatchObject({
    name: 'acme-dev',
    source: 'picked',
  })
  // What agents read follows the pick.
  await page.locator('[data-reads]').getByText('What agents read').click()
  await expect(page.locator('[data-reads]').getByLabel('Workflow text')).toContainText('acme-dev')
  // A reload keeps it.
  await page.reload()
  await expect(node(page, 'build')).toContainText('acme-dev')

  // The default entry clears the pick.
  await select(page, 'build')
  await panel(page).getByRole('combobox', { name: 'Team agent' }).click()
  await page.getByRole('option', { name: 'Default (builder)' }).click()
  await saved(page)
  await expect(node(page, 'build')).not.toContainText('acme-dev')
  const cleared = await presetOf(human, project.id, 'standard')
  expect(cleared.tweaked).toBe(false)
  expect(cleared.tweaks).toBeNull()
})

test('a Team agent picked for a step survives an effort saved after it, and a pick the Team lost is marked missing and can be cleared (B1, C6)', async ({
  page,
  project,
  human,
}) => {
  const agent = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'acme-dev', instructions: 'Build well.' },
    }),
  )
  await ok(
    human.put(`/api/projects/${project.id}/workflow/standard`, {
      data: { agents: { build: 'acme-dev', 'review.hunt-a': 'acme-dev' } },
    }),
  )
  await open(page, project.id)
  await expect(node(page, 'build')).toContainText('acme-dev')
  await expect(node(page, 'review.hunt-a')).toContainText('acme-dev')
  await expect(node(page, 'build').getByText('agent missing')).toHaveCount(0)
  // The page sends the picks back with the change it makes: an effort saved after a pick keeps the pick.
  const side = await select(page, 'build')
  await side.getByRole('combobox', { name: 'Effort' }).click()
  await page.getByRole('option', { name: 'High' }).click()
  await saved(page)
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { build: { effort: 'high' } },
    agents: { build: 'acme-dev', 'review.hunt-a': 'acme-dev' },
  })
  // The agent is deleted from the Team: the pick stays, and the node says it runs as if none were picked.
  await ok(human.delete(`/api/agents/${agent.id}`))
  await page.reload()
  await expect(node(page, 'build').getByText('agent missing')).toBeVisible()
  await expect(node(page, 'build')).toHaveAccessibleName(/agent missing/)
  await expect(node(page, 'build')).toContainText('builder')
  await expect(node(page, 'review.hunt-a').getByText('agent missing')).toBeVisible()
  await select(page, 'build')
  const warning = panel(page).locator('[data-missing]')
  await expect(warning).toContainText('acme-dev')
  await expect(warning).toContainText('runs as builder')
  // The missing name is still listed, so it can be seen and cleared.
  await panel(page).getByRole('combobox', { name: 'Team agent' }).click()
  await expect(page.getByRole('option', { name: 'acme-dev (not in the Team)' })).toBeVisible()
  await page.keyboard.press('Escape')
  expect((await presetOf(human, project.id, 'standard')).tweaks?.agents).toEqual({
    build: 'acme-dev',
    'review.hunt-a': 'acme-dev',
  })
  // Another change on the page is not refused for the missing pick.
  await select(page, 'ci')
  await panel(page).getByRole('switch', { name: 'Run CI' }).click()
  await saved(page)
  expect((await presetOf(human, project.id, 'standard')).tweaks?.agents).toEqual({
    build: 'acme-dev',
    'review.hunt-a': 'acme-dev',
  })
  // Choosing the default clears the missing pick.
  await select(page, 'build')
  await panel(page).getByRole('combobox', { name: 'Team agent' }).click()
  await page.getByRole('option', { name: /^Default/ }).click()
  await saved(page)
  await expect(node(page, 'build').getByText('agent missing')).toHaveCount(0)
  expect((await presetOf(human, project.id, 'standard')).tweaks?.agents).toEqual({
    'review.hunt-a': 'acme-dev',
  })
})

test('a phase of the review round has its Team agent to pick and nothing else to change (C8, B10)', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.post(`/api/projects/${project.id}/agents`, { data: { name: 'sec-hunter', instructions: 'Hunt.' } }),
  )
  await open(page, project.id)
  const side = await select(page, 'review.hunt-a')
  await expect(side).toContainText('5.4 Hunt A')
  await expect(side.getByRole('combobox', { name: 'Team agent' })).toContainText('Default (hunt)')
  await expect(side.locator('[data-what]')).toContainText('Applies the change-type checklists')
  // No effort, no switch, no move, no rounds.
  await expect(side.getByRole('combobox', { name: 'Effort' })).toHaveCount(0)
  await expect(side.getByRole('switch')).toHaveCount(0)
  await expect(side.getByRole('button', { name: /^Move/ })).toHaveCount(0)
  await expect(side.getByRole('spinbutton')).toHaveCount(0)
  await side.getByRole('combobox', { name: 'Team agent' }).click()
  await page.getByRole('option', { name: 'sec-hunter' }).click()
  await saved(page)
  await expect(node(page, 'review.hunt-a')).toContainText('sec-hunter')
  await expect(node(page, 'review.hunt-b')).not.toContainText('sec-hunter')
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    agents: { 'review.hunt-a': 'sec-hunter' },
  })
  // The ticket agent's own phases have no Team agent to pick.
  const gate = await select(page, 'review.gate')
  await expect(gate.getByRole('combobox')).toHaveCount(0)
  await expect(gate).toContainText('The ticket agent does this itself')
  // Maximum's two reviews are picked apart.
  await open(page, project.id, '?preset=maximum')
  await select(page, 'review.second.hunt-a')
  await panel(page).getByRole('combobox', { name: 'Team agent' }).click()
  await page.getByRole('option', { name: 'sec-hunter' }).click()
  await saved(page)
  await expect(node(page, 'review.second.hunt-a')).toContainText('sec-hunter')
  await expect(node(page, 'review.first.hunt-a')).not.toContainText('sec-hunter')
})

test('the order is changed with Move up and Move down in the panel, refused where it would break the flow, and kept (F11, C7)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const side = await select(page, 'preview')
  const up = side.getByRole('button', { name: 'Move up' })
  await expect(up).not.toHaveAttribute('aria-disabled')
  await up.click()
  await saved(page)
  const expected = [...STANDARD]
  ;[expected[4], expected[5]] = [expected[5]!, expected[4]!]
  expect(await labels(page)).toEqual(expected)
  // The panel stays on the step; the keyboard stays with it: on the arrow that moved it, or, as that one is
  // refused now (Preview cannot go above the Gate), on the other arrow.
  await expect(page.getByRole('complementary', { name: /Preview/ })).toBeVisible()
  await expect(node(page, 'preview')).toHaveAttribute('aria-pressed', 'true')
  await expect(side.getByRole('button', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true')
  await expect(side.getByRole('button', { name: 'Move down' })).toBeFocused()
  expect((await presetOf(human, project.id, 'standard')).order.slice(4, 6)).toEqual(['preview', 'review'])
  await page.reload()
  await expect(page.locator('[data-graph]')).toBeVisible()
  expect(await labels(page)).toEqual(expected)
  await expect(node(page, 'preview').getByText('changed', { exact: true })).toBeVisible()

  // Build cannot go above Spec; Read and claim and Hand-off keep the ends.
  await select(page, 'build')
  const build = panel(page).getByRole('button', { name: 'Move up' })
  await expect(build).toHaveAttribute('aria-disabled', 'true')
  await expectTooltip(build, 'Build must come after Spec')
  await expect(panel(page).locator('[data-move-reason]')).toContainText('Build must come after Spec')
  await build.click({ force: true })
  expect(await labels(page)).toEqual(expected)
  await select(page, 'claim')
  await expect(panel(page).getByRole('button', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true')
  await expectTooltip(
    panel(page).getByRole('button', { name: 'Move down' }),
    'Read and claim must stay first',
  )
  await select(page, 'handoff')
  await expect(panel(page).getByRole('button', { name: 'Move down' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expectTooltip(panel(page).getByRole('button', { name: 'Move up' }), 'Hand-off must stay last')

  // A refused button is still reachable by keyboard, so its reason can be read.
  await select(page, 'build')
  await panel(page).getByRole('button', { name: 'Move up' }).focus()
  await expect(panel(page).getByRole('button', { name: 'Move up' })).toBeFocused()
})

test('the review rounds are four number fields from 0 to 12 in the Review node’s panel, saved on change, with an error outside the range (C9, F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const group = roundsGroup(page)
  await expect(group.getByRole('spinbutton')).toHaveCount(4)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  await mid.fill('2')
  await saved(page)
  await expect(page.locator('[data-loop-label]')).toHaveText('2 rounds')
  expect((await presetOf(human, project.id, 'standard')).rounds.mid).toBe(2)
  await expect(group.getByText('changed', { exact: true })).toBeVisible()

  // Outside the range: the error is where it is typed, and nothing is saved.
  await mid.fill('13')
  await expect(group.getByRole('alert')).toContainText('Rounds are a whole number from 0 to 12')
  await expect(mid).toHaveAttribute('aria-invalid', 'true')
  await page.waitForTimeout(700)
  expect((await presetOf(human, project.id, 'standard')).rounds.mid).toBe(2)
  await mid.fill('')
  await expect(group.getByRole('alert')).toBeVisible()
  await mid.blur()
  await expect(mid).toHaveValue('2')
  await expect(group.getByRole('alert')).toHaveCount(0)

  // The other levels are saved too, and 0 is none.
  await group.getByRole('spinbutton', { name: /^High/ }).fill('0')
  await expect
    .poll(async () => (await presetOf(human, project.id, 'standard')).rounds)
    .toEqual({ low: 0, mid: 2, high: 0, max: 10 })
  await complexityTab(page, 'High').click()
  await expect(node(page, 'review')).toHaveAttribute('data-skipped', 'true')
  await expect(node(page, 'review')).toContainText('No review rounds')
  await expect(page.locator('[data-loop-label]')).toHaveText('No review rounds on high')
})

test('a refused save leaves every control on what the board holds, and the rounds field says it was not saved (C15, F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  await page.route(/\/api\/projects\/\d+\/workflow(\/standard)?$/, refuseSaves)
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'boom' })

  // The rounds: the count typed goes back to the saved one, the reason shows next to it.
  const group = roundsGroup(page)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  await mid.fill('5')
  await expect(group.getByRole('alert')).toHaveText('Not saved: boom')
  await expect(mid).toHaveValue('1')
  await expect(mid).not.toHaveAttribute('aria-invalid', 'true')
  const failure = await group.getByRole('alert').getAttribute('id')
  await expect(mid).toHaveAttribute('aria-describedby', failure!)
  await expect(toast.first()).toBeVisible()
  await expect(page.locator('[data-summary]')).toContainText('review: 1 round')
  await expect(page.locator('[data-loop-label]')).toHaveText('1 round')
  // Typing again clears the reason; a count that is refused again shows it again.
  await mid.fill('6')
  await expect(group.getByRole('alert')).toHaveCount(0)
  await expect(group.getByRole('alert')).toHaveText('Not saved: boom')
  await expect(mid).toHaveValue('1')
  // Leaving the field after a refusal leaves the saved count in it.
  await mid.fill('7')
  await mid.blur()
  await expect(mid).toHaveValue('1')

  // The effort, the Team agent, the switch and the move: each stays on what the board holds.
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'acme-dev', instructions: 'Build well.' },
    }),
  )
  await page.reload()
  await select(page, 'build')
  const effort = panel(page).getByRole('combobox', { name: 'Effort' })
  await expect(effort).toContainText('Auto: medium')
  await effort.click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await expect(toast.first()).toBeVisible()
  await expect(effort).toContainText('Auto: medium')
  await expect(node(page, 'build').getByText('changed', { exact: true })).toHaveCount(0)

  const agent = panel(page).getByRole('combobox', { name: 'Team agent' })
  await agent.click()
  await page.getByRole('option', { name: 'acme-dev' }).click()
  await expect(agent).toContainText('Default (builder)')
  await expect(node(page, 'build')).not.toContainText('acme-dev')

  await select(page, 'preview')
  const toggle = panel(page).getByRole('switch', { name: 'Run Preview' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(node(page, 'preview')).not.toHaveAttribute('data-skipped')

  await panel(page).getByRole('button', { name: 'Move up' }).click()
  await expect(toast.first()).toBeVisible()
  expect(await labels(page)).toEqual(STANDARD)

  // The preset's activation and the reset: nothing changes either.
  await page.locator('[data-preset="light"]').click()
  await page.getByRole('button', { name: 'Use this workflow' }).click()
  await expect(page.getByText('The project follows this workflow')).toHaveCount(0)
  await expect(page.locator('[data-preset="standard"]').getByText('Active')).toBeVisible()
  await expect(page.locator('[data-preset="light"]').getByText('Active')).toHaveCount(0)

  const preset = await presetOf(human, project.id, 'standard')
  expect(preset.tweaked).toBe(false)
  expect((await overview(human, project.id)).active).toBe('standard')
})

test('two quick changes one after the other both persist, the second built on the first (C15)', async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.post(`/api/projects/${project.id}/agents`, {
      data: { name: 'acme-dev', instructions: 'Build well.' },
    }),
  )
  await open(page, project.id)
  await select(page, 'build')
  // The first save is slow: the second change is made while it is out.
  let puts = 0
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts += 1
    if (puts === 1) await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await panel(page).getByRole('combobox', { name: 'Effort' }).click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await expect.poll(() => puts).toBe(1)
  await panel(page).getByRole('combobox', { name: 'Team agent' }).click()
  await page.getByRole('option', { name: 'acme-dev' }).click()
  await expect.poll(() => puts, { timeout: 10_000 }).toBe(2)
  await expect
    .poll(async () => (await presetOf(human, project.id, 'standard')).tweaks)
    .toEqual({ steps: { build: { effort: 'high' } }, agents: { build: 'acme-dev' } })
  await expect(node(page, 'build')).toContainText('acme-dev')
  await expect(node(page, 'build')).toContainText('High')
})

test('a count typed back to the saved one while the first is still being saved is saved too (F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const mid = roundsGroup(page).getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  // Each save takes a while, so the second count is typed while the first is out.
  const puts: unknown[] = []
  let done = 0
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts.push(route.request().postDataJSON())
    await new Promise((resolve) => setTimeout(resolve, 700))
    await route.continue()
    done += 1
  })
  await mid.fill('5')
  await expect.poll(() => puts.length).toBe(1)
  await mid.fill('1')
  await mid.blur()
  await expect.poll(() => done, { timeout: 10_000 }).toBe(2)
  expect(puts).toHaveLength(2)
  await expect(mid).toHaveValue('1')
  await expect(page.locator('[data-summary]')).toContainText('review: 1 round')
  expect((await presetOf(human, project.id, 'standard')).rounds.mid).toBe(1)
})

test('a count typed in another preset while the first preset’s save is out is saved, and each field is its own (F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const presets = page.getByRole('group', { name: 'Workflow presets' })
  const group = roundsGroup(page)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  const puts: string[] = []
  // Standard's save is slow; Thorough's answers at once.
  await page.route(/\/api\/projects\/\d+\/workflow\/(standard|thorough)$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts.push(route.request().url().split('/').at(-1)!)
    if (route.request().url().endsWith('/standard')) await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await expect(mid).toHaveValue('1')
  await mid.fill('3')
  await expect.poll(() => puts).toEqual(['standard'])
  await presets.getByRole('button', { name: /^Thorough/ }).click()
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Thorough workflow/)
  // Thorough's own field, with Thorough's own count: typing the count Standard is saving is a change here.
  await expect(mid).toHaveValue('2')
  await mid.fill('3')
  await mid.blur()
  await expect.poll(() => puts).toEqual(['standard', 'thorough'])
  await expect.poll(async () => (await presetOf(human, project.id, 'thorough')).rounds.mid).toBe(3)
  await expect.poll(async () => (await presetOf(human, project.id, 'standard')).rounds.mid).toBe(3)
  await expect(mid).toHaveValue('3')
  await expect(group.getByRole('alert')).toHaveCount(0)
})

test('a refusal of one preset’s save, arriving after the switch to another, is not shown under that preset’s field (F12)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const presets = page.getByRole('group', { name: 'Workflow presets' })
  const group = roundsGroup(page)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  let puts = 0
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts += 1
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'late' }),
    })
  })
  await mid.fill('3')
  await expect.poll(() => puts).toBe(1)
  await presets.getByRole('button', { name: /^Thorough/ }).click()
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Thorough workflow/)
  await expect(mid).toHaveValue('2')
  // The refusal lands (its toast says so); Thorough's untouched field says nothing about it.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'late' }).first()).toBeVisible()
  await page.waitForTimeout(300)
  await expect(group.getByRole('alert')).toHaveCount(0)
  await expect(mid).toHaveValue('2')
  // Back on Standard the field is a fresh one on the board's count.
  await presets.getByRole('button', { name: /^Standard/ }).click()
  await expect(mid).toHaveValue('1')
  await expect(group.getByRole('alert')).toHaveCount(0)
})

test('typing the saved count back while an older save is out and then refused leaves no "Not saved" (F12)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const group = roundsGroup(page)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  let puts = 0
  // The refusal is held until the saved count has been typed back, so it lands inside that count's debounce.
  let refuse: () => void = () => {}
  const held = new Promise<void>((resolve) => (refuse = resolve))
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts += 1
    await held
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'boom' }),
    })
  })
  await mid.fill('5')
  await expect.poll(() => puts).toBe(1)
  // The saved count is typed back, and the refusal lands before that count is saved on its own.
  await mid.fill('1')
  refuse()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'boom' }).first()).toBeVisible()
  await page.waitForTimeout(900)
  await expect(group.getByRole('alert')).toHaveCount(0)
  await expect(mid).toHaveValue('1')
  expect(puts).toBe(1)
})

test('a move saved after the person went on to another control does not take the focus back (F11)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'preview')
  // The move's answer is slow: the person is on another control by the time it lands.
  let moves = 0
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    moves += 1
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.continue()
  })
  await panel(page).getByRole('button', { name: 'Move up' }).click()
  await expect.poll(() => moves).toBe(1)
  const reads = page.locator('[data-reads] summary')
  await reads.focus()
  await saved(page)
  const expected = [...STANDARD]
  ;[expected[4], expected[5]] = [expected[5]!, expected[4]!]
  await expect.poll(() => labels(page)).toEqual(expected)
  // The answer landed while the person was on the disclosure: it kept the focus.
  await expect(reads).toBeFocused()
  await expect(page.locator('[data-move]:focus')).toHaveCount(0)
  expect((await presetOf(human, project.id, 'standard')).order.slice(4, 6)).toEqual(['preview', 'review'])
})

test('a count typed back to the saved one after the preset round trip, with the first save still out, is saved (F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await select(page, 'review')
  const presets = page.getByRole('group', { name: 'Workflow presets' })
  const group = roundsGroup(page)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  // Only the first save is slow; the field is made again while it is out.
  const puts: unknown[] = []
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    puts.push(route.request().postDataJSON())
    if (puts.length === 1) await new Promise((resolve) => setTimeout(resolve, 2500))
    await route.continue()
  })
  await mid.fill('4')
  await mid.blur()
  await expect.poll(() => puts.length).toBe(1)
  await presets.getByRole('button', { name: /^Thorough/ }).click()
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Thorough workflow/)
  await presets.getByRole('button', { name: /^Standard/ }).click()
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Standard workflow/)
  // The board still holds 1 as far as this field knows: typing 1 is a change from the 4 on its way.
  await mid.fill('1')
  await mid.blur()
  await expect.poll(() => puts.length, { timeout: 10_000 }).toBe(2)
  await expect.poll(async () => (await presetOf(human, project.id, 'standard')).rounds.mid).toBe(1)
  await expect(mid).toHaveValue('1')
  await expect(page.locator('[data-summary]')).toContainText('review: 1 round')
})

test('a refused move does not pull the focus onto a Move button when the order changes later (F11)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await select(page, 'preview')
  await page.route(/\/api\/projects\/\d+\/workflow\/standard$/, refuseSaves)
  await panel(page).getByRole('button', { name: 'Move up' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'boom' }).first()).toBeVisible()
  expect(await labels(page)).toEqual(STANDARD)
  // Another preset has another order: switching to it by keyboard keeps the focus on its card.
  const thorough = page
    .getByRole('group', { name: 'Workflow presets' })
    .getByRole('button', { name: /^Thorough/ })
  await thorough.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-graph]')).toHaveAccessibleName(/^Thorough workflow/)
  await expect(thorough).toBeFocused()
  await expect(page.locator('[data-move]:focus')).toHaveCount(0)
})

test("Reset this workflow clears only the viewed preset's changes, after a confirmation (F13, F14)", async ({
  page,
  project,
  human,
}) => {
  await ok(
    human.put(`/api/projects/${project.id}/workflow/standard`, {
      data: { steps: { ci: { enabled: false } } },
    }),
  )
  await ok(human.put(`/api/projects/${project.id}/workflow/light`, { data: { rounds: { mid: 3 } } }))
  await open(page, project.id)
  const presets = page.getByRole('group', { name: 'Workflow presets' })
  const card = (name: string) => presets.getByRole('button', { name: new RegExp(`^${name}`) })
  // A tweaked preset says so on its card, and each changed step carries a mark.
  await expect(card('Standard')).toContainText('Tweaked')
  await expect(card('Light')).toContainText('Tweaked')
  await expect(card('Thorough')).not.toContainText('Tweaked')
  await expect(card('Maximum')).not.toContainText('Tweaked')
  await expect(node(page, 'ci').getByText('changed', { exact: true })).toBeVisible()
  await expect(node(page, 'build').getByText('changed', { exact: true })).toHaveCount(0)

  // Cancelling the confirmation changes nothing.
  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Reset the Standard workflow?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(card('Standard')).toContainText('Tweaked')

  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset' }).click()
  await expect(card('Standard')).not.toContainText('Tweaked')
  await expect(node(page, 'ci').getByText('changed', { exact: true })).toHaveCount(0)
  await expect(node(page, 'ci')).not.toHaveAttribute('data-skipped')
  await expect(page.getByRole('button', { name: 'Reset this workflow' })).toBeDisabled()
  // The other preset keeps its change.
  await expect(card('Light')).toContainText('Tweaked')
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)
  expect((await presetOf(human, project.id, 'light')).tweaks).toEqual({ rounds: { mid: 3 } })
  await card('Light').click()
  await expect(page.getByRole('button', { name: 'Reset this workflow' })).toBeEnabled()
  await select(page, 'review')
  await expect(roundsGroup(page).getByRole('spinbutton', { name: /^Mid/ })).toHaveValue('3')
})

test('"What agents read" is closed, and when opened shows the text get_workflow serves for the preset and complexity shown (F15)', async ({
  page,
  project,
  human,
}) => {
  const ticket = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Reads it', complexity: 'high' } }),
  )
  await open(page, project.id, '?complexity=high')
  const reads = page.locator('[data-reads]')
  await expect(reads).not.toHaveAttribute('open')
  await expect(reads.getByLabel('Workflow text')).toBeHidden()
  await reads.getByText('What agents read').click()
  const text = reads.getByLabel('Workflow text')
  await expect(text).toBeVisible()
  // The project's own workflow for a high ticket: what the ticket's agent is served, to the letter.
  const served = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${ticket.id}`),
  )
  await expect(text).toContainText("# Workflow: Standard (the project's workflow)")
  expect(await text.textContent()).toBe(served.text)

  // Another preset and complexity: the text of a ticket that names that preset.
  await page
    .getByRole('group', { name: 'Workflow presets' })
    .getByRole('button', { name: /^Light/ })
    .click()
  await complexityTab(page, 'Low').click()
  await expect(text).toContainText('# Workflow: Light (set on the ticket')
  const light = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?preset=light&complexity=low`),
  )
  expect(await text.textContent()).toBe(light.text)
  // A change shows in the text.
  await select(page, 'ci')
  await panel(page).getByRole('switch', { name: 'Run CI' }).click()
  await saved(page)
  await expect(text).toContainText('CI - skipped: turned off on the Workflow page')
})

test('the graph has no drag, no canvas and no stored position: a drag moves nothing (C10)', async ({
  page,
  project,
  human,
}) => {
  await page.setViewportSize({ width: 1280, height: 1500 })
  await open(page, project.id)
  const before = await overview(human, project.id)
  const build = node(page, 'build')
  const at = await box(build)
  const claim = await box(node(page, 'claim'))
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
  await page.mouse.down()
  await page.mouse.move(at.x + at.width / 2 + 120, at.y + at.height / 2 + 200, { steps: 8 })
  await page.mouse.up()
  expect(await box(build)).toEqual(at)
  expect(await box(node(page, 'claim'))).toEqual(claim)
  expect(await labels(page)).toEqual(STANDARD)
  expect(await overview(human, project.id)).toEqual(before)
  // Nothing is draggable and there is no canvas to zoom or add nodes to.
  expect(await page.locator('[data-graph] [draggable="true"], [data-graph] canvas').count()).toBe(0)
  expect(
    await page
      .locator('[data-graph] [data-step]')
      .evaluateAll((els) => els.every((el) => el.getAttribute('draggable') !== 'true')),
  ).toBe(true)
  await expect(page.getByRole('button', { name: /add (a )?node|zoom|fit view/i })).toHaveCount(0)
  // No position is part of what is saved.
  for (const key of ['x', 'y', 'position', 'positions']) {
    const refused = await human.put(`/api/projects/${project.id}/workflow/standard`, { data: { [key]: 1 } })
    expect(refused.status(), key).toBe(400)
  }
})

test('every node is reached by Tab in reading order and works with Enter and Space; arrows are hidden and the graph is named (C12)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  await expect(page.locator('[data-graph]')).toHaveAccessibleName('Standard workflow for a mid ticket')
  const expected = graphNodes(resolveWorkflow('standard', null, 'mid', [])).map((n) => n.id)
  await node(page, 'claim').focus()
  const seen = ['claim']
  for (let i = 1; i < expected.length; i++) {
    await page.keyboard.press('Tab')
    seen.push(await page.evaluate(() => document.activeElement?.getAttribute('data-step') ?? '?'))
  }
  expect(seen).toEqual(expected)

  // Every node is a button with a name that reads its number, label, agent and state.
  await expect(page.getByRole('button', { name: '3. Build, agent builder, locked' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '2. Spec, agent spec, skipped on low tickets' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '5.3 Verify, agent verify' })).toBeVisible()

  // Enter opens the settings and the focus goes into them; Escape closes them and the focus is back on the node.
  await node(page, 'gate').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: '4. Gate' })).toBeVisible()
  await expect(node(page, 'gate')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: '4. Gate' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel(page).locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(node(page, 'gate')).toBeFocused()
  // Space does the same on another node.
  await node(page, 'push').focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('complementary', { name: '8. Push' })).toBeVisible()
  // The selected node is marked in ways that are not colour: the state and a thicker outline.
  await expect(node(page, 'push')).toHaveAttribute('aria-pressed', 'true')
  expect(await node(page, 'push').evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
})

test('the graph fits a phone, and a node opens its settings as a sheet that gives the focus back (C11, F16)', async ({
  page,
  project,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const complexity of ['max', 'low']) {
    await open(page, project.id, `?preset=maximum&complexity=${complexity}`)
    expect(await scrollsSideways(page), `Maximum at ${complexity} at 390px`).toBe(false)
    // Every node lies inside the screen and its words are not cut off.
    const nodes = await page.locator('[data-graph] [data-step]').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        const clipped = [...el.querySelectorAll<HTMLElement>('span')].some(
          (s) => s.scrollWidth > s.clientWidth + 1,
        )
        return { id: el.getAttribute('data-step')!, left: r.left, right: r.right, width: r.width, clipped }
      }),
    )
    expect(nodes.length).toBeGreaterThan(30)
    for (const n of nodes) {
      expect(n.left, `${n.id} starts inside the screen`).toBeGreaterThanOrEqual(0)
      expect(n.right, `${n.id} ends inside the screen`).toBeLessThanOrEqual(390)
      expect(n.width, `${n.id} is wide enough to read`).toBeGreaterThan(150)
      expect(n.clipped, `${n.id} is not cut off`).toBe(false)
    }
  }
  // Parallel rows stack on a phone, their cards one under the other and inside the dashed box that says why.
  await open(page, project.id, '?preset=maximum')
  const a = await box(node(page, 'review.first.hunt-a'))
  const b = await box(node(page, 'review.first.hunt-b'))
  expect(b.y).toBeGreaterThan(a.y + a.height - 2)
  await expect(page.locator('[data-parallel]').first()).toContainText('In parallel')

  // A node opens a bottom sheet: a modal dialog across the screen, scrollable inside, its controls reachable.
  const build = node(page, 'build')
  await build.scrollIntoViewIfNeeded()
  await build.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute('data-panel', 'sheet')
  await expect(sheet.getByRole('heading', { name: '4. Build' })).toBeVisible()
  const s = await box(sheet)
  expect(s.x).toBeGreaterThanOrEqual(-1)
  expect(s.x + s.width).toBeLessThanOrEqual(391)
  expect(s.width).toBeGreaterThanOrEqual(388)
  // (it slides in: wait for it to settle at the bottom of the screen)
  await expect
    .poll(async () => {
      const b = await box(sheet)
      return b.y + b.height
    })
    .toBeLessThanOrEqual(845)
  expect(await sheet.evaluate((el) => el.scrollHeight >= el.clientHeight)).toBe(true)
  expect(await scrollsSideways(page), 'with the sheet open').toBe(false)
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  for (const control of [
    sheet.getByRole('combobox', { name: 'Team agent' }),
    sheet.getByRole('combobox', { name: 'Effort' }),
    sheet.getByRole('switch', { name: 'Run Build' }),
    sheet.getByRole('button', { name: 'Move up' }),
    sheet.getByRole('button', { name: 'Move down' }),
  ]) {
    await control.scrollIntoViewIfNeeded()
    const c = await box(control)
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.x + c.width).toBeLessThanOrEqual(390)
  }
  // Closing with the button gives the focus back to the node; so do Escape and a tap outside.
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(build).toBeFocused()
  await build.click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(build).toBeFocused()
  await build.click()
  await expect(sheet).toBeVisible()
  await page.mouse.click(195, 20)
  await expect(sheet).toHaveCount(0)
  await expect(build).toBeFocused()

  // A selected node, then "What agents read" opened: still no sideways scroll.
  await node(page, 'review.second.hunt-security').scrollIntoViewIfNeeded()
  await node(page, 'review.second.hunt-security').click()
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Team agent' })).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('switch')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('[data-reads]').getByText('What agents read').click()
  await expect(page.locator('[data-reads]').getByLabel('Workflow text')).toBeVisible()
  expect(await scrollsSideways(page), 'the text panel at 390px').toBe(false)
  await complexityTab(page, 'Low').click()
  expect(await scrollsSideways(page), 'Low at 390px').toBe(false)
})

/** What a computed colour is as the browser paints it over `over`, as [r, g, b]. */
const paint = (page: Page, ...colors: string[]) =>
  page.evaluate((list) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.clearRect(0, 0, 1, 1)
    for (const c of list) {
      context.fillStyle = c
      context.fillRect(0, 0, 1, 1)
    }
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return [r!, g!, b!]
  }, colors)

for (const scheme of ['light', 'dark'] as const)
  test.describe(`in the ${scheme}`, () => {
    test.use({ colorScheme: scheme })
    test(`the graph is drawn on the ${scheme} theme: readable nodes, visible arrows, no sideways scroll (C14)`, async ({
      page,
      project,
    }) => {
      await open(page, project.id, '?preset=thorough')
      if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
      expect(await scrollsSideways(page)).toBe(false)
      await select(page, 'build')
      await expect(node(page, 'build').locator('[data-number]')).toBeVisible()
      const colors = await node(page, 'review.hunt-a').evaluate((el) => ({
        text: getComputedStyle(el).color,
        card: getComputedStyle(el).backgroundColor,
        page: getComputedStyle(document.body).backgroundColor,
      }))
      const text = await paint(page, colors.page, colors.card, colors.text)
      const card = await paint(page, colors.page, colors.card)
      const lum = (c: number[]) => (c[0]! + c[1]! + c[2]!) / 3
      // The words stand out from their card, whichever theme: light on dark, dark on light.
      expect(Math.abs(lum(text) - lum(card))).toBeGreaterThan(120)
      if (scheme === 'dark') {
        expect(lum(text)).toBeGreaterThan(150)
        expect(lum(card)).toBeLessThan(110)
      } else {
        expect(lum(text)).toBeLessThan(110)
        expect(lum(card)).toBeGreaterThan(150)
      }
      // Arrows, the fork and the loop-back are visible against what they are drawn on.
      const strokes = await page.locator('[data-edge]').evaluateAll((els) =>
        els
          .filter((el) => el.getBoundingClientRect().width > 0)
          .slice(0, 40)
          .map((el) => getComputedStyle(el).color),
      )
      expect(strokes.length).toBeGreaterThan(10)
      const ground = await page
        .locator('[data-round="review"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      const base = await paint(page, colors.page, ground)
      for (const stroke of new Set(strokes)) {
        const line = await paint(page, colors.page, ground, stroke)
        expect(Math.abs(lum(line) - lum(base)), `stroke ${stroke}`).toBeGreaterThan(50)
      }
      // The loop's own line: its border is drawn in the same stroke.
      const loopBorder = await page
        .locator('[data-edge="loop"]')
        .evaluate((el) => getComputedStyle(el).borderTopColor)
      expect(Math.abs(lum(await paint(page, colors.page, ground, loopBorder)) - lum(base))).toBeGreaterThan(
        50,
      )
      // No hard-coded white or black: the node's card is the theme's.
      expect(await node(page, 'build').evaluate((el) => el.className)).toMatch(/\bbg-card\b/)
    })
  })

test('the ticket page sets its own workflow, which the project can change under without moving it (G1, G3)', async ({
  page,
  project,
  human,
}) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Picks a workflow', complexity: 'high' },
    }),
  )
  const effective = (id: number) =>
    ok<WorkflowEffective>(human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${id}`))
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const select = page.getByRole('combobox', { name: 'Workflow' })
  await expect(select).toContainText("Project's workflow (Standard)")
  const line = page.locator('[data-workflow-line]')
  await expect(line).toContainText("Follows the project's workflow (Standard)")
  await expect(line.getByRole('link', { name: 'See the steps' })).toHaveAttribute(
    'href',
    new RegExp(`/projects/${project.id}/workflow\\?.*preset=standard`),
  )

  await select.click()
  await expect(page.getByRole('option')).toHaveText([
    "Project's workflow (Standard)",
    'Light',
    'Standard',
    'Thorough',
    'Maximum',
  ])
  await page.getByRole('option', { name: 'Thorough', exact: true }).click()
  await expect(select).toContainText('Thorough')
  await expect(line).toContainText('Follows the Thorough workflow, set on this ticket')
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).workflowPreset)
    .toBe('thorough')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toContainText('Thorough')

  // G3: the ticket's workflow is its own; the project's can change without moving it.
  let w = await effective(t.id)
  expect([w.preset, w.source, w.projectPreset]).toEqual(['thorough', 'ticket', 'standard'])
  await ok(human.put(`/api/projects/${project.id}/workflow`, { data: { preset: 'maximum' } }))
  w = await effective(t.id)
  expect([w.preset, w.source, w.projectPreset]).toEqual(['thorough', 'ticket', 'maximum'])
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toContainText('Thorough')
  await page.getByRole('combobox', { name: 'Workflow' }).click()
  await expect(page.getByRole('option').first()).toHaveText("Project's workflow (Maximum)")

  // Back to the project's: the first choice clears it, and the ticket follows the project again.
  await page.getByRole('option').first().click()
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toContainText("Project's workflow (Maximum)")
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).workflowPreset)
    .toBeNull()
  w = await effective(t.id)
  expect([w.preset, w.source]).toEqual(['maximum', 'project'])
})

test('the new-ticket dialog offers the workflow for a top-level ticket, and a lane has none (G2)', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  const select = dialog.getByRole('combobox', { name: 'Workflow' })
  await expect(select).toContainText("Project's workflow")
  await dialog.getByLabel('Title').fill('Made on Light')
  await select.click()
  await page.getByRole('option', { name: 'Light', exact: true }).click()
  await expect(select).toContainText('Light')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const rows = await ok<{ id: number; title: string; workflowPreset: string | null }[]>(
    human.get(`/api/projects/${project.id}/tickets`),
  )
  const made = rows.find((r) => r.title === 'Made on Light')!
  expect(made.workflowPreset).toBe('light')

  // The next one starts on the project's workflow again, and is stored with none.
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(select).toContainText("Project's workflow")
  await dialog.getByLabel('Title').fill('Made on the default')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const again = await ok<{ title: string; workflowPreset: string | null }[]>(
    human.get(`/api/projects/${project.id}/tickets`),
  )
  expect(again.find((r) => r.title === 'Made on the default')!.workflowPreset).toBeNull()

  // A lane takes its parent's workflow: its dialog has no such field.
  await page.goto(`/projects/${project.id}/features/${made.id}`)
  await page.getByRole('button', { name: 'New lane' }).click()
  await expect(page.getByRole('dialog').getByLabel('Title')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Workflow' })).toHaveCount(0)
  await page.getByRole('dialog').getByLabel('Title').fill('A lane')
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  const lane = (
    await ok<{ title: string; workflowPreset: string | null }[]>(
      human.get(`/api/projects/${project.id}/tickets?parentId=${made.id}`),
    )
  ).find((r) => r.title === 'A lane')
  expect(lane?.workflowPreset).toBe('light')
})
