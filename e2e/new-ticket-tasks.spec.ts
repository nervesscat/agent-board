import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/** The New ticket (or lane) dialog, opened, with its Initial tasks field: the text input, + and the list. */
async function openDialog(page: Page, button = 'New ticket') {
  await page.getByRole('button', { name: button }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('Initial tasks')
  const list = dialog.getByRole('list', { name: 'Tasks', exact: true })
  return {
    dialog,
    input,
    add: dialog.getByRole('button', { name: 'Add task' }),
    list,
    items: list.getByRole('listitem'),
    create: dialog.getByRole('button', { name: 'Create' }),
  }
}

/** Every POST that would create a ticket, as the page sends them. */
function creates(page: Page) {
  const sent: string[][] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/projects\/\d+\/tickets$/.test(r.url()))
      sent.push((r.postDataJSON() as { tasks: string[] }).tasks)
  })
  return sent
}

const rows = (human: APIRequestContext, projectId: number) =>
  ok<TicketRow[]>(human.get(`/api/projects/${projectId}/tickets`))

/** The tasks of a ticket, as the server keeps them, in order. */
const tasksOf = async (human: APIRequestContext, id: number) =>
  (await ok<TicketFull>(human.get(`/api/tickets/${id}`))).tasks.map((t) => t.text)

/** The exact text of each listed task, without the whitespace `toHaveText` would forgive. */
const texts = (items: Locator) => items.evaluateAll((all) => all.map((li) => li.textContent))

test('the Initial tasks field lists each task added by Enter or by +, above the input', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, add, list, items } = await openDialog(page)
  const sent = creates(page)

  // One line of text, labelled, with a + button beside it; no textarea any more.
  await expect(input).toHaveJSProperty('tagName', 'INPUT')
  const field = dialog.locator('div', { has: dialog.locator('label[for="tasks"]') }).last()
  await expect(field.locator('textarea')).toHaveCount(0)
  await expect(add).toBeVisible()
  await expect(add).toHaveAttribute('type', 'button')
  await expect(add.locator('svg.lucide-plus')).toHaveCount(1)
  await expect(list).toHaveCount(0)

  // Enter adds the text as a task and empties the input, without submitting the dialog.
  await input.pressSequentially('Reproduce it')
  await input.press('Enter')
  await expect(items).toHaveText(['Reproduce it'])
  await expect(input).toHaveValue('')
  await expect(dialog).toBeVisible()

  // + does the same.
  await input.fill('Fix it')
  await add.click()
  await expect(items).toHaveText(['Reproduce it', 'Fix it'])
  await expect(input).toHaveValue('')
  await expect(dialog).toBeVisible()

  // Empty or blank text adds nothing, and + is off for it; Enter on it submits nothing either.
  await expect(add).toBeDisabled()
  await input.press('Enter')
  await input.fill('   ')
  await expect(add).toBeDisabled()
  await input.press('Enter')
  await expect(items).toHaveCount(2)
  await expect(dialog).toBeVisible()

  // A task is trimmed; each new one goes at the end of the list, just above the input.
  await input.fill('  Write tests  ')
  await input.press('Enter')
  expect(await texts(items)).toEqual(['Reproduce it', 'Fix it', 'Write tests'])
  const inputBox = (await input.boundingBox())!
  for (const item of await items.all()) {
    const box = (await item.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(inputBox.y)
  }

  // Nothing was created by any of it.
  expect(sent).toEqual([])
  expect(await rows(human, project.id)).toEqual([])
})

test('a task of the New ticket dialog is removed alone, and repeats stay separate tasks', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, items, create } = await openDialog(page)
  const sent = creates(page)
  for (const t of ['A', 'B', 'C']) {
    await input.fill(t)
    await input.press('Enter')
  }
  await expect(items).toHaveText(['A', 'B', 'C'])

  const remove = dialog.getByRole('button', { name: 'Remove B' })
  await expect(remove).toHaveAttribute('type', 'button')
  await remove.click()
  await expect(items).toHaveText(['A', 'C'])
  await expect(dialog).toBeVisible()
  expect(sent).toEqual([])

  // The same text twice is two tasks, on the dialog and on the ticket.
  await input.fill('Check')
  await input.press('Enter')
  await input.fill('Check')
  await input.press('Enter')
  await expect(items).toHaveText(['A', 'C', 'Check', 'Check'])
  // Removing one of the two leaves the other.
  await dialog.getByRole('button', { name: 'Remove Check' }).last().click()
  await expect(items).toHaveText(['A', 'C', 'Check'])
  await input.fill('Check')
  await input.press('Enter')

  await dialog.getByLabel('Title').fill('With repeats')
  await create.click()
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([['A', 'C', 'Check', 'Check']])
  const [row] = await rows(human, project.id)
  expect(await tasksOf(human, row!.id)).toEqual(['A', 'C', 'Check', 'Check'])
})

