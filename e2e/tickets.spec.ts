import type { Locator } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { expect, expectTooltip, ok, openFeedTab, test } from './fixtures'

/** Top, bottom and middle of a box on the page, in px. */
type Box = { top: number; bottom: number; mid: number }

/**
 * One reading of a row that holds an author (`Actor`), taken at a single moment so that nothing moving on
 * the page in between can skew it: the author's icon or avatar, the glyphs of its name, what follows the
 * name (its role's badge, or `via`), and the glyphs of every other text in the row, in order. Glyph boxes
 * of two texts in the same font have the same bottom exactly when they share a baseline. A text that wraps
 * is measured on its first line.
 */
const measure = (row: Locator) =>
  row.evaluate(async (el) => {
    await document.fonts.ready
    const box = (r: DOMRect): Box => ({ top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 })
    const glyphs = (n: Node) => {
      const range = document.createRange()
      range.selectNodeContents(n)
      const first = range.getClientRects()[0]
      return first && box(first)
    }
    // The author: the first span in the row with a tooltip.
    const actor = el.querySelector('span[data-slot="tooltip-trigger"]')!
    const name = [...actor.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!
    // The bot or person glyph, the avatar's picture or the avatar's initial on its colour.
    const icon = actor.querySelector('svg, img, span[aria-hidden]')!
    const after = actor.children[1]
    const texts: ({ text: string } & Box)[] = []
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent!.trim() && !actor.contains(n) && glyphs(n)
      if (at) texts.push({ text: n.textContent!.trim(), ...at })
    }
    return {
      icon: box(icon.getBoundingClientRect()),
      name: glyphs(name)!,
      after: after && {
        box: box(after.getBoundingClientRect()),
        glyphs: glyphs(after)!,
        // The role's badge (Human, Orchestrator, Agent): centred on the text, not on its baseline.
        badge: after.hasAttribute('data-role'),
      },
      texts,
    }
  })

/** Within a pixel: what sub-pixel font rounding leaves of two things on one line. */
const aligned = (what: string, a: number, b: number) =>
  expect(Math.abs(a - b), `${what}: ${a} against ${b}`).toBeLessThanOrEqual(1)

/** What the Stage control of a New ticket dialog shows: the picked stage's name, without its chevron. */
const stageValue = (dialog: Locator) => dialog.getByLabel('Stage').locator('[data-slot="select-value"]')

/**
 * The row of a post card or of a reply that says who wrote it, and when: the one that holds `Actor`, a
 * span with a tooltip.
 */
const authorRow = (card: Locator) => card.locator('div:has(> span[data-slot="tooltip-trigger"])').first()

