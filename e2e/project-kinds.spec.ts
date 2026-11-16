import type { APIRequestContext } from '@playwright/test'

import { expect, ok, test } from './fixtures'

/** A project of the given kinds, with no repo of its own. */
async function createProject(human: APIRequestContext, name: string, kinds?: string[]) {
  return ok<{ id: number; kinds: string[]; defaultPhases: string[] }>(
    human.post('/api/projects', { data: kinds ? { name, kinds } : { name } }),
  )
}

test('a new project is software unless its kinds say otherwise', async ({ human }) => {
  const plain = await createProject(human, 'plain')
  expect(plain.kinds).toEqual(['software'])
  expect(plain.defaultPhases).toEqual([
    'Implementation',
    'Pushed',
    'PR',
    'CI',
    'Preview',
    'Summary',
    'Merged',
  ])
})

test('a project with no software kind starts its tickets with the non-software phases', async ({ human }) => {
  const music = await createProject(human, 'music', ['music', 'art'])
  expect(music.kinds).toEqual(['music', 'art'])
  expect(music.defaultPhases).toEqual(['Implementation', 'Summary'])
})

test('kinds are refused when empty or unknown, and an agent cannot change them', async ({ human, agent }) => {
  const res = await human.post('/api/projects', { data: { name: 'bad', kinds: [] } })
  expect(res.status()).toBe(400)
  const game = await human.post('/api/projects', { data: { name: 'bad', kinds: ['game'] } })
  expect(game.status()).toBe(400)
  const music = await createProject(human, 'changed by agent')
  const denied = await agent.patch(`/api/projects/${music.id}`, { data: { kinds: ['music'] } })
  expect(denied.status()).toBe(403)
})

test('the human changes a project to software and keeps the built-in phases', async ({ human }) => {
  const music = await createProject(human, 'switch', ['music'])
  const row = await ok<{ kinds: string[]; defaultPhases: string[] }>(
    human.patch(`/api/projects/${music.id}`, { data: { kinds: ['music', 'software'] } }),
  )
  // Kept in the order the kinds are listed in (software first).
  expect(row.kinds).toEqual(['software', 'music'])
  expect(row.defaultPhases).toContain('PR')
})

test('a project with no software kind hides its git pages in the menu, and its settings show its kinds', async ({
  page,
  human,
}) => {
  const music = await createProject(human, 'Studio', ['music'])
  await page.goto(`/projects/${music.id}`)
  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'PR queue' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Previews' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Cleanup' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Repositories' })).toHaveCount(0)

  await page.goto(`/projects/${music.id}/settings`)
  await expect(page.getByRole('checkbox', { name: 'Music' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Software' })).not.toBeChecked()
})

test('a software project keeps its git pages in the menu', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}`)
  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'PR queue' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Previews' })).toBeVisible()
})
