import type { APIRequestContext } from '@playwright/test'

import type { Project, ProjectNote } from '#/lib/api'

import { expect, ok, section, test } from './fixtures'

/**
 * The project's notes on the Overview: a short fact the human and every agent must not rediscover.
 * The card adds, edits, deletes and pins them in place, and its manage dialog holds the whole list.
 */

const notes = (scope: Parameters<typeof section>[0]) => section(scope, 'Notes')
const list = (human: APIRequestContext, projectId: number) =>
  ok<ProjectNote[]>(human.get(`/api/projects/${projectId}/notes`))

test('the human adds, edits and deletes a note on the Overview, and the empty state explains it', async ({
  page,
  project,
  human,
}) => {
  await page.goto(`/projects/${project.id}`)
  const card = notes(page)
  await expect(card).toContainText('A note is one short fact the next session must not rediscover')
  await expect(card).toContainText('pnpm release 0.2.5')
  await expect(card).toContainText('47101 and up, one per run')

  // Add: label and body are plain text, with the limits in view.
  await card.getByRole('button', { name: 'Add note' }).click()
  await expect(card.getByLabel('Note label')).toBeVisible()
  await expect(card).toContainText('/60')
  await expect(card).toContainText('/500')
  await card.getByLabel('Note label').fill('Release command')
  await card.getByLabel('Note body').fill('pnpm release 0.2.5')
  await card.getByRole('button', { name: 'Save note' }).click()
  await expect(card.getByRole('listitem').filter({ hasText: 'Release command' })).toContainText(
    'pnpm release 0.2.5',
  )
  await expect(card).not.toContainText('A note is one short fact')

  // It is the project's note, also after a reload.
  await page.reload()
  await expect(notes(page).getByText('Release command')).toBeVisible()
  expect((await list(human, project.id)).map((n) => n.label)).toEqual(['Release command'])

  // Edit.
  await notes(page).getByRole('button', { name: 'Edit Release command' }).click()
  await notes(page).getByLabel('Note body').fill('pnpm release 0.2.6')
  await notes(page).getByRole('button', { name: 'Save note' }).click()
  await expect(notes(page).getByRole('listitem').filter({ hasText: 'Release command' })).toContainText(
    'pnpm release 0.2.6',
  )
  expect((await list(human, project.id))[0]!.body).toBe('pnpm release 0.2.6')

  // Delete, and the empty state comes back after a reload too.
  await notes(page).getByRole('button', { name: 'Delete Release command' }).click()
  await expect(notes(page)).toContainText('A note is one short fact the next session must not rediscover')
  expect(await list(human, project.id)).toEqual([])
  await page.reload()
  await expect(notes(page)).toContainText('A note is one short fact the next session must not rediscover')
})

test('the manage dialog lists every note and edits and deletes there; a pinned note comes first', async ({
  page,
  project,
  human,
}) => {
  for (let i = 1; i <= 6; i++)
    await ok(human.post(`/api/projects/${project.id}/notes`, { data: { label: `N${i}`, body: `fact ${i}` } }))
  await page.goto(`/projects/${project.id}`)
  const card = notes(page)
  // Four on the card, the rest behind the manage control.
  await expect(card.getByRole('listitem')).toHaveCount(4)
  await expect(card.getByRole('listitem').first()).toContainText('N1')
  await card.getByRole('button', { name: 'Manage all (6)' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('listitem')).toHaveCount(6)
  await expect(dialog.getByRole('listitem').filter({ hasText: 'N6' })).toContainText('fact 6')

  // Edit the last one there: the list and the API follow.
  await dialog.getByRole('button', { name: 'Edit N6' }).click()
  await dialog.getByLabel('Note body').fill('fact six, corrected')
  await dialog.getByRole('button', { name: 'Save note' }).click()
  await expect(dialog.getByRole('listitem').filter({ hasText: 'N6' })).toContainText('fact six, corrected')
  expect((await list(human, project.id)).find((n) => n.label === 'N6')!.body).toBe('fact six, corrected')

  // Delete one there: it leaves the dialog and the API.
  await dialog.getByRole('button', { name: 'Delete N5' }).click()
  await expect(dialog.getByRole('listitem').filter({ hasText: 'N5' })).toHaveCount(0)
  expect((await list(human, project.id)).map((n) => n.label)).not.toContain('N5')

  // Pin N4 from the card: it goes above every unpinned note, over the API and after a reload.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  await card.getByRole('button', { name: 'Pin N4' }).click()
  await expect(card.getByRole('listitem').first()).toContainText('N4')
  expect((await list(human, project.id))[0]!.label).toBe('N4')
  await page.reload()
  await expect(notes(page).getByRole('listitem').first()).toContainText('N4')
  // Unpin: it goes back after the others.
  await notes(page).getByRole('button', { name: 'Unpin N4' }).click()
  await expect.poll(async () => (await list(human, project.id)).at(-1)!.label).toBe('N4')
})

test('Notes is an Overview card the layout hides and moves like the others', async ({
  page,
  project,
  human,
}) => {
  await ok(human.post(`/api/projects/${project.id}/notes`, { data: { label: 'Layout', body: 'a fact' } }))
  const layoutOf = async () =>
    (await ok<Project>(human.get(`/api/projects/${project.id}`))).layout.filter(
      (it) => it.area === 'overview',
    )
  const editor = () => page.getByRole('region', { name: 'Layout' })
  const notesSwitch = () => editor().getByRole('switch', { name: 'Show Notes on the Overview' })
  const save = async () => {
    await editor().getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  }

  await page.goto(`/projects/${project.id}/settings`)
  await expect(notesSwitch()).toBeChecked()
  await notesSwitch().click()
  await save()
  expect((await layoutOf()).find((it) => it.id === 'overview.notes')!.hidden).toBe(true)
  await page.goto(`/projects/${project.id}`)
  await expect(section(page, 'Notes')).toHaveCount(0)

  await page.goto(`/projects/${project.id}/settings`)
  await expect(notesSwitch()).not.toBeChecked()
  await notesSwitch().click()
  await editor().getByRole('button', { name: 'Move Notes up on the Overview' }).click()
  await save()
  const overview = await layoutOf()
  expect(overview.find((it) => it.id === 'overview.notes')!.hidden).toBe(false)
  expect(overview.at(-2)!.id).toBe('overview.notes')
  await page.goto(`/projects/${project.id}`)
  await expect(notes(page)).toContainText('Layout')
  await expect(section(page, 'Carrying over')).toHaveCount(1)
  const titles = await page.locator('[data-slot="card-title"]').allTextContents()
  expect(titles.findIndex((t) => /^\s*Notes/.test(t))).toBeLessThan(
    titles.findIndex((t) => /^\s*Carrying over/.test(t)),
  )
})
