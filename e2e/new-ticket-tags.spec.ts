import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/** The New ticket (or lane) dialog, opened, with its Tags field: the text input, the box and its chips. */
async function openDialog(page: Page, button = 'New ticket') {
  await page.getByRole('button', { name: button }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('Tags (optional)')
  const field = input.locator('..')
  // The Stage field shows once the project has loaded, and moves the Tags field (and Create) to their
  // place: what is measured is measured after that.
  if (button === 'New ticket') await expect(dialog.getByLabel('Stage')).toBeVisible()
  return { dialog, input, field, chips: field.locator(':scope > span') }
}

/** Every POST that would create a ticket, as the page sends them. */
function creates(page: Page) {
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/projects\/\d+\/tickets$/.test(r.url())) sent.push(r.url())
  })
  return sent
}

const rows = (human: APIRequestContext, projectId: number) =>
  ok<TicketRow[]>(human.get(`/api/projects/${projectId}/tickets`))

const empty = async (input: Locator, chips: Locator) => {
  await expect(chips).toHaveCount(0)
  await expect(input).toHaveValue('')
}

test('the Tags field of the New ticket dialog makes chips of what is typed', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  await expect(input).toHaveAttribute('placeholder', 'High, Forms')

  // Enter turns the text into a chip, in the field's box, and empties the text.
  await input.pressSequentially('High')
  await input.press('Enter')
  await expect(chips).toHaveText(['High'])
  await expect(input).toHaveValue('')
  await expect(dialog).toBeVisible()
  // A chip looks like a tag on the board: High in its severity colours.
  await expect(chips.first()).toHaveClass(/bg-red-500\/15/)
  await expect(chips.first()).toHaveClass(/text-red-700/)

  // A comma ends a tag; the comma is in no chip.
  await input.pressSequentially('Forms,')
  await expect(chips).toHaveText(['High', 'Forms'])
  await expect(input).toHaveValue('')

  // Text pasted (here filled in) at once is one chip per part, trimmed, empty parts left out.
  await input.fill('Login,  Safari ,')
  await expect(chips).toHaveText(['High', 'Forms', 'Login', 'Safari'])
  await expect(input).toHaveValue('')
  await input.fill(', ,')
  await expect(chips).toHaveCount(4)
  await expect(input).toHaveValue('')

  // A tag already there, in any casing, is not added again.
  await input.pressSequentially('high')
  await input.press('Enter')
  await expect(chips).toHaveText(['High', 'Forms', 'Login', 'Safari'])
  await expect(input).toHaveValue('')

  // Leaving the field makes a chip of the text.
  await input.pressSequentially('UI')
  await dialog.getByLabel('Title').click()
  await expect(chips).toHaveText(['High', 'Forms', 'Login', 'Safari', 'UI'])
  await expect(input).toHaveValue('')

  // × removes that chip alone, and neither submits nor closes the dialog.
  const sent = creates(page)
  const remove = dialog.getByRole('button', { name: 'Remove Login' })
  await expect(remove).toHaveAttribute('type', 'button')
  await remove.click()
  await expect(chips).toHaveText(['High', 'Forms', 'Safari', 'UI'])
  await expect(dialog).toBeVisible()

  // Backspace with text edits the text; in the empty text it removes the last chip.
  await input.pressSequentially('ab')
  await input.press('Backspace')
  await expect(input).toHaveValue('a')
  await expect(chips).toHaveCount(4)
  await input.press('Backspace')
  await expect(input).toHaveValue('')
  await expect(chips).toHaveCount(4)
  await input.press('Backspace')
  await expect(chips).toHaveText(['High', 'Forms', 'Safari'])

  // Enter with text makes a chip and does not create the ticket.
  await dialog.getByLabel('Title').fill('Chips everywhere')
  await input.pressSequentially('Mobile')
  await input.press('Enter')
  await expect(chips).toHaveText(['High', 'Forms', 'Safari', 'Mobile'])
  await expect(dialog).toBeVisible()
  expect(sent).toEqual([])
  expect(await rows(human, project.id)).toEqual([])

  // Create saves the chips, in their order, and the text not yet a chip.
  await input.fill('Desktop')
  await expect(input).toHaveValue('Desktop')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  expect(sent).toHaveLength(1)
  const [row] = await rows(human, project.id)
  expect(row).toMatchObject({ title: 'Chips everywhere' })
  expect(row!.tags).toEqual(['High', 'Forms', 'Safari', 'Mobile', 'Desktop'])

  // Opened again, the field is empty.
  const again = await openDialog(page)
  await empty(again.input, again.chips)
  await expect(again.input).toHaveAttribute('placeholder', 'High, Forms')
  // The label still reaches the text input, which takes the focus from the field before it by Tab.
  await expect(again.input).toHaveJSProperty('tagName', 'INPUT')
  await again.dialog.getByLabel('Stage').focus()
  await page.keyboard.press('Tab')
  await expect(again.input).toBeFocused()
})

