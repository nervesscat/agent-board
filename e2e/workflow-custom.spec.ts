import type { APIRequestContext, Page } from '@playwright/test'

import type { TicketFull, WorkflowEffective, WorkflowOverview } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/**
 * The project's own workflows on the Workflow page: duplicate a preset into one, name it, rename it, delete
 * it, add and remove steps of the kinds the board has, use it for the project and for a ticket, and what the
 * page and the ticket say when a workflow they used is gone.
 */

const url = (projectId: number, search = '') => `/projects/${projectId}/workflow${search}`
const node = (page: Page, id: string) => page.locator(`[data-step="${id}"]`)
const tops = (page: Page) => page.locator('[data-graph] > ol > li > [data-step]')
const labels = async (page: Page) =>
  (
    await tops(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label')!.split(',')[0]!.trim()),
    )
  ).map((n) => n.replace(/^\d+\.\s*/, ''))
const cards = (page: Page) => page.getByRole('group', { name: 'Workflow presets' })
const overview = (human: APIRequestContext, projectId: number) =>
  ok<WorkflowOverview>(human.get(`/api/projects/${projectId}/workflow`))
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** The page, open with its graph drawn. */
async function open(page: Page, projectId: number, search = '') {
  await page.goto(url(projectId, search))
  await expect(page.locator('[data-graph]')).toBeVisible()
}

/** Makes a workflow through the dialog, as a person does; its id. */
async function create(page: Page, name: string, from: string) {
  await page.getByRole('button', { name: 'New workflow' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('combobox', { name: 'Start from' }).click()
  await page.getByRole('option', { name: from, exact: true }).click()
  await dialog.getByRole('button', { name: 'Create workflow' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  const id = new URL(page.url()).searchParams.get('preset')!
  expect(id).toMatch(/^custom-/)
  return id
}

test('a workflow made from a preset sits after the four cards, with its steps and its own name (C1)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await expect(cards(page).getByRole('button')).toHaveCount(4)
  const id = await create(page, 'Our flow', 'Light')
  const buttons = cards(page).getByRole('button')
  await expect(buttons).toHaveCount(5)
  await expect(buttons.nth(4)).toContainText('Our flow')
  await expect(buttons.nth(4)).toContainText('Custom')
  await expect(buttons.nth(4)).toContainText('copied from Light')
  await expect(buttons.nth(4)).toHaveAttribute('aria-pressed', 'true')
  // Its graph is Light's: no spec step, one reviewer.
  expect(await labels(page)).toEqual([
    'Read and claim',
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
  ])
  const mine = (await overview(human, project.id)).presets.find((p) => p.id === id)!
  expect(mine.custom).toEqual({ base: 'light' })
  expect(mine.tweaked).toBe(false)
  // The preset was not changed by the copy, and the link names the new workflow.
  await expect(cards(page).locator('[data-preset="light"]')).not.toContainText('Tweaked')
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Our flow', exact: true })).toBeVisible()
})

test('a name that is taken or a preset’s is refused where it is typed, and nothing is made (C2)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await create(page, 'Our flow', 'Standard')
  await page.getByRole('button', { name: 'New workflow' }).click()
  const dialog = page.getByRole('dialog')
  for (const name of ['our FLOW', 'Light']) {
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByRole('button', { name: 'Create workflow' }).click()
    await expect(dialog.getByRole('alert')).toContainText('is already the name of a workflow')
  }
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  expect((await overview(human, project.id)).presets).toHaveLength(5)
})

test('a workflow is renamed, and the four presets have no way to be renamed or deleted (C3)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  for (const preset of ['light', 'standard', 'thorough', 'maximum']) {
    await cards(page).locator(`[data-preset="${preset}"]`).click()
    await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  }
  // Direct calls are refused too.
  expect(
    (
      await human.patch(`/api/projects/${project.id}/workflow/custom/standard`, { data: { name: 'X' } })
    ).status(),
  ).toBe(400)
  expect((await human.delete(`/api/projects/${project.id}/workflow/custom/standard`)).status()).toBe(400)

  const id = await create(page, 'Our flow', 'Standard')
  await page.getByRole('button', { name: 'Rename' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Name')).toHaveValue('Our flow')
  await dialog.getByLabel('Name').fill('Light')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel('Name').fill('Our renamed flow')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name: 'Our renamed flow', exact: true })).toBeVisible()
  await expect(cards(page).locator(`[data-preset="${id}"]`)).toContainText('Our renamed flow')
  expect((await overview(human, project.id)).presets.find((p) => p.id === id)!.label).toBe('Our renamed flow')
})