test('Create in the New ticket dialog sends the text still typed as the last task, and resets the field', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const first = await openDialog(page)
  await first.dialog.getByLabel('Title').fill('Typed and not added')
  await first.input.fill('A')
  await first.input.press('Enter')
  await first.input.fill(' B ')
  await first.create.click()
  await expect(first.dialog).toBeHidden()
  const [one] = await rows(human, project.id)
  expect(await tasksOf(human, one!.id)).toEqual(['A', 'B'])

  // Opened again, the field is empty.
  const second = await openDialog(page)
  await expect(second.items).toHaveCount(0)
  await expect(second.input).toHaveValue('')

  // Blank text left in the input adds no task.
  await second.dialog.getByLabel('Title').fill('Blank left over')
  await second.input.fill('A')
  await second.input.press('Enter')
  await second.input.fill('  ')
  await second.create.click()
  await expect(second.dialog).toBeHidden()
  const two = (await rows(human, project.id)).find((t) => t.title === 'Blank left over')
  expect(await tasksOf(human, two!.id)).toEqual(['A'])
})

test('a ticket made with no tasks in the New ticket dialog has none', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, create } = await openDialog(page)
  await dialog.getByLabel('Title').fill('Nothing to do yet')
  const sent = creates(page)
  await create.click()
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([[]])
  const [row] = await rows(human, project.id)
  expect(row!.rollup.total).toBe(0)
  expect(await tasksOf(human, row!.id)).toEqual([])
  const card = page.getByRole('link', { name: /Nothing to do yet/ })
  await expect(card).toBeVisible()
  await expect(card.getByText(/^\d+\/\d+$/)).toHaveCount(0)
})

test('a Create the server refuses keeps the tasks and the text typed, to fix and try again', async ({
  page,
  project,
  human,
}) => {
  // The long task wraps onto many lines; the window is tall enough to keep Create in it.
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, items, create } = await openDialog(page)
  await dialog.getByLabel('Title').fill('Too long a task')
  // The server takes tasks of at most 500 characters.
  const long = 'x'.repeat(501)
  await input.fill('Short')
  await input.press('Enter')
  await input.fill(long)
  await input.press('Enter')
  await input.fill('Still typed')
  await create.click()
  await expect(page.locator('[data-sonner-toast]')).toBeVisible()
  await expect(dialog).toBeVisible()
  expect(await texts(items)).toEqual(['Short', long])
  await expect(input).toHaveValue('Still typed')
  expect(await rows(human, project.id)).toEqual([])

  await dialog.getByRole('button', { name: `Remove ${long}` }).click()
  await create.click()
  await expect(dialog).toBeHidden()
  const [row] = await rows(human, project.id)
  expect(await tasksOf(human, row!.id)).toEqual(['Short', 'Still typed'])
})

test('Enter that ends an IME composition in the tasks input adds no task', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, items } = await openDialog(page)
  const sent = creates(page)
  await input.fill('かな')
  const enter = (init: { isComposing: boolean; keyCode?: number; compositionEnd?: boolean }) =>
    input.evaluate((el, { isComposing, keyCode, compositionEnd }) => {
      if (compositionEnd) {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'かな' }))
      }
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing,
        bubbles: true,
        cancelable: true,
      })
      // The constructor leaves keyCode at 0 whatever it is given.
      if (keyCode !== undefined) {
        Object.defineProperty(event, 'keyCode', { get: () => keyCode })
        Object.defineProperty(event, 'which', { get: () => keyCode })
      }
      el.dispatchEvent(event)
    }, init)

  await enter({ isComposing: true })
  await expect(input).toHaveValue('かな')
  await expect(items).toHaveCount(0)

  // Safari ends the composition before the keydown of the Enter that commits it, which then says
  // isComposing false, and only its keyCode 229 tells it is the IME's.
  await enter({ isComposing: false, keyCode: 229, compositionEnd: true })
  await expect(input).toHaveValue('かな')
  await expect(items).toHaveCount(0)

  // The same Enter once the composition is over is a task: the event does reach the field.
  await enter({ isComposing: false, keyCode: 13 })
  await expect(items).toHaveText(['かな'])
  await expect(input).toHaveValue('')
  await expect(dialog).toBeVisible()
  expect(sent).toEqual([])
})

