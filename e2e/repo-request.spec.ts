import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Project, Repo } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

/** A new checkout of its own whose origin is a GitHub URL: the board only reads the URL, never the network. */
function githubCheckout(slug: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, 'repo-request-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: dir })
  return dir
}

test('an agent adds a repo to its project at once and moves its ticket onto it', async ({
  api,
  agent,
  human,
  project,
}) => {
  const t = await api.ticket({ title: 'Build the shop', status: 'in_progress' })
  const repoPath = githubCheckout('acme/shop')

  // The Repositories page's routes stay the human's.
  expect(
    (await agent.post('/api/repos', { data: { projectId: project.id, repoPath, name: 'shop' } })).status(),
  ).toBe(403)
  const shop = await ok<Repo>(
    agent.post(`/api/tickets/${t.id}/repos`, {
      data: { name: 'shop', repoPath, githubRepo: 'acme/shop' },
    }),
  )
  const after = await ok<Project>(human.get(`/api/projects/${project.id}`))
  expect(after.repos.find((r) => r.name === 'shop')).toMatchObject({
    id: shop.id,
    repoPath,
    githubRepo: 'acme/shop',
    baseBranch: 'main',
  })

  // It changes the repo of its own project, then moves its ticket onto it.
  await ok(agent.patch(`/api/projects/${project.id}/repos/${shop.id}`, { data: { baseBranch: 'develop' } }))
  await ok(agent.put(`/api/tickets/${t.id}/repo`, { data: { repoId: shop.id } }))
  expect(await api.getTicket(t.id)).toMatchObject({ repoId: shop.id, baseBranch: 'develop' })
})