test('a step of a kind it lacks is added where it belongs, and a step that is not locked is removed (C4, C5)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const id = await create(page, 'Our flow', 'Light')
  const add = page.getByRole('combobox', { name: 'Add a step' })
  await add.click()
  await expect(page.getByRole('option')).toHaveText([
    'Spec',
    'Second spec (independent)',
    'Test-writing pass',
  ])
  await page.getByRole('option', { name: 'Test-writing pass' }).click()
  await expect(node(page, 'tests')).toBeVisible()
  expect(await labels(page)).toEqual([
    'Read and claim',
    'Build',
    'Test-writing pass',
    'Gate',
    'Review',
    'Preview',
    'Intent check',
    'Push',
    'Pull request',
    'CI',
    'Summary',
    'Hand-off',
  ])
  await expect
    .poll(async () => (await overview(human, project.id)).presets.find((p) => p.id === id)!.order)
    .toContain('tests')
  // It is a step like the others: its settings open, it can be moved, it has an effort and a Team agent.
  await node(page, 'tests').click()
  const panel = page.locator('[data-panel="side"]')
  await expect(panel.getByRole('combobox', { name: 'Team agent' })).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Effort' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Move down' })).toBeVisible()
  // Only the kinds it still lacks are offered.
  await add.click()
  await expect(page.getByRole('option')).toHaveText(['Spec', 'Second spec (independent)'])
  await page.keyboard.press('Escape')

  // A step with no lock is removed, and its kind can be added again.
  await node(page, 'preview').click()
  await panel.getByRole('button', { name: 'Remove step' }).click()
  await expect(node(page, 'preview')).toHaveCount(0)
  // The step is gone, so its settings close.
  await expect(panel).toHaveCount(0)
  expect(await labels(page)).not.toContain('Preview')
  await expect
    .poll(async () => (await overview(human, project.id)).presets.find((p) => p.id === id)!.order)
    .not.toContain('preview')
  await add.click()
  await expect(page.getByRole('option')).toContainText(['Spec', 'Second spec (independent)', 'Preview'])
  await page.keyboard.press('Escape')

  // A locked step says it cannot go and has no button for it.
  for (const locked of ['build', 'gate', 'intent', 'push', 'pr', 'summary', 'claim', 'handoff']) {
    await node(page, locked).click()
    await expect(panel.getByRole('button', { name: 'Remove step' })).toHaveCount(0)
    await expect(panel.locator('[data-remove-reason]')).toContainText('cannot be removed')
  }
  // The review goes too, with its phases, and nothing on the page asks for it.
  await node(page, 'review').click()
  await panel.getByRole('button', { name: 'Remove step' }).click()
  await expect(node(page, 'review')).toHaveCount(0)
  await expect(page.locator('[data-round="review"]')).toHaveCount(0)
  await page.reload()
  expect(await labels(page)).not.toContain('Review')
  expect(await labels(page)).toContain('Test-writing pass')
})

test('a preset has no Add a step and no Remove step: only a workflow of the project’s own has steps to change (C6)', async ({
  page,
  project,
}) => {
  await open(page, project.id, '?preset=standard')
  await expect(page.getByRole('combobox', { name: 'Add a step' })).toHaveCount(0)
  await node(page, 'preview').click()
  await expect(page.locator('[data-panel="side"]').getByRole('button', { name: 'Remove step' })).toHaveCount(
    0,
  )
})

