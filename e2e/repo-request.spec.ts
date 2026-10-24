import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Project, Repo } from '#/lib/api'
import { HUMAN, e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

/** A new checkout of its own whose origin is a GitHub URL: the board only reads the URL, never the network. */
function githubCheckout(slug: string) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, 'repo-request-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: dir })
  return dir
}

test('an agent asks for a repo, the human answers Add on the card, and the agent moves its ticket onto it', async ({
  page,
  api,
  agent,
  human,
  project,
}) => {
  const t = await api.ticket({ title: 'Build the shop', status: 'in_progress' })
  const repoPath = githubCheckout('acme/shop')

  // Agents never write repos directly.
  expect(
    (await agent.post('/api/repos', { data: { projectId: project.id, repoPath, name: 'shop' } })).status(),
  ).toBe(403)
  await ok(
    agent.post(`/api/tickets/${t.id}/repo-request`, {
      data: { name: 'shop', repoPath, githubRepo: 'acme/shop' },
    }),
  )
  // Asking alone adds nothing, and the human cannot take the agents' route.
  const before = await ok<Project>(human.get(`/api/projects/${project.id}`))
  expect(before.repos.map((r) => r.name)).toEqual(['repo'])
  expect(
    (
      await human.post(`/api/tickets/${t.id}/repo-request`, {
        data: { name: 'shop', repoPath, githubRepo: 'acme/shop' },
      })
    ).status(),
  ).toBe(403)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('group', { name: 'Decision' })
  await expect(card).toContainText('Your decision is needed')
  await expect(page.getByText('Add repo shop?')).toBeVisible()
  await card.getByRole('radio', { name: /^Add/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(card).toContainText(`decided by ${HUMAN}`)
  await expect(page.getByText(/Added repo shop \(repo \d+\)/)).toBeVisible()

  const after = await ok<Project>(human.get(`/api/projects/${project.id}`))
  const shop = after.repos.find((r) => r.name === 'shop') as Repo
  expect(shop).toMatchObject({ repoPath, githubRepo: 'acme/shop', baseBranch: 'main' })

  // The agent moves its ticket onto the new repo, at once.
  await ok(agent.put(`/api/tickets/${t.id}/repo`, { data: { repoId: shop.id } }))
  expect(await api.getTicket(t.id)).toMatchObject({ repoId: shop.id, baseBranch: 'main' })
  await page.reload()
  await expect(page.locator('#repo')).toContainText('shop')
})
