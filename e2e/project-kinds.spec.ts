import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { e2eEnv } from './env'
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

test('a ticket of a project with no software kind shows no git panels, and software brings them back', async ({
  page,
  human,
}) => {
  const music = await createProject(human, `Mixing ${Date.now()}`, ['music'])
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Mix the intro' } }),
  )
  await page.goto(`/projects/${music.id}/features/${t.id}`)
  const details = page.getByRole('region', { name: 'Details' })
  await expect(details).toBeVisible()
  await expect(details.getByText('Base branch', { exact: true })).toHaveCount(0)
  await expect(details.getByText('Needs', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^Branch in / })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Runs' })).toHaveCount(0)

  // Software added: the git panels come back on the same ticket.
  await ok(human.patch(`/api/projects/${music.id}`, { data: { kinds: ['music', 'software'] } }))
  await page.reload()
  await expect(details.getByText('Base branch', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible()
})

test('a project with no software kind has a plain work folder under the data folder; software has none', async ({
  human,
}) => {
  const music = await createProject(human, `Folder ${Date.now()}`, ['music'])
  const row = await ok<{ workFolder: string | null }>(human.get(`/api/projects/${music.id}`))
  expect(row.workFolder).toBe(path.join(e2eEnv().dataDir, 'projects', String(music.id)))
  expect(fs.statSync(row.workFolder!).isDirectory()).toBe(true)
  expect(fs.existsSync(path.join(row.workFolder!, '.git'))).toBe(false)

  const software = await createProject(human, 'Folder software')
  const soft = await ok<{ workFolder: string | null }>(human.get(`/api/projects/${software.id}`))
  expect(soft.workFolder).toBeNull()
})

test('the human approves a ticket of a project with no software kind, and taking it back reopens it', async ({
  human,
}) => {
  const music = await createProject(human, `Hand-off ${Date.now()}`, ['music'])
  const t = await ok<{ id: number; complexity: string }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Record the take' } }),
  )
  // No repo, so no review rounds: low, the builder checks its own work.
  expect(t.complexity).toBe('low')
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))

  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  const approved = await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${t.id}`))
  expect(approved.stage.kind).toBe('done')

  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: null } }))
  const back = await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${t.id}`))
  expect(back.stage.kind).toBe('review')
})