test('the project follows a workflow of its own, a ticket names one, and deleting it falls back and says so (C7, C8)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const id = await create(page, 'Our flow', 'Thorough')
  await page.getByRole('button', { name: 'Use this workflow' }).click()
  await expect(page.getByText('The project follows this workflow')).toBeVisible()
  expect((await overview(human, project.id)).active).toBe(id)
  await expect(cards(page).locator(`[data-preset="${id}"]`)).toContainText('Active')

  // A ticket names it from its Details card.
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'On our flow', complexity: 'high' } }),
  )
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const select = page.getByRole('combobox', { name: 'Workflow' })
  await expect(select).toContainText("Project's workflow (Our flow)")
  await select.click()
  await expect(page.getByRole('option')).toHaveText([
    "Project's workflow (Our flow)",
    'Light',
    'Standard',
    'Thorough',
    'Maximum',
    'Our flow',
  ])
  await page.getByRole('option', { name: 'Our flow', exact: true }).click()
  const line = page.locator('[data-workflow-line]')
  await expect(line).toContainText('Follows the Our flow workflow, set on this ticket')
  await expect
    .poll(async () => (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).workflowPreset)
    .toBe(id)
  const served = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${t.id}`),
  )
  expect([served.preset, served.source, served.label, served.base]).toEqual([
    id,
    'ticket',
    'Our flow',
    'thorough',
  ])

  // Deleted from the Workflow page, after a confirmation.
  await open(page, project.id, `?preset=${id}`)
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete workflow' }).click()
  await expect(page.locator('[data-workflow-notice]')).toContainText('was deleted')
  await expect(page.locator('[data-workflow-notice]')).toContainText('Standard')
  await expect(cards(page).getByRole('button')).toHaveCount(4)
  await expect(cards(page).locator('[data-preset="standard"]')).toContainText('Active')
  const after = await overview(human, project.id)
  expect([after.active, after.fellBack]).toEqual(['standard', { id }])

  // The ticket follows the project's workflow, and its Details card says it fell back.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.locator('[data-workflow-line]')).toContainText('was deleted')
  await expect(page.locator('[data-workflow-line]')).toContainText(
    "follows the project's workflow (Standard)",
  )
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toContainText('Deleted workflow')
  const fell = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${t.id}`),
  )
  expect([fell.preset, fell.source, fell.fellBack]).toEqual(['standard', 'project', { id, of: 'ticket' }])
  // A link to the deleted workflow shows the project's own, and says it is not there.
  await open(page, project.id, `?preset=${id}`)
  await expect(page.locator('[data-workflow-notice]')).toBeVisible()
})

test('a workflow can be named on a new ticket, and Reset returns a custom one to how it was made (C9)', async ({
  page,
  project,
  human,
}) => {
  await open(page, project.id)
  const id = await create(page, 'Our flow', 'Standard')
  await page.getByRole('combobox', { name: 'Add a step' }).click()
  await page.getByRole('option', { name: 'Test-writing pass' }).click()
  await expect(node(page, 'tests')).toBeVisible()
  await page.getByRole('button', { name: 'Reset this workflow' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(node(page, 'tests')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name: 'Our flow', exact: true })).toBeVisible()

  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Made on our flow')
  await dialog.getByRole('combobox', { name: 'Workflow' }).click()
  await page.getByRole('option', { name: 'Our flow', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toHaveCount(0)
  const rows = await ok<{ title: string; workflowPreset: string | null }[]>(
    human.get(`/api/projects/${project.id}/tickets`),
  )
  expect(rows.find((r) => r.title === 'Made on our flow')!.workflowPreset).toBe(id)
})

for (const scheme of ['light', 'dark'] as const)
  test.describe(`in the ${scheme}`, () => {
    test.use({ colorScheme: scheme })
    test(`the cards, the custom controls and the graph fit on desktop and on a phone, ${scheme} (C10)`, async ({
      page,
      project,
    }) => {
      await page.setViewportSize({ width: 1280, height: 1000 })
      await open(page, project.id)
      await create(page, 'Our flow', 'Thorough')
      await page.getByRole('combobox', { name: 'Add a step' }).click()
      await page.keyboard.press('Escape')
      if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect(await scrollsSideways(page)).toBe(false)
      await node(page, 'preview').click()
      await expect(
        page.locator('[data-panel="side"]').getByRole('button', { name: 'Remove step' }),
      ).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`custom-desktop-${scheme}.png`), fullPage: true })

      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      await expect(page.locator('[data-graph]')).toBeVisible()
      expect(await scrollsSideways(page), 'the page at 390px').toBe(false)
      await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Add a step' })).toBeVisible()
      await node(page, 'preview').click()
      const sheet = page.locator('[data-panel="sheet"]')
      await expect(sheet.getByRole('button', { name: 'Remove step' })).toBeVisible()
      expect(await scrollsSideways(page), 'with the sheet open').toBe(false)
      await page.screenshot({ path: test.info().outputPath(`custom-phone-${scheme}.png`) })
    })
  })
