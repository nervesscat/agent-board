import type { Locator, Page } from '@playwright/test'

import type { Attachment, CommentRow } from '#/lib/api'
import { AGENT } from './env'
import { png } from './files'
import { expect, expectTooltip, ok, openFeedTab, test } from './fixtures'

/** How much of it shows: its opacity times every ancestor's, where hover and focus reveal it. */
const shown = (l: Locator) =>
  l.evaluate((el) => {
    let o = 1
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity)
    return o
  })

/**
 * The row of a post card or of a reply that says who wrote it, and when: the one that holds `Actor`, a
 * span with a tooltip.
 */
const authorRow = (card: Locator) => card.locator('div:has(> span[data-slot="tooltip-trigger"])').first()

/** Where it is on the page. */
const box = async (l: Locator) => (await l.boundingBox())!

/** The colour a theme variable (`--destructive`) comes to, as computed styles give colours. */
const themeColor = (page: Page, variable: string) =>
  page.evaluate((v) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${v})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, variable)

/**
 * An action that shows only its icon (and `text`, a count), named for screen readers, `tip` its tooltip.
 * The pointer leaves it after, so what shows on hover is as it was.
 */
async function expectIcon(button: Locator, tip: string, text = '') {
  await expect(button).toHaveCount(1)
  await expect(button.locator('svg')).toHaveCount(1)
  await expectTooltip(button, tip)
  await button.page().mouse.move(0, 0)
  expect(await button.evaluate((el) => (el as HTMLElement).innerText.trim())).toBe(text)
}

test('posts on a ticket, replies, edits and deletes', async ({ page, api, human }) => {
  const t = await api.ticket({ title: 'Talk it over' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // Post, from the rich editor.
  await page.getByRole('textbox', { name: 'New post' }).fill('Should this ship behind a flag?')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  // The ticket's only post.
  const post = page.locator('article:not([aria-label="Summary"])')
  await expect(post).toContainText('Should this ship behind a flag?')
  await expect(page.getByRole('textbox', { name: 'New post' })).toHaveText('')

  // Edit it in place: Ctrl+Enter saves.
  const header = authorRow(post)
  const actions = post.getByRole('group', { name: 'Post actions' })
  await actions.hover()
  await actions.getByRole('button', { name: 'edit', exact: true }).click()
  const box = post.getByRole('textbox', { name: 'Edit text' })
  await expect(box).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Should this ship behind a feature flag?')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(box).toBeHidden()
  await expect(post).toContainText('Should this ship behind a feature flag?')
  await expect(header.getByText('edited', { exact: true })).toBeVisible()

  // Reply under it.
  await actions.getByRole('button', { name: 'reply', exact: true }).click()
  await post.getByRole('textbox', { name: 'Reply' }).fill('Yes, off by default.')
  await post.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(post.getByText('Yes, off by default.')).toBeVisible()
  await expect(actions.getByRole('button', { name: 'hide replies' })).toBeVisible()

  const [saved] = (await api.getTicket(t.id)).updates
  expect(saved).toMatchObject({ body: 'Should this ship behind a feature flag?', author: 'enrique' })
  expect(saved!.editedAt).not.toBeNull()
  const replies = await ok<{ body: string; author: string }[]>(
    human.get(`/api/comments?parentType=update&parentId=${saved!.id}`),
  )
  expect(replies).toMatchObject([{ body: 'Yes, off by default.', author: 'enrique' }])

  // Delete it, after confirming: its replies go with it.
  await actions.hover()
  await actions.getByRole('button', { name: 'delete', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Delete this post?')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(post).toHaveCount(0)
  await expect(page.getByText('No posts yet.')).toBeVisible()
  expect((await api.getTicket(t.id)).updates).toEqual([])
})

test('an agent asks for a decision, the human picks an option, the ticket unblocks', async ({
  page,
  api,
  agent,
  project,
}) => {
  const t = await api.ticket({ title: 'Pick a storage', status: 'in_progress' })
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Where should uploads live?',
        options: [
          { label: 'Local disk', detail: 'Nothing to run' },
          { label: 'MinIO', detail: 'Survives a reinstall', recommended: true },
        ],
      },
    }),
  )
  expect((await api.getTicket(t.id)).status).toBe('blocked')

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  await expect(card).toContainText('Your decision is needed')
  await expect(page.getByText('decision needed', { exact: true })).toBeVisible()
  const decide = card.getByRole('button', { name: 'Decide' })
  await expect(decide).toBeDisabled()
  await card.getByRole('radio', { name: /MinIO/ }).click()
  await expect(card.getByRole('radio', { name: /MinIO/ })).toHaveAttribute('aria-checked', 'true')
  await card.getByRole('textbox', { name: 'Note for the agent' }).fill('Use the compose file')
  await decide.click()

  await expect(card).toContainText('decided by enrique')
  await expect(card.getByRole('radio', { name: /MinIO/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('decision needed', { exact: true })).toHaveCount(0)

  // Back to the first active stage, and the answer waits for the agent as a reply under the card.
  const after = await api.getTicket(t.id)
  expect(after.status).toBe('in_progress')
  const question = after.updates.find((u) => u.decision)!
  expect(question).toMatchObject({ decidedOption: 1, decidedBy: 'enrique' })
  const replies = await ok<{ body: string }[]>(
    agent.get(`/api/comments?parentType=update&parentId=${question.id}`),
  )
  expect(replies.map((r) => r.body).join('\n')).toContain('MinIO')
  expect(replies.map((r) => r.body).join('\n')).toContain('Use the compose file')
})

test('only the human answers a decision', async ({ api, agent }) => {
  const t = await api.ticket({ title: 'Agents cannot decide' })
  const question = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: { body: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
    }),
  )
  const res = await agent.put(`/api/updates/${question.id}/decision`, { data: { option: 0 } })
  expect(res.status()).toBe(403)
})