test('Enter in the empty Tags field still creates the ticket, with its chips', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  await dialog.getByLabel('Title').fill('Submitted from the tags')
  await input.pressSequentially('Low')
  await input.press('Enter')
  await expect(chips).toHaveText(['Low'])
  await expect(dialog).toBeVisible()
  await input.press('Enter')
  await expect(dialog).toBeHidden()
  const [row] = await rows(human, project.id)
  expect(row).toMatchObject({ title: 'Submitted from the tags', tags: ['Low'] })
})

test('a refused Create keeps the chips, to fix and try again', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  await dialog.getByLabel('Title').fill('Too long a tag')
  // The server takes tags of at most 40 characters.
  const long = 'x'.repeat(41)
  await input.fill(`High, ${long},`)
  await expect(chips).toHaveText(['High', long])
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.locator('[data-sonner-toast]')).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(chips).toHaveText(['High', long])
  expect(await rows(human, project.id)).toEqual([])

  await dialog.getByRole('button', { name: `Remove ${long}` }).click()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await rows(human, project.id)
  expect(row!.tags).toEqual(['High'])
})

test('a new lane takes its tags as chips too', async ({ page, project, api, human }) => {
  const parent = await api.ticket({ title: 'The parent' })
  await page.goto(`/projects/${project.id}/features/${parent.id}`)
  const { dialog, input, chips } = await openDialog(page, 'New lane')
  await dialog.getByLabel('Title').fill('A lane with tags')
  await input.fill('Backend, Medium')
  await expect(chips).toHaveText(['Backend', 'Medium'])
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const lane = (await rows(human, project.id)).find((t) => t.title === 'A lane with tags')
  expect(lane).toMatchObject({ parentId: parent.id, tags: ['Backend', 'Medium'] })
})

test('a click in the Tags field around its chips goes to the text, and keeps the word being typed', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, field, chips } = await openDialog(page)
  await input.pressSequentially('High')
  await input.press('Enter')
  // The field's own box, beside its chips: its left padding.
  const box = (await field.boundingBox())!
  const at = { x: box.x + 4, y: box.y + box.height / 2 }
  expect(await field.evaluate((f, p) => document.elementFromPoint(p.x, p.y) === f, at)).toBe(true)

  // From another field, the click focuses the text.
  await dialog.getByLabel('Title').click()
  await page.mouse.click(at.x, at.y)
  await expect(input).toBeFocused()

  // Mid-word, it ends no tag: the caret goes to the end of the text and the word goes on.
  await page.keyboard.type('Fron')
  await page.keyboard.press('Home')
  await page.mouse.click(at.x, at.y)
  await expect(input).toBeFocused()
  await page.keyboard.type('tend')
  await expect(chips).toHaveText(['High'])
  await expect(input).toHaveValue('Frontend')
})

test('a press on the Tags label mid-word keeps the word whole', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  await dialog.getByLabel('Title').fill('Labelled')
  await input.pressSequentially('Fron')
  // The label puts the focus back in its own input: nothing left the field.
  await dialog.locator('label[for="tags"]').click({ delay: 80 })
  await expect(input).toBeFocused()
  await page.keyboard.type('tend')
  await expect(chips).toHaveCount(0)
  await expect(input).toHaveValue('Frontend')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const [row] = await rows(human, project.id)
  expect(row!.tags).toEqual(['Frontend'])
})

