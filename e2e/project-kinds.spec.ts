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

test('a project with no software kind has a maker, not the review cycle, on its Team page', async ({
  page,
  human,
}) => {
  const music = await createProject(human, `Team ${Date.now()}`, ['music'])
  await page.goto(`/projects/${music.id}/agents`)
  const defaults = page.getByRole('region', { name: 'Default agents' })
  await expect(defaults.getByText('The maker makes the work', { exact: false })).toBeVisible()
  await expect(defaults.getByText('spec', { exact: true })).toHaveCount(0)
  await expect(defaults.getByRole('button', { name: 'Add the default agents' })).toBeVisible()
  await defaults.getByRole('button', { name: 'Add the default agents' }).click()
  await expect(page.getByText('Added maker')).toBeVisible()
})

test('approval closes a hand-off only from its review stage, and needs still hold it', async ({ human }) => {
  const music = await createProject(human, `Gate ${Date.now()}`, ['music'])
  const open = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Not started' } }),
  )
  // Approved before any work: the call is recorded, the ticket does not close.
  await ok(human.put(`/api/tickets/${open.id}/approval`, { data: { verdict: 'approved' } }))
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${open.id}`))).stage.kind).not.toBe(
    'done',
  )
  await ok(human.put(`/api/tickets/${open.id}/approval`, { data: { verdict: null } }))

  const base = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Base' } }),
  )
  const held = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Held', status: 'review' } }),
  )
  await ok(human.patch(`/api/tickets/${held.id}`, { data: { needs: [base.id] } }))
  // The same refusal a move to done gets: the need is not done.
  const refused = await human.put(`/api/tickets/${held.id}/approval`, { data: { verdict: 'approved' } })
  expect(refused.status()).toBe(409)
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${held.id}`))).stage.kind).toBe(
    'review',
  )
})

test('a second approval closes a hand-off only when its needs are done', async ({ human, agent }) => {
  const music = await createProject(human, `Second ${Date.now()}`, ['music'])
  const base = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Needed first' } }),
  )
  const held = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Approved too early' } }),
  )
  // Approved while still open: recorded, the ticket does not close.
  await ok(human.put(`/api/tickets/${held.id}/approval`, { data: { verdict: 'approved' } }))
  // An agent moves it to review, and the human then gives it a need that is not done.
  await ok(agent.patch(`/api/tickets/${held.id}`, { data: { status: 'review' } }))
  await ok(human.patch(`/api/tickets/${held.id}`, { data: { needs: [base.id] } }))
  // A second approval closes it the way a first one from review would: the need holds it.
  const again = await human.put(`/api/tickets/${held.id}/approval`, { data: { verdict: 'approved' } })
  expect(again.status()).toBe(409)
  expect((await ok<{ status: string }>(human.get(`/api/tickets/${held.id}`))).status).toBe('review')
})

test('an agent may repeat the done stage of a ticket already done, without closing it again', async ({
  human,
  agent,
}) => {
  const music = await createProject(human, `Repeat ${Date.now()}`, ['music'])
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, {
      data: { title: 'Closed by approval', status: 'review' },
    }),
  )
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  const closed = await ok<{ status: string }>(human.get(`/api/tickets/${t.id}`))
  // The same stage again, with an edit: not a close, so it goes through.
  await ok(
    agent.patch(`/api/tickets/${t.id}`, { data: { title: 'Edited by the agent', status: closed.status } }),
  )
  const after = await ok<{ title: string; status: string }>(human.get(`/api/tickets/${t.id}`))
  expect(after).toMatchObject({ title: 'Edited by the agent', status: closed.status })
})

test('taking back an approval reopens a hand-off even after the project gains software', async ({
  human,
}) => {
  const music = await createProject(human, `Reopen ${Date.now()}`, ['music'])
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Gained software', status: 'review' } }),
  )
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${t.id}`))).stage.kind).toBe('done')
  await ok(human.patch(`/api/projects/${music.id}`, { data: { kinds: ['music', 'software'] } }))
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: null } }))
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${t.id}`))).stage.kind).toBe('review')
})

test('a ticket with no repo, and a lane under it, stay without a repo in a project with no software kind', async ({
  human,
}) => {
  const music = await createProject(human, `Repoless ${Date.now()}`, ['music'])
  // A repo the project held while it was software: it stays stored, and no ticket of the music project uses it.
  await ok(
    human.post('/api/repos', { data: { projectId: music.id, repoPath: e2eEnv().repoPath, name: 'stored' } }),
  )
  const parent = await ok<{ id: number; repoId: number | null; repos: unknown[] }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'No repo' } }),
  )
  expect(parent.repoId).toBeNull()
  // Read back: the ticket reports no repo of its own, and none of the project's stored one.
  const read = await ok<{ repoId: number | null; repos: unknown[] }>(human.get(`/api/tickets/${parent.id}`))
  expect(read.repoId).toBeNull()
  expect(read.repos).toEqual([])
  const lane = await ok<{ repoId: number | null }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Lane', parentId: parent.id } }),
  )
  expect(lane.repoId).toBeNull()
})