test('text pasted with several lines into the tasks input adds one task per line', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { input, items } = await openDialog(page)
  await input.fill('First')
  await input.press('Enter')
  await input.fill('Sec')
  await input.evaluate((el) => {
    const text = el as HTMLInputElement
    text.setSelectionRange(text.value.length, text.value.length)
    const data = new DataTransfer()
    data.setData('text/plain', 'ond\n\n  Third \r\nFourth\n')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  // The text before the caret joins the first line pasted.
  expect(await texts(items)).toEqual(['First', 'Second', 'Third', 'Fourth'])
  await expect(input).toHaveValue('')
})

test('a new lane takes its initial tasks the same way', async ({ page, project, api, human }) => {
  const parent = await api.ticket({ title: 'The parent' })
  await page.goto(`/projects/${project.id}/features/${parent.id}`)
  const { dialog, input, add, items, create } = await openDialog(page, 'New lane')
  await dialog.getByLabel('Title').fill('A lane with tasks')
  await input.fill('Backend part')
  await input.press('Enter')
  await input.fill('Wire it')
  await add.click()
  await expect(items).toHaveText(['Backend part', 'Wire it'])
  await create.click()
  await expect(dialog).toBeHidden()
  const lane = (await rows(human, project.id)).find((t) => t.title === 'A lane with tasks')
  expect(lane).toMatchObject({ parentId: parent.id })
  expect(await tasksOf(human, lane!.id)).toEqual(['Backend part', 'Wire it'])
})

test('after +, the focus is back in the tasks input, so the next task is typed there', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  const { dialog, input, add, items } = await openDialog(page)
  await input.pressSequentially('Reproduce it')
  await add.click()
  await expect(items).toHaveText(['Reproduce it'])
  await expect(input).toBeFocused()
  await page.keyboard.type('Fix it')
  await expect(input).toHaveValue('Fix it')

  // From the keyboard too: Tab to + and Space on it.
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.press('Space')
  await expect(items).toHaveText(['Reproduce it', 'Fix it'])
  await expect(input).toBeFocused()
  await page.keyboard.type('Ship it')
  await expect(input).toHaveValue('Ship it')
  await expect(dialog).toBeVisible()
})

test('typing [ or ] after + in the New lane dialog stays in the field, and the lane goes under its parent', async ({
  page,
  project,
  api,
  human,
}) => {
  // Two tickets in one stage: on the parent's page `[` and `]` step to the other one, unless typing.
  await api.ticket({ title: 'The neighbour' })
  const parent = await api.ticket({ title: 'The parent' })
  const url = `/projects/${project.id}/features/${parent.id}`
  await page.goto(url)
  await expect(page.getByText(/ of 2 in /)).toBeVisible()
  const { dialog, input, add, items, create } = await openDialog(page, 'New lane')
  await dialog.getByLabel('Title').fill('A lane typed in one go')
  await input.pressSequentially('Backend part')
  await add.click()
  await page.keyboard.type('[api] retry')
  await expect(input).toHaveValue('[api] retry')
  await page.keyboard.press('Enter')
  await expect(items).toHaveText(['Backend part', '[api] retry'])
  expect(new URL(page.url()).pathname).toBe(url)

  await create.click()
  await expect(dialog).toBeHidden()
  expect(new URL(page.url()).pathname).toBe(url)
  const lane = (await rows(human, project.id)).find((t) => t.title === 'A lane typed in one go')
  expect(lane).toMatchObject({ parentId: parent.id })
  expect(await tasksOf(human, lane!.id)).toEqual(['Backend part', '[api] retry'])
})

for (const width of [375, 1280]) {
  test(`long tasks wrap inside the New ticket dialog at ${width}px`, async ({ page, project }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/projects/${project.id}/features`)
    const { dialog, input, list, items } = await openDialog(page)
    for (const t of ['Reproduce it', 'x'.repeat(80), 'Fix it', `${'A rather long task '.repeat(8)}end`]) {
      await input.fill(t)
      await input.press('Enter')
    }
    await expect(items).toHaveCount(4)
    const frame = (await dialog.boundingBox())!
    const box = (await list.boundingBox())!
    // The list stays inside the dialog, and nothing in it goes past its edges.
    expect(box.x).toBeGreaterThanOrEqual(frame.x)
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width)
    for (const item of await items.all()) {
      const b = (await item.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(box.x)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width)
      expect(await item.evaluate((li) => li.scrollWidth <= li.clientWidth)).toBe(true)
    }
    // The unbroken one wraps onto more lines than a short one takes.
    const short = (await items.nth(0).boundingBox())!
    expect((await items.nth(1).boundingBox())!.height).toBeGreaterThan(short.height)
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true)
  })
}
