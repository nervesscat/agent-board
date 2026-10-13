import type { Page } from '@playwright/test'

import type { TicketFull, TicketRow } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { startedAt, yesterdayNoon } from './db'
import { expect, ok, section, test } from './fixtures'

test('writes a resume note from the template; it shows with who and when, and posts a handoff', async ({
  page,
  api,
}) => {
  const t = await api.ticket({ title: 'Parse the config', status: 'in_progress' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  await page.getByRole('button', { name: /^Leave a resume note/ }).click()
  const card = page.getByRole('region', { name: 'Resume here' })
  const editor = card.getByRole('textbox', { name: 'Resume note' })
  await expect(editor).toBeFocused()
  for (const heading of ['State:', 'Done so far:', 'Next steps:', 'Open questions / blockers:'])
    await expect(editor.locator('strong', { hasText: heading })).toBeVisible()

  // The template as it comes is not a note.
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('fill in the template before saving it')).toBeVisible()
  await expect(editor).toBeVisible()

  // Fill in the first line: "(one line)" becomes where the work stands.
  await editor.getByText('(one line)').click()
  await page.keyboard.press('End')
  for (let i = 0; i < '(one line)'.length; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('parser done, tests next')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(editor).toBeHidden()

  await expect(card).toContainText('State: parser done, tests next')
  await expect(card.getByText(/^by enrique/)).toContainText('just now')
  // Saving it also posted it to the feed, marked as a resume note.
  const handoff = page.getByRole('article').filter({ hasText: 'resume note' })
  await expect(handoff).toHaveCount(1)
  await expect(handoff).toContainText('State: parser done, tests next')

  const saved = await api.getTicket(t.id)
  expect(saved.resume).toMatchObject({ by: 'enrique', noHandoff: false, stale: false })
  expect(saved.resume.note).toMatch(/^\*\*State:\*\* parser done, tests next/)
  expect(saved.updates).toMatchObject([{ handoff: true, author: 'enrique', progress: true }])
})

test('an agent writes the resume note as one of the project agents; the human cannot use as', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  await ok(human.post(`/api/projects/${project.id}/agents/defaults`, { data: {} }))
  const as = DEFAULT_AGENT_NAMES[0]
  const t = await api.ticket({ title: 'Handed over by an agent', status: 'in_progress' })

  const refused = await human.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Mine', as } })
  expect(refused.status()).toBe(403)

  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: '**State:** migrations written', as } }))
  const saved = await api.getTicket(t.id)
  expect(saved.resume).toMatchObject({ by: as, note: '**State:** migrations written' })
  expect(saved.updates).toMatchObject([{ handoff: true, author: as, via: 'claude' }])

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Resume here' })
  await expect(card).toContainText('State: migrations written')
  await expect(card.getByText(/^by /)).toContainText(as)
})

test('a ticket carried over from yesterday without a note shows no handoff until one is written', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Carried over', status: 'in_progress' })
  startedAt(t.id, yesterdayNoon())
  expect((await api.getTicket(t.id)).resume).toMatchObject({ noHandoff: true, day: 2, at: null })

  await page.goto(`/projects/${project.id}/features?view=board`)
  const boardCard = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Carried over/ })
  await expect(boardCard).toContainText('no handoff')
  await expect(boardCard).toContainText('day 2')

  await boardCard.click()
  const card = page.getByRole('region', { name: 'Resume here' })
  await expect(card).toContainText('No handoff yet')
  await expect(card).toContainText('day 2 in progress')

  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Halfway through the parser' } }))
  await page.reload()
  await expect(card).toContainText('Halfway through the parser')
  await expect(card).not.toContainText('No handoff yet')

  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(boardCard).not.toContainText('no handoff')
  await expect(boardCard).toContainText('day 2')
  // The Overview's Carrying over shows the note where the last session left off.
  await page.goto(`/projects/${project.id}`)
  const carried = section(page, 'Carrying over').getByRole('listitem').filter({ hasText: 'Carried over' })
  await expect(carried).toContainText('Halfway through the parser — claude')
  await expect(carried.getByText('no handoff')).toHaveCount(0)
})

interface Noted {
  id: number
  title: string
  body: string
  note: string
}

/**
 * Asserts the page shows the ticket and its one resume note, once it has loaded: one "Resume here", one
 * #resume, one Instructions, and nothing of the other tickets' notes or instructions.
 */
