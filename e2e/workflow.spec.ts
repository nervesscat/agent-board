import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketFull, WorkflowEffective, WorkflowOverview } from '#/lib/api'
import { expect, expectTooltip, ok, test } from './fixtures'

/**
 * The Workflow page: the workflow as a tree of steps (their sub-steps, the hand-offs between them) with the core
 * settings editable on it, and a ticket naming a workflow of its own.
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

/** The page, open with its tree drawn. */
async function open(page: Page, projectId: number, search = '') {
  await page.goto(url(projectId, search))
  await expect(page.getByRole('tree')).toBeVisible()
}

/** The tree's top-level nodes. */
const tops = (page: Page) => page.locator('[role="tree"] > [role="treeitem"]')
/** One step's node, by its id. */
const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`)
/** Every top-level node's name as the tree reads it: its number and label, `1. Read and claim`. */
const names = (page: Page) =>
  tops(page).evaluateAll((els) =>
    els.map((el) => document.getElementById(el.getAttribute('aria-labelledby')!)!.textContent!.trim()),
  )
/** The labels alone, without the numbers. */
const labels = async (page: Page) => (await names(page)).map((n) => n.replace(/^\d+\.\s*/, ''))
/** A node's own title: the label of a treeitem, by the name it is read as. */
const item = (page: Page, name: string | RegExp) => page.getByRole('treeitem', { name })
/** What the board has saved, for every preset. */
const overview = (human: APIRequestContext, projectId: number) =>
  ok<WorkflowOverview>(human.get(`/api/projects/${projectId}/workflow`))
const presetOf = async (human: APIRequestContext, projectId: number, id: string) =>
  (await overview(human, projectId)).presets.find((p) => p.id === id)!
const saved = (page: Page) => expect(page.getByText('Saved', { exact: true }).first()).toBeVisible()

/** Whether the page itself scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

async function box(el: Locator) {
  const b = await el.boundingBox()
  expect(b, 'the element is drawn').not.toBeNull()
  return b!
}

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
  await expect(page.getByRole('tree')).toBeVisible()
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

test('the page offers the four presets with their descriptions, and picking one shows its tree without making it active (F2)', async ({
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
  // Standard is the project's, and the tree shown.
  await expect(buttons.nth(1)).toContainText('Active')
  await expect(buttons.nth(0)).not.toContainText('Active')
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true')

  await buttons.nth(0).click()
  await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('tree')).toHaveAccessibleName(/^Light workflow/)
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
  await expect(page.getByRole('tree')).toHaveAccessibleName(/^Light workflow/)
  await expect(buttons.nth(0)).toContainText('Active')
})

test('the workflow is a tree: numbered steps with their agent, effort, lock and skipped notes, sub-steps as child nodes (F3)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  const tree = page.getByRole('tree')
  await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-level', '1')
  const levels = await tree
    .getByRole('treeitem')
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('aria-level')))].sort())
  expect(levels).toEqual(['1', '2', '3'])

  // A node is named by its number and label.
  await expect(item(page, '3. Build')).toHaveAttribute('aria-level', '1')
  await expect(item(page, 'Hunt A')).toHaveAttribute('aria-level', '2')
  // A node of a step with parts says whether it is open; one without does not.
  await expect(step(page, 'review')).toHaveAttribute('aria-expanded', 'true')
  await expect(step(page, 'build')).not.toHaveAttribute('aria-expanded')

  const build = step(page, 'build')
  await expect(build.locator('[data-number]')).toHaveText('3')
  await expect(build).toContainText('builder')
  await expect(build.getByRole('combobox', { name: 'Effort of Build' })).toContainText('Auto: medium')
  await expect(build.getByText('Locked', { exact: true })).toBeVisible()
  await expect(step(page, 'claim')).toContainText('you')
  // A step run by the ticket agent has no effort to set.
  await expect(step(page, 'gate').getByRole('combobox')).toHaveCount(0)
  // The intent check is locked only above low, and runs at low effort.
  await expect(step(page, 'intent').getByText('Locked above low')).toBeVisible()
  await expect(step(page, 'intent').getByRole('combobox', { name: 'Effort of Intent check' })).toContainText(
    'Low',
  )
  // A step a low ticket skips says so, whichever complexity is shown.
  await expect(step(page, 'spec').getByText('Skipped on low')).toBeVisible()
  await expect(step(page, 'review').getByText('Skipped on low')).toBeVisible()
  await expect(step(page, 'build').getByText('Skipped on low')).toHaveCount(0)
})

test('Standard at Mid is twelve steps in the order agents run them; Review opens into its round (F4)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  expect(await names(page)).toEqual(STANDARD.map((label, i) => `${i + 1}. ${label}`))
  await expect(page.locator('[data-summary]')).toContainText('12 steps for a mid ticket')

  const review = step(page, 'review')
  await expect(review).toContainText('1 round')
  // The phases of a round, in order, numbered under the step.
  const phases = review.locator('[role="treeitem"][aria-level="2"][data-node^="review."]')
  const rows = await phases.evaluateAll((els) =>
    els.map((el) => [el.getAttribute('data-node'), el.getAttribute('aria-level')]),
  )
  expect(rows.map((r) => r[0])).toEqual([
    'review.spec',
    'review.env',
    'review.verify',
    'review.hunt-a',
    'review.hunt-b',
    'review.refute',
    'review.merge',
    'review.between',
  ])
  expect(
    await phases.evaluateAll((els) => els.slice(0, 7).map((el) => el.querySelector('[id]')!.textContent)),
  ).toEqual(['Spec', 'Environment', 'Verify', 'Hunt A', 'Hunt B', 'Refute', 'Merge check'])
  // Verify and the hunts run side by side.
  const parallel = review.locator('[data-parallel]')
  await expect(parallel).toContainText('In parallel')
  await expect(parallel.locator('[role="treeitem"]')).toHaveCount(3)
  await expect(parallel.locator('[data-node="review.verify"]')).toBeVisible()
  await expect(parallel.locator('[data-node="review.hunt-a"]')).toBeVisible()
  await expect(parallel.locator('[data-node="review.hunt-b"]')).toBeVisible()
  await expect(
    review.locator('[data-node="review.refute"]').locator('xpath=ancestor::*[@data-parallel]'),
  ).toHaveCount(0)
  // And between rounds: the fix pass, then the gate.
  const between = review.locator('[data-node="review.between"]')
  await expect(between).toContainText('Between rounds')
  await expect(between).toContainText('fix pass (builder) → gate (you) → next round')
  await expect(between.locator('[data-node="review.fix"]')).toContainText('builder')
  await expect(between.locator('[data-node="review.gate"]')).toContainText('you')

  // Each node opens and closes: the phases go with it.
  await review.getByRole('button', { name: 'Collapse Review' }).click()
  await expect(review).toHaveAttribute('aria-expanded', 'false')
  await expect(review.locator('[data-node="review.spec"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(review).toHaveAttribute('aria-expanded', 'true')
  await expect(review.locator('[data-node="review.spec"]')).toBeVisible()
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(review).toHaveAttribute('aria-expanded', 'false')
})

test('every step is followed by the hand-off to the next, with its instruction (F5)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const standard = await presetOf(human, project.id, 'standard')
  const connectors = page.locator('[data-handoff]')
  await expect(connectors).toHaveCount(12)
  for (const s of standard.steps) {
    const c = page.locator(`[data-handoff="${s.id}"]`)
    await expect(c.locator('[data-handoff-text]')).toHaveText(s.handoff)
  }
  await expect(page.locator('[data-handoff="claim"]')).toContainText('Hand-off to Spec')
  await expect(page.locator('[data-handoff="build"]')).toContainText('Hand-off to Gate')
  await expect(page.locator('[data-handoff="handoff"]')).toContainText('Result')
  // The connector sits between its step and the next one in the page.
  const [a, c, b] = await Promise.all([
    box(step(page, 'claim').locator('[data-number]')),
    box(page.locator('[data-handoff="claim"]')),
    box(step(page, 'spec').locator('[data-number]')),
  ])
  expect(c.y).toBeGreaterThan(a.y)
  expect(c.y).toBeLessThan(b.y)

  // An edited instruction is what the connector shows.
  await ok(
    human.put(`/api/projects/${project.id}/workflow/standard`, {
      data: { steps: { build: { instructions: 'Hand over the diff and the criteria table.' } } },
    }),
  )
  await page.reload()
  await expect(page.locator('[data-handoff="build"] [data-handoff-text]')).toHaveText(
    'Hand over the diff and the criteria table.',
  )
})

test('the complexity picker changes what the tree shows: the rounds, and the steps a low ticket skips (F6)', async ({
  page,
  project,
}) => {
  await open(page, project.id)
  const picker = page.getByRole('tablist', { name: 'Complexity' })
  await expect(picker.getByRole('tab', { name: 'Mid' })).toHaveAttribute('aria-selected', 'true')
  await expect(step(page, 'review')).toContainText('1 round')

  await picker.getByRole('tab', { name: 'High' }).click()
  await expect(step(page, 'review').getByText('3 rounds', { exact: true })).toBeVisible()
  await expect(page.locator('[data-summary]')).toContainText('review: 3 rounds')
  expect((await names(page)).length).toBe(12)

  await picker.getByRole('tab', { name: 'Max' }).click()
  await expect(step(page, 'review').getByText('10 rounds', { exact: true })).toBeVisible()

  await picker.getByRole('tab', { name: 'Low' }).click()
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
  await expect(step(page, 'spec').locator('[data-number]')).toHaveText('–')
  await expect(step(page, 'review').locator('[data-number]')).toHaveText('–')
  await expect(step(page, 'build').locator('[data-number]')).toHaveText('2')
  await expect(step(page, 'handoff').locator('[data-number]')).toHaveText('10')
  await expect(step(page, 'spec')).toHaveAttribute('data-skipped', 'true')
  await expect(page.locator('[data-summary]')).toContainText('10 steps for a low ticket')
  await expect(step(page, 'review').getByText('1 round')).toHaveCount(0)
  // The choice is in the address, so a link can point at it.
  await expect(page).toHaveURL(/complexity=low/)
  await page.reload()
  await expect(picker.getByRole('tab', { name: 'Low' })).toHaveAttribute('aria-selected', 'true')
})

test('each preset has its own tree: Light, Thorough and Maximum (F7)', async ({ page, project }) => {
  // Light: eleven steps, one reviewer.
  await open(page, project.id, '?preset=light')
  expect(await labels(page)).toEqual(STANDARD.filter((l) => l !== 'Spec'))
  const light = step(page, 'review')
  const lightPhases = light.locator('[role="treeitem"][aria-level="2"][data-node^="review."]')
  expect(await lightPhases.evaluateAll((els) => els.map((el) => el.getAttribute('data-node')))).toEqual([
    'review.reviewer',
    'review.between',
  ])
  await expect(light.locator('[data-node="review.reviewer"]')).toContainText('Reviewer')
  for (const gone of ['spec', 'env', 'verify', 'hunt-a', 'refute', 'merge'])
    await expect(light.locator(`[data-node="review.${gone}"]`)).toHaveCount(0)
  await expect(light).toContainText('1 round')

  // Thorough: thirteen steps, the test-writing pass, a security hunt and the intent check in each round.
  await open(page, project.id, '?preset=thorough')
  const thorough = await labels(page)
  expect(thorough).toHaveLength(13)
  expect(thorough.slice(2, 5)).toEqual(['Build', 'Test-writing pass', 'Gate'])
  const review = step(page, 'review')
  await expect(review.locator('[data-parallel] [data-node="review.hunt-security"]')).toContainText(
    'Security hunt',
  )
  await expect(review.locator('[data-node="review.intent"]')).toContainText('Intent check')
  await expect(review).toContainText('2 rounds')

  // Maximum: fourteen steps with the second spec, a second full review by a different agent, high effort.
  await open(page, project.id, '?preset=maximum')
  const maximum = await labels(page)
  expect(maximum).toHaveLength(14)
  expect(maximum.slice(1, 3)).toEqual(['Spec', 'Second spec (independent)'])
  const max = step(page, 'review')
  await expect(max.locator('[data-node="review.first"]')).toContainText('First review')
  await expect(max.locator('[data-node="review.second"]')).toContainText('Second review (different agent)')
  await expect(
    max.locator('[data-node="review.second"] [data-node="review.second.hunt-security"]'),
  ).toBeVisible()
  await expect(max.locator('[data-node="review.reconcile"]')).toContainText('Reconcile')
  await expect(max).toContainText('3 rounds')
  for (const id of ['spec', 'spec2', 'build', 'tests', 'review'])
    await expect(step(page, id).getByRole('combobox')).toContainText('High')
  await expect(step(page, 'intent').getByRole('combobox')).toContainText('Low')
})

test('a step is switched off and on, and a locked one shows why it cannot be (F8)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const preview = step(page, 'preview')
  const toggle = preview.getByRole('switch', { name: 'Run Preview' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await saved(page)
  await expect(toggle).not.toBeChecked()
  await expect(preview).toHaveAttribute('data-skipped', 'true')
  await expect(preview.getByText('Off', { exact: true })).toBeVisible()
  // The numbering skips it.
  await expect(preview.locator('[data-number]')).toHaveText('–')
  await expect(step(page, 'intent').locator('[data-number]')).toHaveText('6')
  await expect(page.locator('[data-summary]')).toContainText('11 steps')
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { preview: { enabled: false } },
  })
  await page.reload()
  await expect(step(page, 'preview').getByRole('switch', { name: 'Run Preview' })).not.toBeChecked()
  // And on again.
  await step(page, 'preview').getByRole('switch', { name: 'Run Preview' }).click()
  await saved(page)
  await expect(step(page, 'preview')).not.toHaveAttribute('data-skipped')
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)

  // Build is locked: its switch is on and cannot be turned off, and says why.
  const build = step(page, 'build').getByRole('switch', { name: 'Run Build' })
  await expect(build).toBeChecked()
  await expect(build).toBeDisabled()
  await expectTooltip(
    step(page, 'build').getByRole('switch').locator('xpath=..'),
    'Locked: nothing is delivered without the change being built.',
  )
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)
  // The intent check is locked above low: its switch says whether it also runs for a low ticket.
  const intent = step(page, 'intent').getByRole('switch', { name: 'Also run Intent check on low tickets' })
  await expect(intent).toBeChecked()
  await expect(intent).toBeEnabled()
  await intent.click()
  await saved(page)
  await expect(step(page, 'intent').locator('[data-number]')).toHaveText('7')
  await page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name: 'Low' }).click()
  await expect(step(page, 'intent')).toHaveAttribute('data-skipped', 'true')
  await expect(step(page, 'intent').getByText('Off', { exact: true })).toBeVisible()
})

test("a step's effort is chosen from Auto, Low, Medium and High, and survives a reload; steps with no agent have none (F9)", async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const effort = step(page, 'build').getByRole('combobox', { name: 'Effort of Build' })
  await expect(effort).toContainText('Auto: medium')
  await effort.click()
  await expect(page.getByRole('option')).toHaveText(['Auto', 'Low', 'Medium', 'High'])
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await saved(page)
  await expect(effort).toContainText('High')
  await expect(step(page, 'build').getByText('edited', { exact: true })).toBeVisible()
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { build: { effort: 'high' } },
  })
  await page.reload()
  await expect(step(page, 'build').getByRole('combobox', { name: 'Effort of Build' })).toContainText('High')
  // Back to Auto, which follows the complexity: Max reads as high.
  await step(page, 'build').getByRole('combobox', { name: 'Effort of Build' }).click()
  await page.getByRole('option', { name: 'Auto', exact: true }).click()
  await saved(page)
  await page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name: 'Max' }).click()
  await expect(step(page, 'build').getByRole('combobox', { name: 'Effort of Build' })).toContainText(
    'Auto: high',
  )
  // The ticket agent's own steps run no agent, so they have no effort.
  for (const id of ['claim', 'gate', 'preview', 'push', 'pr', 'ci', 'summary', 'handoff'])
    await expect(step(page, id).getByRole('combobox')).toHaveCount(0)
})

test('a hand-off instruction is edited in place with a limit, reset to the default, and marked edited (F10)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const standard = await presetOf(human, project.id, 'standard')
  const def = standard.steps.find((s) => s.id === 'build')!.handoff
  const connector = page.locator('[data-handoff="build"]')
  await expect(connector.getByText('edited', { exact: true })).toHaveCount(0)
  await connector.getByRole('button', { name: 'Edit the Build hand-off' }).click()
  const field = connector.getByRole('textbox', { name: 'Build hand-off instruction' })
  await expect(field).toHaveValue(def)
  await expect(connector).toContainText(`${def.length}/4000`)

  // Past the limit: an error, and Save waits.
  await field.fill('x'.repeat(4003))
  await expect(connector.getByRole('alert')).toContainText('3 characters over the limit of 4000')
  await expect(connector.getByRole('button', { name: 'Save' })).toBeDisabled()
  // Cancel leaves it as it was.
  await connector.getByRole('button', { name: 'Cancel' }).click()
  await expect(connector.locator('[data-handoff-text]')).toHaveText(def)

  await connector.getByRole('button', { name: 'Edit the Build hand-off' }).click()
  await field.fill('Give the gate the commits and a table of criterion to check.')
  await connector.getByRole('button', { name: 'Save' }).click()
  await saved(page)
  await expect(connector.locator('[data-handoff-text]')).toHaveText(
    'Give the gate the commits and a table of criterion to check.',
  )
  await expect(connector.getByText('edited', { exact: true })).toBeVisible()
  // The step carries the marker too, and so does the preset on its card.
  await expect(step(page, 'build').getByText('edited', { exact: true }).first()).toBeVisible()
  expect((await presetOf(human, project.id, 'standard')).tweaks).toEqual({
    steps: { build: { instructions: 'Give the gate the commits and a table of criterion to check.' } },
  })
  await page.reload()
  await expect(page.locator('[data-handoff="build"] [data-handoff-text]')).toHaveText(
    'Give the gate the commits and a table of criterion to check.',
  )

  await page.getByRole('button', { name: 'Reset the Build hand-off to its default' }).click()
  await saved(page)
  await expect(page.locator('[data-handoff="build"] [data-handoff-text]')).toHaveText(def)
  await expect(page.locator('[data-handoff="build"]').getByText('edited', { exact: true })).toHaveCount(0)
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)
})

test('the order is changed with Move up and Move down, refused where it would break the flow, and kept (F11)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const up = step(page, 'preview').getByRole('button', { name: 'Move Preview up' })
  await expect(up).toBeEnabled()
  await up.click()
  await saved(page)
  const expected = [...STANDARD]
  ;[expected[4], expected[5]] = [expected[5]!, expected[4]!]
  expect(await labels(page)).toEqual(expected)
  // The keyboard stays with the step: on the arrow that moved it, or, as that one is refused now (Preview cannot
  // go above the Gate), on the other arrow.
  await expect(step(page, 'preview').getByRole('button', { name: 'Move Preview up' })).toBeDisabled()
  await expect(step(page, 'preview').getByRole('button', { name: 'Move Preview down' })).toBeFocused()
  expect((await presetOf(human, project.id, 'standard')).order.slice(4, 6)).toEqual(['preview', 'review'])
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  expect(await labels(page)).toEqual(expected)
  await expect(step(page, 'preview').getByText('edited', { exact: true }).first()).toBeVisible()

  // Build cannot go above Spec; Read and claim and Hand-off keep the ends.
  const build = step(page, 'build').getByRole('button', { name: 'Move Build up' })
  await expect(build).toBeDisabled()
  await expectTooltip(build, 'Build must come after Spec')
  await build.click({ force: true })
  expect(await labels(page)).toEqual(expected)
  await expect(step(page, 'claim').getByRole('button', { name: 'Move Read and claim up' })).toBeDisabled()
  await expectTooltip(
    step(page, 'claim').getByRole('button', { name: 'Move Read and claim down' }),
    'Read and claim must stay first',
  )
  await expect(step(page, 'handoff').getByRole('button', { name: 'Move Hand-off down' })).toBeDisabled()
  await expectTooltip(
    step(page, 'handoff').getByRole('button', { name: 'Move Hand-off up' }),
    'Hand-off must stay last',
  )

  // A refused button is still reachable by keyboard, so its reason can be read.
  await build.focus()
  await expect(build).toBeFocused()
})

test('the review rounds are four number fields from 0 to 12, saved on change, with an error outside the range (F12)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const group = page.getByRole('group', { name: 'Review rounds per complexity' })
  await expect(group.getByRole('spinbutton')).toHaveCount(4)
  const mid = group.getByRole('spinbutton', { name: /^Mid/ })
  await expect(mid).toHaveValue('1')
  await mid.fill('2')
  await saved(page)
  await expect(step(page, 'review').getByText('2 rounds', { exact: true })).toBeVisible()
  expect((await presetOf(human, project.id, 'standard')).rounds.mid).toBe(2)
  await expect(group.getByText('edited', { exact: true })).toBeVisible()

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
  await page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name: 'High' }).click()
  await expect(step(page, 'review')).toHaveAttribute('data-skipped', 'true')
  await expect(step(page, 'review').getByText('No review rounds', { exact: true })).toBeVisible()
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
  // A tweaked preset says so on its card, and each edited step carries a mark.
  await expect(card('Standard')).toContainText('Tweaked')
  await expect(card('Light')).toContainText('Tweaked')
  await expect(card('Thorough')).not.toContainText('Tweaked')
  await expect(card('Maximum')).not.toContainText('Tweaked')
  await expect(step(page, 'ci').getByText('edited', { exact: true })).toBeVisible()
  await expect(step(page, 'build').getByText('edited', { exact: true })).toHaveCount(0)

  // Cancelling the confirmation changes nothing.
  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Reset the Standard workflow?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(card('Standard')).toContainText('Tweaked')

  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset' }).click()
  await expect(card('Standard')).not.toContainText('Tweaked')
  await expect(step(page, 'ci').getByText('edited', { exact: true })).toHaveCount(0)
  await expect(step(page, 'ci')).not.toHaveAttribute('data-skipped')
  await expect(page.getByRole('button', { name: 'Reset this workflow' })).toBeDisabled()
  // The other preset keeps its change.
  await expect(card('Light')).toContainText('Tweaked')
  expect((await presetOf(human, project.id, 'standard')).tweaked).toBe(false)
  expect((await presetOf(human, project.id, 'light')).tweaks).toEqual({ rounds: { mid: 3 } })
  await card('Light').click()
  await expect(page.getByRole('button', { name: 'Reset this workflow' })).toBeEnabled()
  await expect(
    page
      .getByRole('group', { name: 'Review rounds per complexity' })
      .getByRole('spinbutton', { name: /^Mid/ }),
  ).toHaveValue('3')
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
  const panel = page.locator('[data-reads]')
  await expect(panel).not.toHaveAttribute('open')
  await expect(panel.getByLabel('Workflow text')).toBeHidden()
  await panel.getByText('What agents read').click()
  const text = panel.getByLabel('Workflow text')
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
  await page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name: 'Low' }).click()
  await expect(text).toContainText('# Workflow: Light (set on the ticket')
  const light = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?preset=light&complexity=low`),
  )
  expect(await text.textContent()).toBe(light.text)
  // A change shows in the text.
  await step(page, 'ci').getByRole('switch', { name: 'Run CI' }).click()
  await saved(page)
  await expect(text).toContainText('CI - skipped: turned off on the Workflow page')
})

