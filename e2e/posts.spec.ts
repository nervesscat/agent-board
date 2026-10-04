import { expect, ok, test } from './fixtures'

test('posts on a ticket, replies, edits and deletes', async ({ page, api, human }) => {
  const t = await api.ticket({ title: 'Talk it over' })
  await page.goto(`/projects/${t.projectId}/features/${t.id}`)

  // Post, from the rich editor.
  await page.getByRole('textbox', { name: 'New post' }).fill('Should this ship behind a flag?')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  // The ticket's only post.
  const post = page.getByRole('article')
  await expect(post).toContainText('Should this ship behind a flag?')
  await expect(page.getByRole('textbox', { name: 'New post' })).toHaveText('')

  // Edit it in place: Ctrl+Enter saves.
  const header = post.locator('.group\\/post').first()
  await header.hover()
  await header.getByRole('button', { name: 'edit', exact: true }).click()
  const box = post.getByRole('textbox', { name: 'Edit text' })
  await expect(box).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Should this ship behind a feature flag?')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(box).toBeHidden()
  await expect(post).toContainText('Should this ship behind a feature flag?')
  await expect(header.getByText('edited', { exact: true })).toBeVisible()

  // Reply under it.
  await header.getByRole('button', { name: 'reply', exact: true }).click()
  await post.getByRole('textbox', { name: 'Reply' }).fill('Yes, off by default.')
  await post.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(post.getByText('Yes, off by default.')).toBeVisible()
  await expect(header.getByRole('button', { name: 'hide replies' })).toBeVisible()

  const [saved] = (await api.getTicket(t.id)).updates
  expect(saved).toMatchObject({ body: 'Should this ship behind a feature flag?', author: 'enrique' })
  expect(saved!.editedAt).not.toBeNull()
  const replies = await ok<{ body: string; author: string }[]>(
    human.get(`/api/comments?parentType=update&parentId=${saved!.id}`),
  )
  expect(replies).toMatchObject([{ body: 'Yes, off by default.', author: 'enrique' }])

  // Delete it, after confirming: its replies go with it.
  await header.hover()
  await header.getByRole('button', { name: 'delete', exact: true }).click()
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
