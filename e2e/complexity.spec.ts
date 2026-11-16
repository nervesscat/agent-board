import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { expect, expectTooltip, ok, test } from './fixtures'

const SELECT_HINT =
  'Low: no review. Mid: one review round. High: up to three. Max: up to ten rounds, for work built from scratch; a feature in an existing codebase is never max, however difficult.'
const CHIP_HINT = {
  Low: 'Low: no review. The builder verifies it itself.',
  Mid: 'Mid: one review round.',
  High: 'High: up to three review rounds.',
  Max: 'Max: up to ten review rounds, for a whole site or app built from scratch, a new product or a standalone service, and it stops at the first round that survives. A feature in an existing codebase is at most high, however difficult.',
} as const

async function box(el: Locator) {
  const b = await el.boundingBox()
  expect(b, 'the element is drawn').not.toBeNull()
  return b!
}

/** Whether the page itself scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** Whether the dialog's form, the part that scrolls it, scrolls sideways. */
const formScrollsSideways = (dialog: Locator) =>
  dialog.locator('form').evaluate((form) => form.scrollWidth > form.clientWidth)

/** A ticket's card: its link, in whichever column it sits. */
const cardOf = (page: Page, title: string) => page.locator('[data-column]').getByRole('link', { name: title })

/** A ticket made over REST with the given fields. */
const ticketWith = (human: APIRequestContext, projectId: number, data: Record<string, unknown>) =>
  ok<TicketFull>(human.post(`/api/projects/${projectId}/tickets`, { data }))

/** The New ticket dialog, open on a project's features page. */
async function openNewTicket(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Stage')).toBeVisible()
  return dialog
}

test('in the New ticket dialog Complexity sits to the right of Stage on its row, and Stage is the narrower', async ({
  page,
  project,
}) => {
  const dialog = await openNewTicket(page, project.id)
  const at = async () => {
    const [stageLabel, complexityLabel, tagsLabel, stage, complexity, tags] = await Promise.all([
      box(dialog.getByText('Stage', { exact: true })),
      box(dialog.getByText('Complexity', { exact: true })),
      box(dialog.getByText('Tags (optional)', { exact: true })),
      box(dialog.getByLabel('Stage')),
      box(dialog.getByLabel('Complexity')),
      box(dialog.getByLabel('Tags (optional)')),
    ])
    return { stageLabel, complexityLabel, tagsLabel, stage, complexity, tags }
  }

  // Desktop: the three share the first row, Complexity beside Stage, Tags beside both.
  const desktop = await at()
  expect(
    Math.abs(desktop.complexityLabel.y - desktop.stageLabel.y),
    'Complexity on the row of Stage',
  ).toBeLessThanOrEqual(1)
  expect(desktop.complexity.x, 'Complexity starts past Stage').toBeGreaterThanOrEqual(
    desktop.stage.x + desktop.stage.width,
  )
  expect(
    Math.abs(desktop.tagsLabel.y - desktop.stageLabel.y),
    'Tags stays on the row of Stage',
  ).toBeLessThanOrEqual(1)
  expect(desktop.stage.width, 'Stage is narrower than the Tags field beside it').toBeLessThan(
    desktop.tags.width,
  )

  // A phone: one column, and the two still share a row without a sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 })
  const phone = await at()
  expect(
    Math.abs(phone.complexityLabel.y - phone.stageLabel.y),
    'Complexity on the row of Stage at 390px',
  ).toBeLessThanOrEqual(1)
  expect(phone.complexity.x, 'Complexity starts past Stage at 390px').toBeGreaterThanOrEqual(
    phone.stage.x + phone.stage.width,
  )
  expect(await formScrollsSideways(dialog), 'the dialog does not scroll sideways at 390px').toBe(false)
  expect(await scrollsSideways(page), 'the page does not scroll sideways at 390px').toBe(false)
})

test('the Complexity dropdown offers Low, Mid, High and Max, and opens on Mid each time, after a create too', async ({
  page,
  project,
}) => {
  const dialog = await openNewTicket(page, project.id)
  const level = dialog.getByRole('combobox', { name: 'Complexity' })
  await expect(level).toContainText('Mid')
  await level.click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(4)
  for (const [i, name] of ['Low', 'Mid', 'High', 'Max'].entries())
    await expect(options.nth(i)).toContainText(name)
  await page.getByRole('option', { name: 'Max', exact: true }).click()
  await expect(level).toContainText('Max')

  // Closed without a create, the next opening starts on Mid again.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(level).toContainText('Mid')

  // And after a create, the dialog opens on Mid too.
  await dialog.getByLabel('Title').fill('Mid after a create')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(level).toContainText('Mid')
  await expect(dialog.getByLabel('Title')).toHaveValue('')
})

