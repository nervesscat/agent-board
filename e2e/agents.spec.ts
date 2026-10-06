import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { repoClaudeDir, reviewSkillsInstall } from '#/lib/agents'
import type { Project } from '#/lib/api'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

test('the shell picked for the install lines is kept in the URL, remembered, and shared by the page', async ({
  page,
  project,
}) => {
  const hydration: string[] = []
  page.on('console', (m) => /hydrat/i.test(m.text()) && hydration.push(m.text()))
  const tabs = (name: string) => page.getByRole('tab', { name })
  const bash = 'bash / zsh'

  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Connect agents' })).toBeVisible()
  // The skill's install line and the review skills' each have a picker; bash until one is picked.
  await expect(tabs(bash)).toHaveCount(2)
  for (const tab of await tabs(bash).all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  await tabs('PowerShell').first().click()
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  // One choice for the page: the review skills' line follows.
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()

  await page.reload()
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()

  // Without one in the URL, the shell this browser remembers comes back, and the URL says so: here and
  // on a project's Agents page.
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await page.goto(`/projects/${project.id}/agents`)
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  await expect(tabs('PowerShell')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toBeVisible()
  await tabs(bash).click()
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  // A link that names one wins over what is remembered.
  await page.goto('/agents?shell=powershell')
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)

  expect(hydration).toEqual([])
})

/**
 * A checkout of its own in the run's throwaway folder (a space in its path), holding the review bundle
 * as served, then drifted: one skill edited, two files never added, and a skill of its own. `install`
 * does what an install line does: extracts the served bundle into its .claude.
 */
async function driftedCheckout(human: APIRequestContext) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, 'skills repo '))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const claude = path.join(dir, '.claude')
  const install = async () => {
    const tar = await human.get('/api/agent-setup/review-skills')
    expect(tar.ok()).toBe(true)
    fs.writeFileSync(path.join(dir, 'review-skills.tar'), await tar.body())
    fs.mkdirSync(claude, { recursive: true })
    execFileSync('tar', ['-xf', '../review-skills.tar'], { cwd: claude })
  }
  await install()
  fs.appendFileSync(path.join(claude, 'skills', 'feature-review', 'SKILL.md'), '\nAn older line.\n')
  fs.rmSync(path.join(claude, 'skills', 'todo-review', 'SKILL.md'))
  fs.rmSync(path.join(claude, 'agents', 'todo-review-ticket.md'))
  fs.mkdirSync(path.join(claude, 'skills', 'x'))
  fs.writeFileSync(path.join(claude, 'skills', 'x', 'SKILL.md'), 'Not the bundle.\n')
  return { dir, claude, install }
}

test("each repo's own copy of the review skills: outdated, opened to its files and line, and up to date once installed", async ({
  page,
  human,
  project,
}) => {
  const { dir, claude, install } = await driftedCheckout(human)
  await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'drifted' } }))
  const total = (await ok<string[]>(human.get('/api/agent-setup/review-skills?list'))).length
  const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))

  await page.goto('/agents?shell=bash')
  const repos = page.getByRole('region', { name: 'In your repos' })
  const drifted = repos.getByRole('listitem', { name: `drifted in ${project.name}` })
  const plain = repos.getByRole('listitem', { name: `repo in ${project.name}` })
  await expect(drifted.getByText('Outdated', { exact: true })).toBeVisible()
  await expect(drifted.getByText(dir, { exact: true })).toBeVisible()
  await expect(plain.getByText('Not installed in the repo', { exact: true })).toBeVisible()
  await expect(plain.getByText('Uses the ~/.claude install.')).toBeVisible()
  await expect(plain.getByRole('button')).toHaveCount(0)
  await expect(repos.getByText(/^\$t = Join-Path|^mkdir -p/)).toHaveCount(0)

  // Opened: the files that are not current and the line that installs into this repo's .claude.
  const more = drifted.getByRole('button', { name: `3 of ${total} files differ or are missing` })
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const files = drifted.getByRole('list', { name: 'Files not up to date' }).getByRole('listitem')
  await expect(files).toHaveText([
    /^missing\s*\.claude\/agents\/todo-review-ticket\.md$/,
    /^outdated\s*\.claude\/skills\/feature-review\/SKILL\.md$/,
    /^missing\s*\.claude\/skills\/todo-review\/SKILL\.md$/,
  ])
  const line = (shell: 'bash' | 'powershell', token = '') =>
    drifted.getByText(reviewSkillsInstall(shell, boardUrl, token, repoClaudeDir(dir)), { exact: true })
  await expect(line('bash')).toBeVisible()
  await expect(drifted.getByRole('button', { name: 'Copy' })).toBeVisible()
  // The page's one shell picker and its token fill it in.
  await page.getByRole('tab', { name: 'PowerShell' }).first().click()
  await expect(line('powershell')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'PowerShell' })).toHaveCount(2)
  await page.getByLabel('Gate token').fill('gate_e2e')
  await expect(line('powershell', 'gate_e2e')).toBeVisible()
  await expect(
    page.getByText(/replacing files of the same name and keeping the rest/),
    'the list says what the line does',
  ).toBeVisible()

  // What the line does: the bundle extracted into the repo's .claude. Checked again, it is up to date
  // and its own skill is still there.
  await install()
  await repos.getByRole('button', { name: 'Check again' }).click()
  await expect(drifted.getByText('Up to date', { exact: true })).toBeVisible()
  await expect(drifted.getByRole('button')).toHaveCount(0)
  await expect(repos.getByText(/^\$t = Join-Path|^mkdir -p/)).toHaveCount(0)
  expect(fs.readFileSync(path.join(claude, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('Not the bundle.\n')

  // A project's Agents page lists its repos only.
  await page.goto(`/projects/${project.id}/agents`)
  const own = page.getByRole('region', { name: 'In your repos' }).getByRole('listitem')
  await expect(own).toHaveCount(2)
  await expect(own.filter({ hasText: 'drifted' })).toContainText('Up to date')
  await expect(own.filter({ hasText: 'Not installed in the repo' })).toHaveCount(1)
})

test('a project with no repos says so on its Agents page', async ({ page, human }) => {
  const empty = await ok<Project>(human.post('/api/projects', { data: { name: 'No repos here' } }))
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(`/projects/${empty.id}/agents`)
  const repos = page.getByRole('region', { name: 'In your repos' })
  await expect(repos.getByText('No repos in this project yet.')).toBeVisible()
  await expect(repos.getByRole('listitem')).toHaveCount(0)
  expect(errors).toEqual([])
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('an opened outdated repo wraps its checkout path and line instead of widening the page', async ({
    page,
    human,
    project,
  }) => {
    const { dir } = await driftedCheckout(human)
    await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'drifted' } }))
    for (const at of ['/agents?shell=powershell', `/projects/${project.id}/agents?shell=powershell`]) {
      await page.goto(at)
      const drifted = page
        .getByRole('region', { name: 'In your repos' })
        .getByRole('listitem', { name: `drifted in ${project.name}` })
      await drifted.getByRole('button', { name: /files differ or are missing$/ }).click()
      await expect(drifted.getByText(/^\$t = Join-Path/)).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        at,
      ).toBe(false)
    }
  })
})