test('a press near the edge of Create with a word still typed creates the ticket', async ({
  page,
  project,
  human,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  const sent = creates(page)
  await dialog.getByLabel('Title').fill('Pressed at the top')
  await input.pressSequentially('High,Forms,')
  await expect(chips).toHaveText(['High', 'Forms'])
  // As a chip this word leaves no room for the text on its row, so the field grows by a row.
  await input.pressSequentially('Desktop')
  // A press near the top of the button, as a person's may land: the button must not move under the
  // pointer before it is released.
  const create = (await dialog.getByRole('button', { name: 'Create' }).boundingBox())!
  await page.mouse.move(create.x + create.width / 2, create.y + 4)
  await page.mouse.down()
  await page.waitForTimeout(80)
  await page.mouse.up()
  await expect(dialog).toBeHidden()
  expect(sent).toHaveLength(1)
  const [row] = await rows(human, project.id)
  expect(row).toMatchObject({ title: 'Pressed at the top', tags: ['High', 'Forms', 'Desktop'] })
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })

  test('a tap near the edge of Create with a word still typed creates the ticket', async ({
    page,
    project,
    human,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`/projects/${project.id}/features`)
    const { dialog, input, chips } = await openDialog(page)
    const sent = creates(page)
    await dialog.getByLabel('Title').fill('Tapped at the top')
    await input.pressSequentially('High,Forms,Safari,')
    await expect(chips).toHaveText(['High', 'Forms', 'Safari'])
    await input.pressSequentially('Desktop')
    const create = (await dialog.getByRole('button', { name: 'Create' }).boundingBox())!
    await page.touchscreen.tap(create.x + create.width / 2, create.y + 4)
    await expect(dialog).toBeHidden()
    expect(sent).toHaveLength(1)
    const [row] = await rows(human, project.id)
    expect(row).toMatchObject({ title: 'Tapped at the top', tags: ['High', 'Forms', 'Safari', 'Desktop'] })
  })
})

test('Tab out of the Tags field makes a chip of the text at once', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  const sent = creates(page)
  await input.pressSequentially('Mobile')
  await page.keyboard.press('Tab')
  await expect(input).not.toBeFocused()
  await expect(chips).toHaveText(['Mobile'])
  await expect(input).toHaveValue('')
  await expect(dialog).toBeVisible()
  expect(sent).toEqual([])
})

test('the word being typed in the Tags field outlasts a switch to another window', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, chips } = await openDialog(page)
  await input.pressSequentially('Fron')
  // A headless browser never loses the window's focus, so the page is told it has (as it reads it
  // during the blur a switch to another window or tab fires), and the text loses the focus.
  await page.evaluate(() => {
    document.hasFocus = () => false
    ;(document.activeElement as HTMLElement).blur()
  })
  await expect(input).not.toBeFocused()
  await expect(chips).toHaveCount(0)
  await expect(input).toHaveValue('Fron')

  // Back in the window, the word goes on.
  await page.evaluate(() => Reflect.deleteProperty(document, 'hasFocus'))
  await input.focus()
  await page.keyboard.type('tend')
  await expect(chips).toHaveCount(0)
  await expect(input).toHaveValue('Frontend')
  // Leaving it for another field still makes the chip.
  await dialog.getByLabel('Title').click()
  await expect(chips).toHaveText(['Frontend'])
  await expect(input).toHaveValue('')
})

for (const width of [375, 1280]) {
  test(`many chips wrap inside the Tags field at ${width}px`, async ({ page, project }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/projects/${project.id}/features`)
    const { dialog, input, field, chips } = await openDialog(page)
    const before = (await field.boundingBox())!
    await input.fill(
      'Accessibility, Performance, Internationalization, Documentation, Authentication, Notifications, Responsiveness, Observability,',
    )
    await expect(chips).toHaveCount(8)
    // The field and its chips, measured at once.
    const { box, boxes } = await field.evaluate((f) => {
      const rect = (e: Element) => e.getBoundingClientRect().toJSON() as DOMRect
      return { box: rect(f), boxes: [...f.querySelectorAll(':scope > span')].map(rect) }
    })
    expect(boxes).toHaveLength(8)
    expect(box.height).toBeGreaterThan(before.height)
    for (const c of boxes) {
      expect(c.x).toBeGreaterThanOrEqual(box.x)
      expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width)
      expect(c.y).toBeGreaterThanOrEqual(box.y)
      expect(c.y + c.height).toBeLessThanOrEqual(box.y + box.height)
    }
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true)
  })
}