test('the page fits a phone and works in the dark (F16)', async ({ page, project }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, project.id, '?preset=maximum')
  expect(await scrollsSideways(page), 'Maximum at 390px').toBe(false)
  // The controls of a node are reachable: inside the page, not cut off.
  for (const id of ['claim', 'review', 'handoff']) {
    await step(page, id).scrollIntoViewIfNeeded()
    const toggle = await box(step(page, id).locator('[role="switch"]'))
    expect(toggle.x).toBeGreaterThanOrEqual(0)
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(390)
    const up = await box(step(page, id).getByRole('button', { name: /^Move .* up$/ }))
    expect(up.x).toBeGreaterThanOrEqual(0)
  }
  await page.getByRole('button', { name: 'Edit the Build hand-off' }).click()
  expect(await scrollsSideways(page), 'editing a hand-off at 390px').toBe(false)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('[data-reads]').getByText('What agents read').click()
  await expect(page.locator('[data-reads]').getByLabel('Workflow text')).toBeVisible()
  expect(await scrollsSideways(page), 'the text panel at 390px').toBe(false)
  await page.getByRole('tablist', { name: 'Complexity' }).getByRole('tab', { name: 'Low' }).click()
  expect(await scrollsSideways(page), 'Low at 390px').toBe(false)
})

test.describe('in the dark', () => {
  test.use({ colorScheme: 'dark' })
  test('the tree is drawn on the dark theme', async ({ page, project }) => {
    await open(page, project.id)
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    expect(await scrollsSideways(page)).toBe(false)
    await expect(step(page, 'build').locator('[data-number]')).toBeVisible()
    // The text of the tree is light on the dark page (a colour as the browser paints it, whatever syntax it is in).
    const brightness = await page.getByRole('tree').evaluate((el) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      context.fillStyle = getComputedStyle(el).color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      return (r! + g! + b!) / 3
    })
    expect(brightness).toBeGreaterThan(150)
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