test("a post's actions are icons in a row under its text and files, shown on hover or focus", async ({
  page,
  api,
  human,
}) => {
  const t = await api.ticket({ title: 'Icons under the post' })
  const file = await ok<Attachment>(
    human.post('/api/uploads', {
      multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: png(40) } },
    }),
  )
  await ok(
    human.post(`/api/tickets/${t.id}/updates`, {
      data: { body: 'A post with a picture.', attachmentIds: [file.id], progress: false },
    }),
  )
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await page.mouse.move(0, 0)

  const post = page.locator('article:not([aria-label="Summary"])')
  const header = authorRow(post)
  const actions = post.getByRole('group', { name: 'Post actions' })
  // The header keeps who posted it, and no buttons.
  await expect(header).toContainText('enrique')
  await expect(header.getByRole('button')).toHaveCount(0)

  const button = (name: string) => post.getByRole('button', { name, exact: true })
  const reply = button('reply')
  const progress = button('mark progress')
  const edit = button('edit')
  const remove = button('delete')
  await expectIcon(reply, 'Reply')
  await expectIcon(progress, 'Mark as progress')
  await expectIcon(edit, 'Edit')
  await expectIcon(remove, 'Delete')

  // Below the text and the picture, all of them in the one row.
  const body = await box(post.getByText('A post with a picture.'))
  const picture = await box(post.getByRole('img', { name: 'shot.png' }))
  for (const name of ['reply', 'mark progress', 'edit', 'delete']) {
    const at = await box(actions.getByRole('button', { name, exact: true }))
    expect(at.y).toBeGreaterThanOrEqual(body.y + body.height)
    expect(at.y).toBeGreaterThanOrEqual(picture.y + picture.height)
  }

  // Reply always shows; the others when the card is hovered, anywhere on it.
  expect(await shown(reply)).toBe(1)
  expect(await shown(edit)).toBe(0)
  await header.hover()
  await expect.poll(() => shown(edit)).toBe(1)
  await expect.poll(() => shown(remove)).toBe(1)
  await page.mouse.move(0, 0)
  await expect.poll(() => shown(edit)).toBe(0)

  // Or focused from the keyboard, in order, with a ring around the one focused.
  await reply.focus()
  for (const next of [progress, edit, remove]) {
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
    await expect.poll(() => shown(next)).toBe(1)
    await expect.poll(() => next.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
  }

  // Enter on edit opens the editor; Esc leaves the post as it was.
  await edit.focus()
  await page.keyboard.press('Enter')
  const editor = post.getByRole('textbox', { name: 'Edit text' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  await expect(post).toContainText('A post with a picture.')

  // Enter on delete asks first, and Keep keeps it.
  await remove.focus()
  await page.keyboard.press('Enter')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Delete this post?')
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(confirm).toBeHidden()
  await expect(post).toHaveCount(1)
  expect((await api.getTicket(t.id)).updates).toHaveLength(1)

  // Dark: the icons take the hover colours, red for delete.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await remove.hover()
  const destructive = await themeColor(page, '--destructive')
  await expect
    .poll(() => remove.locator('svg.trash-icon').evaluate((el) => getComputedStyle(el).color))
    .toBe(destructive)
  await edit.hover()
  const foreground = await themeColor(page, '--foreground')
  await expect.poll(() => edit.evaluate((el) => getComputedStyle(el).color)).toBe(foreground)
  expect(destructive).not.toBe(foreground)

  // A phone fits the card and its row, the page loaded at its width.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(actions).toBeVisible()
  const row = await box(actions)
  expect(row.x + row.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('the progress toggle flips a post both ways, with its own icon for each', async ({
  page,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Progress or not' })
  const { id } = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'Wired up the parser.' } }),
  )
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  // A progress post: in the agents' tab.
  await openFeedTab(page, 'Agents')
  const post = page.locator('article:not([aria-label="Summary"])')
  const chip = authorRow(post).getByText('progress', { exact: true })
  await expect(chip).toBeVisible()
  await expect(post).not.toHaveClass(/bg-muted\/30/)

  const flip = async (from: string, to: string, progress: boolean) => {
    await post.hover()
    const patched = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/updates/${id}`),
    )
    await post.getByRole('button', { name: from, exact: true }).click()
    expect((await patched).postDataJSON()).toEqual({ progress })
    await expect(post.getByRole('button', { name: to, exact: true })).toBeVisible()
    await expect.poll(async () => (await api.getTicket(t.id)).updates[0]!.progress).toBe(progress)
  }

  const not = post.getByRole('button', { name: 'not progress', exact: true })
  await expectIcon(not, 'Not progress: make it a plain post')
  await expect(not.locator('svg')).toHaveClass(/\blucide-flag-off\b/)
  await flip('not progress', 'mark progress', false)
  await expect(chip).toHaveCount(0)
  await expect(post).toHaveClass(/bg-muted\/30/)
  const mark = post.getByRole('button', { name: 'mark progress', exact: true })
  await expectIcon(mark, 'Mark as progress')
  await expect(mark.locator('svg')).toHaveClass(/\blucide-flag\b/)
  await expect(mark.locator('svg')).not.toHaveClass(/\blucide-flag-off\b/)

  await flip('mark progress', 'not progress', true)
  await expect(chip).toBeVisible()
  await expect(post).not.toHaveClass(/bg-muted\/30/)
})

test('the New post box has no progress switch, and what it posts is not progress', async ({ page, api }) => {
  const t = await api.ticket({ title: 'Just a question' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  const editor = page.getByRole('textbox', { name: 'New post' })
  const form = page.locator('form').filter({ has: editor })
  await expect(form.getByRole('button', { name: 'attach' })).toBeVisible()
  await expect(form.getByRole('switch')).toHaveCount(0)
  await expect(form.getByText('progress', { exact: true })).toHaveCount(0)

  // The API makes a post progress when it is not told, so the box tells it.
  await editor.fill('Is the old export still used?')
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/tickets/${t.id}/updates`),
  )
  await form.getByRole('button', { name: 'Post', exact: true }).click()
  expect((await sent).postDataJSON()).toMatchObject({ progress: false })
  const post = page.locator('article:not([aria-label="Summary"])')
  await expect(post).toContainText('Is the old export still used?')
  await expect(authorRow(post).getByText('progress', { exact: true })).toHaveCount(0)
  await expect(post).toHaveClass(/bg-muted\/30/)
  expect((await api.getTicket(t.id)).updates).toMatchObject([{ progress: false }])
})