async function expectOnlyNoteOf(page: Page, shown: Noted, others: Noted[]) {
  await expect(page).toHaveURL(new RegExp(`/features/${shown.id}(#resume)?$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`#${shown.id} ${shown.title}`)
  const card = page.getByRole('region', { name: 'Resume here' })
  await expect(card).toHaveCount(1)
  await expect(card).toContainText(shown.note)
  await expect(page.locator('[id="resume"]')).toHaveCount(1)
  const instructions = page.getByRole('region', { name: 'Instructions' })
  await expect(instructions).toHaveCount(1)
  await expect(instructions).toContainText(shown.body)
  await expect(page.getByRole('button', { name: /^Leave a resume note/ })).toHaveCount(0)
  for (const other of others) {
    await expect(page.getByText(other.note)).toHaveCount(0)
    await expect(page.getByText(other.body)).toHaveCount(0)
  }
}

test('moving from ticket to ticket shows only the shown one’s resume note: by link, [ and ], Back and Forward', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  for (const title of ['First', 'Second', 'Third']) {
    const t = await api.ticket({ title, status: 'in_progress', body: `What ${title} is about` })
    await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: `${title} is halfway` } }))
    // Distinct update times, so the column's order (last updated first) is certain.
    await new Promise((r) => setTimeout(r, 20))
  }
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const column = rows
    .filter((r) => r.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => ({
      id: r.id,
      title: r.title,
      body: `What ${r.title} is about`,
      note: `${r.title} is halfway`,
    }))
  expect(column.map((r) => r.title)).toEqual(['Third', 'Second', 'First'])
  const [third, second, first] = column as [Noted, Noted, Noted]
  const only = (shown: Noted) =>
    expectOnlyNoteOf(
      page,
      shown,
      column.filter((t) => t !== shown),
    )
  const next = page.getByRole('link', { name: 'Next ticket in In progress' })
  const prev = page.getByRole('link', { name: 'Previous ticket in In progress' })

  await page.goto(`/projects/${project.id}/features/${third.id}`)
  await only(third)
  // Each move leaves one note on the page, however many moves come before it.
  await next.click()
  await only(second)
  await next.click()
  await only(first)
  await prev.click()
  await only(second)
  await page.keyboard.press('[')
  await only(third)
  await page.keyboard.press(']')
  await only(second)
  await page.keyboard.press(']')
  await only(first)
  await page.goBack()
  await only(second)
  await page.goBack()
  await only(third)
  await page.goForward()
  await only(second)
  await page.goForward()
  await only(first)
})

test('moving to a ticket without a note, or a closed one, leaves none of the note before it', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const bare = await api.ticket({ title: 'Not started', status: 'in_progress', body: 'Nothing noted here' })
  await new Promise((r) => setTimeout(r, 20))
  const t = await api.ticket({ title: 'Under way', status: 'in_progress', body: 'Work under way' })
  await ok(agent.put(`/api/tickets/${t.id}/resume`, { data: { note: 'Under way, tests next' } }))
  const noted: Noted = { id: t.id, title: t.title, body: t.body, note: 'Under way, tests next' }
  const lane = (title: string, status: string) =>
    ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { title, status, parentId: t.id } }),
    )
  const shipped = await lane('Shipped part', 'done')
  const dropped = await lane('Dropped part', 'cancelled')

  const card = page.getByRole('region', { name: 'Resume here' })
  const leave = page.getByRole('button', { name: /^Leave a resume note/ })
  const title = page.getByRole('heading', { level: 1 })
  /** Asserts the page shows the ticket, with no note of its own and none left from the one before. */
  const noNote = async (shown: TicketFull, open: boolean) => {
    await expect(title).toContainText(`#${shown.id} ${shown.title}`)
    await expect(page.getByRole('region', { name: 'Instructions' })).toHaveCount(1)
    await expect(card).toHaveCount(0)
    await expect(page.locator('[id="resume"]')).toHaveCount(0)
    await expect(page.getByText(noted.note)).toHaveCount(0)
    await expect(page.getByText(noted.body)).toHaveCount(0)
    // An open ticket offers to write its first one; a closed one does not.
    await expect(leave).toHaveCount(open ? 1 : 0)
  }

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expectOnlyNoteOf(page, noted, [])
  await page.getByRole('link', { name: 'Next ticket in In progress' }).click()
  await noNote(bare, true)
  await page.getByRole('link', { name: 'Previous ticket in In progress' }).click()
  await expectOnlyNoteOf(page, noted, [])

  await page.getByRole('link', { name: /Shipped part/ }).click()
  await noNote(shipped, false)
  await page.getByRole('link', { name: `#${t.id} ${t.title}` }).click()
  await expectOnlyNoteOf(page, noted, [])
  await page.getByRole('link', { name: /Dropped part/ }).click()
  await noNote(dropped, false)
})

test('an editor open on one ticket is not open on the next; each note version is a feed post, not a card', async ({
  page,
  api,
  agent,
  project,
}) => {
  const first = await api.ticket({ title: 'Edited here', status: 'in_progress', body: 'Edit me' })
  await ok(agent.put(`/api/tickets/${first.id}/resume`, { data: { note: 'Edited here, half done' } }))
  await new Promise((r) => setTimeout(r, 20))
  const second = await api.ticket({ title: 'Read there', status: 'in_progress', body: 'Read me' })
  await ok(agent.put(`/api/tickets/${second.id}/resume`, { data: { note: 'Read there, started' } }))
  await ok(agent.put(`/api/tickets/${second.id}/resume`, { data: { note: 'Read there, nearly done' } }))

  await page.goto(`/projects/${project.id}/features/${first.id}`)
  const card = page.getByRole('region', { name: 'Resume here' })
  await card.getByRole('button', { name: 'edit', exact: true }).click()
  await expect(card.getByRole('textbox', { name: 'Resume note' })).toBeVisible()
  await page
    .getByRole('region', { name: 'Instructions' })
    .getByRole('button', { name: 'edit', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toBeVisible()

  await page.getByRole('link', { name: 'Previous ticket in In progress' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`#${second.id} Read there`)
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Read there, nearly done')
  await expect(card).not.toContainText('Read there, started')
  await expect(page.getByRole('textbox', { name: 'Resume note' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'edit', exact: true })).toBeVisible()
  // The earlier version is in the feed, as the latest is, each marked as a resume note.
  const versions = page.getByRole('article').filter({ hasText: 'resume note' })
  await expect(versions).toHaveCount(2)
  await expect(versions.filter({ hasText: 'Read there, started' })).toHaveCount(1)
  await expect(versions.filter({ hasText: 'Read there, nearly done' })).toHaveCount(1)
})