test('the Complexity control explains the four levels on hover, with a tooltip and no title attribute', async ({
  page,
  project,
}) => {
  const dialog = await openNewTicket(page, project.id)
  const level = dialog.getByRole('combobox', { name: 'Complexity' })
  expect(await level.getAttribute('title')).toBeNull()
  await expectTooltip(level, SELECT_HINT)
})

test('a ticket made in the dialog at a level is stored at it, and its card shows that chip', async ({
  page,
  project,
  human,
}) => {
  const dialog = await openNewTicket(page, project.id)
  await dialog.getByLabel('Title').fill('Made high in the dialog')
  await dialog.getByRole('combobox', { name: 'Complexity' }).click()
  await page.getByRole('option', { name: 'High', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  // The top level, from the same select: it is stored as max and its card says so.
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(dialog.getByLabel('Complexity')).toContainText('Mid')
  await dialog.getByLabel('Title').fill('Made max in the dialog')
  await dialog.getByRole('combobox', { name: 'Complexity' }).click()
  await page.getByRole('option', { name: 'Max', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(rows.find((r) => r.title === 'Made high in the dialog')).toMatchObject({ complexity: 'high' })
  expect(rows.find((r) => r.title === 'Made max in the dialog')).toMatchObject({ complexity: 'max' })
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(cardOf(page, 'Made high in the dialog').getByText('High', { exact: true })).toBeVisible()
  await expect(cardOf(page, 'Made max in the dialog').getByText('Max', { exact: true })).toBeVisible()
})

test('every ticket card shows its level as a chip with its own hint, and a busy card keeps the chip inside it', async ({
  page,
  project,
  human,
}) => {
  await ticketWith(human, project.id, { title: 'Chip low card', complexity: 'low' })
  await ticketWith(human, project.id, { title: 'Chip mid card', complexity: 'mid' })
  await ticketWith(human, project.id, { title: 'Chip max card', complexity: 'max' })
  const busy = await ticketWith(human, project.id, {
    title: 'Chip busy card with every badge and tag',
    complexity: 'high',
    tags: ['Critical', 'API', 'Forms', 'Bug', 'Longer-tag-name'],
    tasks: [{ text: 'Get the key', blocked: true, blockedReason: 'Only the human has it' }, 'Build it'],
  })
  await ok(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Chip lane', parentId: busy.id } }),
  )
  const needed = await ticketWith(human, project.id, { title: 'Chip the busy one needs', complexity: 'mid' })
  await ok(human.patch(`/api/tickets/${busy.id}`, { data: { needs: [needed.id] } }))

  await page.goto(`/projects/${project.id}/features?view=board`)
  for (const [title, level] of [
    ['Chip low card', 'Low'],
    ['Chip mid card', 'Mid'],
    ['Chip busy card with every badge and tag', 'High'],
    ['Chip max card', 'Max'],
  ] as const) {
    const card = cardOf(page, title)
    const chip = card.getByText(level, { exact: true })
    await expect(chip).toHaveCount(1)
    expect(await chip.getAttribute('title')).toBeNull()
    const [c, k] = await Promise.all([box(card), box(chip)])
    expect(k.x, `${title}: chip inside the card, left`).toBeGreaterThanOrEqual(c.x)
    expect(k.x + k.width, `${title}: chip inside the card, right`).toBeLessThanOrEqual(c.x + c.width)
    expect(k.y, `${title}: chip inside the card, top`).toBeGreaterThanOrEqual(c.y)
    expect(k.y + k.height, `${title}: chip inside the card, bottom`).toBeLessThanOrEqual(c.y + c.height)
    await expectTooltip(chip, CHIP_HINT[level])
  }
  // Max reads as the top level: its chip is drawn differently from high's, and says what it is for.
  const maxChip = cardOf(page, 'Chip max card').getByText('Max', { exact: true })
  const highChip = cardOf(page, 'Chip busy card with every badge and tag').getByText('High', { exact: true })
  expect(await maxChip.getAttribute('class')).not.toBe(await highChip.getAttribute('class'))
})

test('the ticket page header sets the level: it persists after a reload, and the card shows it', async ({
  page,
  project,
  human,
}) => {
  const t = await ticketWith(human, project.id, { title: 'Header level', complexity: 'mid' })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const level = page.getByRole('combobox', { name: 'Complexity' })
  await expect(level).toContainText('Mid')
  await level.click()
  await page.getByRole('option', { name: 'Low', exact: true }).click()
  await expect(level).toContainText('Low')

  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Complexity' })).toContainText('Low')
  expect((await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).complexity).toBe('low')
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(cardOf(page, 'Header level').getByText('Low', { exact: true })).toBeVisible()

  // The top level is set from the header too, and survives a reload.
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await page.getByRole('combobox', { name: 'Complexity' }).click()
  await page.getByRole('option', { name: 'Max', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Complexity' })).toContainText('Max')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Complexity' })).toContainText('Max')
  expect((await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).complexity).toBe('max')
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(cardOf(page, 'Header level').getByText('Max', { exact: true })).toBeVisible()
})