test('a lane post on its parent keeps only the reply toggle, in the row under it', async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  const parent = await api.ticket({ title: 'The whole feature' })
  const lane = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title: 'One part', parentId: parent.id } }),
  )
  await ok(agent.post(`/api/tickets/${lane.id}/updates`, { data: { body: 'Done in the lane.' } }))
  await page.goto(`/projects/${project.id}/features/${parent.id}`)
  await page.getByText('include lane posts').click()
  await openFeedTab(page, 'Agents')

  const post = page.locator('article:not([aria-label="Summary"])').filter({ hasText: 'Done in the lane.' })
  await expect(authorRow(post).getByRole('link', { name: 'One part' })).toBeVisible()
  await expect(authorRow(post).getByRole('button')).toHaveCount(0)
  await post.hover()
  for (const name of ['edit', 'delete', 'mark progress', 'not progress'])
    await expect(post.getByRole('button', { name, exact: true })).toHaveCount(0)
  const actions = post.getByRole('group', { name: 'Post actions' })
  await expect(actions.getByRole('button')).toHaveCount(1)
  await expectIcon(actions.getByRole('button', { name: 'reply', exact: true }), 'Reply')
})

test('the reply toggle shows the count, opens the thread right under its row and closes it', async ({
  page,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'Count them' })
  const { id } = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'One reply under this.' } }),
  )
  await ok(agent.post('/api/comments', { data: { parentType: 'update', parentId: id, body: 'The reply.' } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await openFeedTab(page, 'Agents')
  const post = page.locator('article:not([aria-label="Summary"])')
  const actions = post.getByRole('group', { name: 'Post actions' })

  const toggle = actions.getByRole('button', { name: '1 reply', exact: true })
  await expectIcon(toggle, 'Show 1 reply', '1')
  await toggle.click()
  await expect(post.getByText('The reply.')).toBeVisible()
  const hide = actions.getByRole('button', { name: 'hide replies', exact: true })
  await expectIcon(hide, 'Hide replies')
  await expect(hide).toHaveAttribute('aria-expanded', 'true')

  // Nothing between the row and the thread, whose Reply box is in the same card.
  const row = await box(actions)
  expect((await box(post.getByText('The reply.'))).y).toBeGreaterThan(row.y + row.height)
  // The row ends the post's own part, and the thread comes right after that part.
  const after = await actions.evaluate((el) => ({
    last: el.parentElement!.lastElementChild === el,
    next: el.parentElement!.nextElementSibling?.textContent ?? '',
  }))
  expect(after.last).toBe(true)
  expect(after.next).toContain('The reply.')
  await expect(post.getByRole('textbox', { name: 'Reply' })).toBeVisible()

  await hide.click()
  await expect(post.getByText('The reply.')).toBeHidden()
  await expect(actions.getByRole('button', { name: '1 reply', exact: true })).toBeVisible()
})

test('a reply in a thread has its actions as icons under its own text, before its replies', async ({
  page,
  api,
  agent,
  human,
}) => {
  const t = await api.ticket({ title: 'Talk under a post' })
  const { id } = await ok<{ id: number }>(
    human.post(`/api/tickets/${t.id}/updates`, { data: { body: 'What next?', progress: false } }),
  )
  const thread = `/api/comments?parentType=update&parentId=${id}`
  const root = await ok<CommentRow>(
    agent.post('/api/comments', { data: { parentType: 'update', parentId: id, body: 'The parser first.' } }),
  )
  await ok(
    human.post('/api/comments', {
      data: { parentType: 'update', parentId: id, body: 'Agreed, then tests.', replyTo: root.id },
    }),
  )
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await page.mouse.move(0, 0)
  const post = page.locator('article:not([aria-label="Summary"])')
  await post.getByRole('button', { name: '2 replies', exact: true }).click()

  // Each reply: its header, its text, then its own row of actions; the nested reply after that row.
  const comment = (text: string) => post.locator('.group\\/comment').filter({ hasText: text })
  const first = comment('The parser first.')
  const nested = comment('Agreed, then tests.')
  for (const [c, author] of [
    [first, AGENT],
    [nested, 'enrique'],
  ] as const) {
    const header = authorRow(c)
    await expect(header).toContainText(author)
    await expect(header.getByRole('button')).toHaveCount(0)
  }
  const below = async (a: Locator, b: Locator) => {
    const [top, under] = [await box(a), await box(b)]
    expect(under.y).toBeGreaterThanOrEqual(top.y + top.height)
  }
  const firstActions = first.getByRole('group', { name: 'Reply actions' })
  await below(first.getByText('The parser first.'), firstActions)
  await below(firstActions, nested)
  await below(nested.getByText('Agreed, then tests.'), nested.getByRole('group', { name: 'Reply actions' }))

  const button = (c: Locator, name: string) => c.getByRole('button', { name, exact: true })
  await expectIcon(button(first, 'reply'), 'Reply')
  await expectIcon(button(first, 'edit'), 'Edit')
  await expectIcon(button(first, 'delete'), 'Delete')
  await expect(button(nested, 'reply')).toHaveCount(0)
  await expectIcon(button(nested, 'edit'), 'Edit')
  await expectIcon(button(nested, 'delete'), 'Delete')

  // Hovering a reply shows its own edit and delete, not the other's; reply always shows.
  expect(await shown(button(first, 'reply'))).toBe(1)
  expect(await shown(button(first, 'edit'))).toBe(0)
  await first.getByText('The parser first.').hover()
  await expect.poll(() => shown(button(first, 'edit'))).toBe(1)
  expect(await shown(button(nested, 'edit'))).toBe(0)
  await nested.getByText('Agreed, then tests.').hover()
  await expect.poll(() => shown(button(nested, 'edit'))).toBe(1)
  await expect.poll(() => shown(button(first, 'edit'))).toBe(0)

  // Edit the nested one.
  await button(nested, 'edit').click()
  const editor = post.getByRole('textbox', { name: 'Edit text' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Agreed, then the tests.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(editor).toBeHidden()
  await expect(post.getByText('Agreed, then the tests.')).toBeVisible()
  const edited = (await ok<CommentRow[]>(human.get(thread))).find((c) => c.replyTo === root.id)
  expect(edited).toMatchObject({ body: 'Agreed, then the tests.' })
  expect(edited!.editedAt).not.toBeNull()

  // Reply to the first: the form says to whom, and the reply lands under it.
  await button(first, 'reply').click()
  await expect(post.getByText(`replying to ${AGENT} ·`)).toBeVisible()
  await expect(post.getByRole('button', { name: 'cancel', exact: true })).toBeVisible()
  await post.getByRole('textbox', { name: 'Reply' }).fill('And docs.')
  await post.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(post.getByText('And docs.')).toBeVisible()
  const sent = (await ok<CommentRow[]>(human.get(thread))).find((c) => c.body === 'And docs.')
  expect(sent).toMatchObject({ replyTo: root.id })

  // Delete asks first: Keep keeps it, Delete takes it.
  const docs = comment('And docs.')
  const confirm = page.getByRole('alertdialog')
  await docs.hover()
  await button(docs, 'delete').click()
  await expect(confirm).toContainText('Delete this reply?')
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(confirm).toBeHidden()
  await expect(post.getByText('And docs.')).toBeVisible()
  await docs.hover()
  await button(docs, 'delete').click()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(post.getByText('And docs.')).toHaveCount(0)
  const left = await ok<CommentRow[]>(human.get(thread))
  expect(left.map((c) => c.body)).toEqual(['The parser first.', 'Agreed, then the tests.'])
})

test("hovering a reply or the thread's Reply box shows the reply's actions, not the post's", async ({
  page,
  api,
  agent,
}) => {
  const t = await api.ticket({ title: 'One set at a time' })
  const { id } = await ok<{ id: number }>(
    agent.post(`/api/tickets/${t.id}/updates`, { data: { body: 'The post itself.' } }),
  )
  for (const body of ['First reply.', 'Second reply.', 'Third reply.'])
    await ok(agent.post('/api/comments', { data: { parentType: 'update', parentId: id, body } }))
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)
  await openFeedTab(page, 'Agents')
  const post = page.locator('article:not([aria-label="Summary"])')
  const actions = post.getByRole('group', { name: 'Post actions' })
  await actions.getByRole('button', { name: '3 replies', exact: true }).click()
  await page.mouse.move(0, 0)

  const own = ['not progress', 'edit', 'delete'].map((name) =>
    actions.getByRole('button', { name, exact: true }),
  )
  const reply = post.locator('.group\\/comment').filter({ hasText: 'First reply.' })
  const replyEdit = reply.getByRole('button', { name: 'edit', exact: true })
  for (const b of [...own, replyEdit]) await expect.poll(() => shown(b)).toBe(0)

  // A reply: its own edit shows, the post's actions stay hidden.
  await reply.getByText('First reply.').hover()
  await expect.poll(() => shown(replyEdit)).toBe(1)
  for (const b of own) expect(await shown(b)).toBe(0)

  // The thread's Reply box: nothing of the post's either.
  await post.getByRole('textbox', { name: 'Reply' }).hover()
  await expect.poll(() => shown(replyEdit)).toBe(0)
  for (const b of own) expect(await shown(b)).toBe(0)

  // The post's own text still shows them.
  await post.getByText('The post itself.').hover()
  for (const b of own) await expect.poll(() => shown(b)).toBe(1)
  expect(await shown(replyEdit)).toBe(0)
})