test('creates a ticket from the New ticket dialog', async ({ page, project, human }) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Fix the login form')
  await dialog
    .getByRole('textbox', { name: 'Instructions' })
    .fill('The submit button does nothing on Safari.')
  // Each task is added, by Enter or by +, and listed above the field before the ticket is created.
  const tasks = dialog.getByLabel('Initial tasks')
  await tasks.fill('Reproduce it')
  await tasks.press('Enter')
  await tasks.fill('Fix it')
  await dialog.getByRole('button', { name: 'Add task' }).click()
  await expect(dialog.getByRole('list', { name: 'Tasks', exact: true }).getByRole('listitem')).toHaveText([
    'Reproduce it',
    'Fix it',
  ])
  await dialog.getByLabel('Tags (optional)').fill('High, Forms')
  // Left alone, the stage is Backlog, and it goes as Backlog's key: the kind `open` would be To do.
  await expect(stageValue(dialog)).toHaveText('Backlog')
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/projects/${project.id}/tickets`),
  )
  await dialog.getByRole('button', { name: 'Create' }).click()
  expect((await sent).postDataJSON()).toMatchObject({ status: 'backlog', tasks: ['Reproduce it', 'Fix it'] })
  await expect(dialog).toBeHidden()

  // A new ticket from the dialog starts in Backlog.
  const card = page.locator('[data-column="backlog"]').getByRole('link', { name: /Fix the login form/ })
  await expect(card).toBeVisible()
  await expect(card).toContainText('High')
  // The two tasks typed, under Implementation, and the default phases: 9 in all.
  await expect(card).toContainText('0/9')

  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(row).toMatchObject({ title: 'Fix the login form', status: 'backlog', createdBy: 'enrique' })
  expect(row!.tags.sort()).toEqual(['Forms', 'High'])
  const full = await ok<{ body: string; tasks: { text: string }[] }>(human.get(`/api/tickets/${row!.id}`))
  expect(full.body).toBe('The submit button does nothing on Safari.')
  expect(full.tasks.map((t) => t.text)).toEqual([
    'Implementation',
    'Reproduce it',
    'Fix it',
    'Pushed',
    'PR',
    'CI',
    'Preview',
    'Summary',
    'Merged',
  ])

  await card.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${row!.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fix the login form')
})

test('the New ticket dialog picks the stage a ticket starts in, from every stage in board order', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Already started')
  // No branch to pick: whoever works the ticket sets it.
  await expect(dialog.getByLabel('Branch (optional)')).toHaveCount(0)
  const stage = dialog.getByLabel('Stage')
  await expect(stageValue(dialog)).toHaveText('Backlog')
  await stage.click()
  await expect(page.getByRole('option')).toHaveText(project.stages.map((s) => s.name))
  await page.getByRole('option', { name: 'In progress', exact: true }).click()
  await expect(stageValue(dialog)).toHaveText('In progress')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expect(
    page.locator('[data-column="in_progress"]').getByRole('link', { name: /Already started/ }),
  ).toBeVisible()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(row).toMatchObject({ title: 'Already started', status: 'in_progress', branch: '' })

  // Like every other field, the stage starts over for the next ticket.
  await page.getByRole('button', { name: 'New ticket' }).click()
  await expect(dialog.getByLabel('Title')).toHaveValue('')
  await expect(stageValue(dialog)).toHaveText('Backlog')
})

test('the New ticket dialog starts on the first open stage of the project, whatever it is called', async ({
  page,
  project,
  human,
}) => {
  const ideas = await ok<{ id: number; key: string }>(
    human.post(`/api/projects/${project.id}/stages`, { data: { name: 'Ideas', kind: 'open' } }),
  )
  const stages = await ok<{ id: number }[]>(human.get(`/api/projects/${project.id}/stages`))
  const ids = [ideas.id, ...stages.map((s) => s.id).filter((id) => id !== ideas.id)]
  await ok(human.put(`/api/projects/${project.id}/stages/order`, { data: { ids } }))

  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('Maybe one day')
  await expect(stageValue(dialog)).toHaveText('Ideas')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expect(
    page.locator(`[data-column="${ideas.key}"]`).getByRole('link', { name: /Maybe one day/ }),
  ).toBeVisible()
  const [row] = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(row).toMatchObject({ title: 'Maybe one day', status: ideas.key })
})

test('a lane from the New lane dialog has no stage to pick and starts in To do', async ({ page, api }) => {
  const t = await api.ticket({ title: 'Parent', status: 'in_progress' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await page.getByRole('button', { name: 'New lane' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title').fill('A lane of it')
  await expect(dialog.getByLabel('Branch (optional)')).toHaveCount(0)
  await expect(dialog.getByLabel('Stage')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expect
    .poll(async () => (await api.getTicket(t.id)).lanes.map((l) => ({ title: l.title, status: l.status })))
    .toEqual([{ title: 'A lane of it', status: 'todo' }])
})

test('edits the title, tags and instructions in place', async ({ page, api }) => {
  const t = await api.ticket({ title: 'Old title', body: 'Old instructions.' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // Title: click it, type, Enter.
  await page.getByRole('button', { name: 'Old title' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('New title')
  await page.getByRole('textbox', { name: 'Title' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('New title')

  // Tags: "+ tags", comma separated, Enter.
  await page.getByRole('button', { name: '+ tags' }).click()
  await page.getByRole('textbox', { name: 'Tags, comma separated' }).fill('Cosmetic, Forms')
  await page.getByRole('textbox', { name: 'Tags, comma separated' }).press('Enter')
  const tags = page.getByRole('button', { name: /Cosmetic/ })
  await expectTooltip(tags, 'Click to edit the tags')
  await expect(tags).toContainText('Cosmetic')

  // Instructions: the rich editor, with a toolbar button, saved with Ctrl+Enter.
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await instructions.getByRole('button', { name: 'edit' }).click()
  const editor = instructions.getByRole('textbox', { name: 'Instructions' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Use the ')
  await instructions.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('new')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(editor).toBeHidden()
  await expect(instructions.locator('strong')).toHaveText('new')

  await expect
    .poll(async () => {
      const saved = await api.getTicket(t.id)
      return { title: saved.title, tags: [...saved.tags].sort(), body: saved.body }
    })
    .toEqual({ title: 'New title', tags: ['Cosmetic', 'Forms'], body: 'Use the **new**' })
})

test('steps to the previous and next ticket in a stage, by button and by [ and ]', async ({
  page,
  api,
  human,
  project,
}) => {
  for (const title of ['First', 'Second', 'Third']) {
    await api.ticket({ title, status: 'in_progress' })
    // Distinct update times, so the column's order (last updated first) is certain.
    await new Promise((r) => setTimeout(r, 20))
  }
  await api.ticket({ title: 'Elsewhere', status: 'todo' })
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const column = rows
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  expect(column.map((r) => r.title)).toEqual(['Third', 'Second', 'First'])
  const [third, second, first] = column
  const url = (id: number) => new RegExp(`/projects/${project.id}/features/${id}$`)

  await page.goto(`/projects/${project.id}/features/${second!.id}`)
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()

  await page.getByRole('link', { name: 'Next ticket in In progress' }).click()
  await expect(page).toHaveURL(url(first!.id))
  await expect(page.getByText('3 of 3 in In progress')).toBeVisible()
  // The last one has no next.
  await expect(page.getByRole('link', { name: 'Next ticket in In progress' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Previous ticket in In progress' }).click()
  await expect(page).toHaveURL(url(second!.id))

  await page.keyboard.press('[')
  await expect(page).toHaveURL(url(third!.id))
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Previous ticket in In progress' })).toHaveCount(0)

  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(second!.id))

  // While typing, [ and ] are text.
  await page.getByRole('textbox', { name: 'New post' }).click()
  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByRole('textbox', { name: 'New post' })).toHaveText(']')
})

test('keeps the list it steps through when a ticket in it moves to another stage, as lanes do', async ({
  page,
  api,
  human,
  project,
}) => {
  for (const title of ['First', 'Second', 'Third']) {
    await api.ticket({ title, status: 'in_progress' })
    // Distinct update times, so the column's order (last updated first) is certain.
    await new Promise((r) => setTimeout(r, 20))
  }
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const column = rows
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  expect(column.map((r) => r.title)).toEqual(['Third', 'Second', 'First'])
  const [third, second, first] = column
  const url = (id: number) => new RegExp(`/projects/${project.id}/features/${id}$`)
  const prev = page.getByRole('link', { name: 'Previous ticket in In progress' })
  const next = page.getByRole('link', { name: 'Next ticket in In progress' })

  await page.goto(`/projects/${project.id}/features/${second!.id}`)
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()

  // Moved to review on its page: it keeps its place in the list it is in, and the list its stage.
  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'In review', exact: true }).click()
  await expect(page.getByRole('combobox').filter({ hasText: 'In review' })).toBeVisible()
  await expect.poll(async () => (await api.getTicket(second!.id)).status).toBe('review')
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()

  // On to the next one, and back to the moved one, though it is in review now.
  await next.click()
  await expect(page).toHaveURL(url(first!.id))
  await expect(page.getByText('3 of 3 in In progress')).toBeVisible()
  await expect(next).toHaveCount(0)
  await prev.click()
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()
  await expect(page.getByRole('combobox').filter({ hasText: 'In review' })).toBeVisible()

  // [ and ] step through the same list.
  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(first!.id))
  await expect(page.getByText('3 of 3 in In progress')).toBeVisible()
  await page.keyboard.press('[')
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()
  await page.keyboard.press('[')
  await expect(page).toHaveURL(url(third!.id))
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()
  await expect(prev).toHaveCount(0)
  await page.keyboard.press(']')
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()

  // Opened again from the board (by the breadcrumb), it starts from the column it is in now.
  await page.getByRole('link', { name: 'Ongoing features' }).last().click()
  await page
    .locator('[data-column="review"]')
    .getByRole('link', { name: /Second/ })
    .click()
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByText('1 of 1 in In review')).toBeVisible()
  await expect(page.getByRole('link', { name: /ticket in In progress/ })).toHaveCount(0)
})

test('a lane filter on a ticket stepped to keeps the list it steps through, on Back and on reload', async ({
  page,
  api,
  human,
  project,
}) => {
  const made: TicketFull[] = []
  for (const title of ['First', 'Second', 'Third']) {
    made.push(await api.ticket({ title, status: 'in_progress' }))
    await new Promise((r) => setTimeout(r, 20))
  }
  await ok(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'A lane', parentId: made[2]!.id } }),
  )
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const column = rows
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  expect(column.map((r) => r.title)).toEqual(['Third', 'Second', 'First'])
  const [third, second] = column
  const url = (id: number) => new RegExp(`/projects/${project.id}/features/${id}(\\?|$)`)
  const todoChip = page.getByRole('button', { name: /^To do\s*1$/ })

  await page.goto(`/projects/${project.id}/features/${second!.id}`)
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()
  await page.getByRole('link', { name: 'Previous ticket in In progress' }).click()
  await expect(page).toHaveURL(url(third!.id))
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()

  await page.getByRole('combobox').filter({ hasText: 'In progress' }).click()
  await page.getByRole('option', { name: 'In review', exact: true }).click()
  await expect.poll(async () => (await api.getTicket(third!.id)).status).toBe('review')
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()

  // Filtering its lanes stays on the same page: the list it was stepped to in stays with it.
  await todoChip.click()
  await expect(page).toHaveURL(/\?stage=todo$/)
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()
  await page.reload()
  await expect(todoChip).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()

  await page.getByRole('link', { name: 'Next ticket in In progress' }).click()
  await expect(page).toHaveURL(url(second!.id))
  await expect(page.getByText('2 of 3 in In progress')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(url(third!.id))
  await expect(todoChip).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('1 of 3 in In progress')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Next ticket in In progress' })).toBeVisible()
})

test('the features view (board or list) survives a reload, kept in the URL and remembered', async ({
  page,
  api,
  project,
}) => {
  await api.ticket({ title: 'Seen either way' })
  const tab = (name: string) => page.getByRole('tab', { name })
  const card = page.locator('[data-column="todo"]').getByRole('link', { name: /Seen either way/ })
  const row = page.getByRole('listitem').filter({ hasText: 'Seen either way' })

  await page.goto(`/projects/${project.id}/features`)
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'true')
  await expect(card).toBeVisible()
  await tab('List').click()
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(row).toBeVisible()

  await page.reload()
  await expect(tab('List')).toHaveAttribute('aria-selected', 'true')
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'false')
  await expect(row).toBeVisible()
  await expect(page.locator('[data-column]')).toHaveCount(0)

  // Without one in the URL, the view this browser remembers comes back, and the URL says so.
  await page.goto(`/projects/${project.id}/features`)
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(tab('List')).toHaveAttribute('aria-selected', 'true')
  await expect(row).toBeVisible()

  // Archived is a visit: it is in the URL, but the next visit without one is back on the list.
  await tab('Archived').click()
  await expect(page).toHaveURL(/[?&]view=archived(&|$)/)
  await page.goto(`/projects/${project.id}/features`)
  await expect(page).toHaveURL(/[?&]view=list(&|$)/)
  await expect(row).toBeVisible()

  // A link that names one wins over what is remembered.
  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(tab('Board')).toHaveAttribute('aria-selected', 'true')
  await expect(card).toBeVisible()
})

test('the author sits on the line of the text around it: "opened by", the "by" of a resume note', async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const as = DEFAULT_AGENT_NAMES[0]
  const byAgent = await ok<TicketFull>(
    agent.post(`/api/projects/${project.id}/tickets`, { data: { title: 'Opened by an agent' } }),
  )
  const byHuman = await api.ticket({ title: 'Opened by the human', status: 'in_progress' })
  await ok(agent.put(`/api/tickets/${byHuman.id}/resume`, { data: { note: 'Halfway there', as } }))

  for (const { ticket, name, title } of [
    // A bot glyph, as in the ticket's screenshot, and the Agent badge after the name.
    { ticket: byAgent, name: 'claude', title: /agent, signed in with a token/ },
    // A person glyph, and the Human badge after the name.
    { ticket: byHuman, name: 'enrique', title: /signed in with a passkey/ },
  ]) {
    await page.goto(`/projects/${project.id}/features/${ticket.id}`)
    const line = page.locator('span').filter({ hasText: /^opened by / })
    const actor = line.locator('span[data-slot="tooltip-trigger"]')
    await expect(actor).toContainText(name)
    await expectTooltip(actor, title)

    // The row: "opened by <author> <time>", "updated <time>", the tags.
    const { texts, ...author } = await measure(line.locator('..'))
    const [openedBy, ago] = texts
    expect(openedBy!.text).toBe('opened by')
    aligned(`${name}: the name on the baseline of "opened by"`, author.name.bottom, openedBy!.bottom)
    aligned(`${name}: the name on the baseline of the time`, author.name.bottom, ago!.bottom)
    aligned(`${name}: the icon centred on the text`, author.icon.mid, openedBy!.mid)
    if (author.after) aligned(`${name}: the badge centred on the text`, author.after.box.mid, openedBy!.mid)
    const updated = texts.find((t) => t.text === 'updated')
    aligned(`${name}: "opened by" on the baseline of "updated"`, openedBy!.bottom, updated!.bottom)
  }

  // One of the project's agents wrote the resume note: its avatar, the agent's initial on a colour.
  const line = page.getByRole('region', { name: 'Resume here' }).getByText(/^by /)
  await expectTooltip(line.locator('span[data-slot="tooltip-trigger"]'), /one of the project's agents/)
  const { texts, ...author } = await measure(line)
  const [by, ago] = texts
  expect(by!.text).toBe('by')
  aligned(`${as}: the name on the baseline of "by"`, author.name.bottom, by!.bottom)
  aligned(`${as}: the name on the baseline of the time`, author.name.bottom, ago!.bottom)
  aligned(`${as}: the avatar centred on the text`, author.icon.mid, by!.mid)
})

test('an author in the header of a post or a reply stays centred on it, on a phone too', async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const as = DEFAULT_AGENT_NAMES[0]
  const t = await api.ticket({ title: 'Posted on' })
  const post = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'From the agent itself.' } }),
  )
  await ok(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'From one of the project agents.', as } }),
  )
  await ok(
    agent.post('/api/comments', {
      data: { parentType: 'update', parentId: post.id, body: 'A reply from a project agent.', as },
    }),
  )

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    // Progress and project agents' posts: in the agents' tab.
    await openFeedTab(page, 'Agents')
    const article = (body: string) => page.getByRole('article').filter({ hasText: body })
    await article('From the agent itself.').getByRole('button', { name: '1 reply' }).click()
    await expect(page.getByText('A reply from a project agent.')).toBeVisible()

    for (const [what, header, title] of [
      ['post by claude', authorRow(article('From the agent itself.')), /agent, signed in with a token/],
      [
        `post by ${as}`,
        authorRow(article('From one of the project agents.')),
        /one of the project's agents, posted via claude/,
      ],
      // On a phone its `via claude` and its time wrap onto a second line: the picture stays on the first.
      [
        `reply by ${as}`,
        authorRow(article('From the agent itself.').locator('.group\\/comment').first()),
        /one of the project's agents, posted via claude/,
      ],
    ] as const) {
      const actor = header.locator('span[data-slot="tooltip-trigger"]').first()
      await expectTooltip(actor, title)
      const author = await measure(header)
      const label = `${width}px, ${what}`
      aligned(`${label}: the icon centred on the name`, author.icon.mid, author.name.mid)
      if (author.after?.badge)
        aligned(`${label}: the badge centred on the name`, author.after.box.mid, author.name.mid)
      else if (author.after)
        aligned(`${label}: "via" on the baseline of the name`, author.after.glyphs.bottom, author.name.bottom)
    }
  }
})