test('an agent cannot close a hand-off, and approving a ticket that names a repo is only a call', async ({
  human,
  agent,
}) => {
  const music = await createProject(human, `Close ${Date.now()}`, ['music'])
  const repo = await ok<{ id: number }>(
    human.post('/api/repos', { data: { projectId: music.id, repoPath: e2eEnv().repoPath, name: 'named' } }),
  )
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, {
      data: { title: 'Closed by a call', status: 'review' },
    }),
  )
  // An agent cannot move it to done, whatever its stage.
  const doneKey = 'done'
  const agentMove = await agent.patch(`/api/tickets/${t.id}`, { data: { status: doneKey } })
  expect(agentMove.status()).toBe(403)
  // A ticket that names a repo: its approval is recorded but does not close it.
  const named = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, {
      data: { title: 'Named repo', status: 'review', repoId: repo.id },
    }),
  )
  await ok(human.put(`/api/tickets/${named.id}/approval`, { data: { verdict: 'approved' } }))
  // It moves to Approved, a stage of its own kind, not to a done stage.
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${named.id}`))).stage.kind).toBe(
    'approved',
  )
})

test('a hand-off sent back from done loses its approval; an agent cannot close it from Approved', async ({
  human,
  agent,
}) => {
  const music = await createProject(human, `Sent back ${Date.now()}`, ['music'])
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Sent back', status: 'review' } }),
  )
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  // Sent back by the human, then sent to review again by an agent: not approved any more.
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'in_progress' } }))
  await ok(agent.patch(`/api/tickets/${t.id}`, { data: { status: 'review' } }))
  const reworked = await ok<{ approvedAt: string | null; stage: { kind: string } }>(
    human.get(`/api/tickets/${t.id}`),
  )
  expect(reworked.stage.kind).toBe('review')
  expect(reworked.approvedAt).toBeNull()

  // An approved hand-off is not closed by an agent, whatever stage it is in.
  const held = await ok<{ id: number }>(
    human.post(`/api/projects/${music.id}/tickets`, { data: { title: 'Approved', status: 'in_progress' } }),
  )
  await ok(human.patch(`/api/tickets/${held.id}`, { data: { status: 'approved' } }))
  const closed = await agent.patch(`/api/tickets/${held.id}`, { data: { status: 'done' } })
  expect(closed.status()).toBe(403)
})

test('deleting a software ticket repo does not reopen it when its approval is taken back', async ({
  human,
}) => {
  const soft = await createProject(human, `Repo gone ${Date.now()}`)
  const repo = await ok<{ id: number }>(
    human.post('/api/repos', { data: { projectId: soft.id, repoPath: e2eEnv().repoPath, name: 'gone' } }),
  )
  const t = await ok<{ id: number }>(
    human.post(`/api/projects/${soft.id}/tickets`, {
      data: { title: 'Software', status: 'review', repoId: repo.id },
    }),
  )
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: 'approved' } }))
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { status: 'done' } }))
  await ok(human.delete(`/api/repos/${repo.id}`))
  await ok(human.put(`/api/tickets/${t.id}/approval`, { data: { verdict: null } }))
  // Done stays done: a software ticket reopens only as a pull request review does.
  expect((await ok<{ stage: { kind: string } }>(human.get(`/api/tickets/${t.id}`))).stage.kind).toBe('done')
})

test('the kind picker offers all ten kinds, and a professional kind hides the git pages', async ({
  page,
  human,
}) => {
  const lawyer = await createProject(human, `Firm ${Date.now()}`, ['lawyer'])
  expect(lawyer.kinds).toEqual(['lawyer'])
  await page.goto(`/projects/${lawyer.id}`)
  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'PR queue' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Cleanup' })).toHaveCount(0)

  await page.goto(`/projects/${lawyer.id}/settings`)
  for (const label of [
    'Software',
    'Music',
    'Art',
    'Writing',
    'Video',
    'Research',
    'Lawyer',
    'Accountant',
    'Cybersecurity',
    'Life',
  ]) {
    await expect(page.getByRole('checkbox', { name: label, exact: true })).toHaveCount(1)
  }
  await expect(page.getByRole('checkbox', { name: 'Lawyer', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Accountant', exact: true })).not.toBeChecked()
})
