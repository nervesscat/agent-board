import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { repoClaudeDir, reviewSkillsInstall } from '#/lib/agents'
import type { Project } from '#/lib/api'
import { inDatabase } from './db'
import { e2eEnv } from './env'
import { expect, ok, seededProject, test } from './fixtures'

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
 * Does what an install line does: extracts the served bundle into `claude`, replacing the files of the
 * same name and keeping the rest.
 */
async function install(human: APIRequestContext, claude: string) {
  const tar = await human.get('/api/agent-setup/review-skills')
  expect(tar.ok()).toBe(true)
  fs.writeFileSync(path.join(path.dirname(claude), 'review-skills.tar'), await tar.body())
  fs.mkdirSync(claude, { recursive: true })
  execFileSync('tar', ['-xf', '../review-skills.tar'], { cwd: claude })
}

/**
 * The review bundle as served into `claude`, then drifted: one skill edited, two files never added, and a
 * skill of its own.
 */
async function drifted(human: APIRequestContext, claude: string) {
  await install(human, claude)
  fs.appendFileSync(path.join(claude, 'skills', 'feature-review', 'SKILL.md'), '\nAn older line.\n')
  fs.rmSync(path.join(claude, 'skills', 'todo-review', 'SKILL.md'))
  fs.rmSync(path.join(claude, 'agents', 'todo-review-ticket.md'))
  fs.mkdirSync(path.join(claude, 'skills', 'x'))
  fs.writeFileSync(path.join(claude, 'skills', 'x', 'SKILL.md'), 'Not the bundle.\n')
}

/**
 * A checkout of its own in the run's throwaway folder (a space in its path), holding a drifted copy of
 * the review bundle. `install` does what its install line does.
 */
async function driftedCheckout(human: APIRequestContext) {
  const dir = fs.mkdtempSync(path.join(e2eEnv().root, 'skills repo '))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const claude = path.join(dir, '.claude')
  await drifted(human, claude)
  return { dir, claude, install: () => install(human, claude) }
}

/** The run board's user-wide .claude (CLAUDE_HOME), emptied: no folder at all. */
function emptyHome() {
  const { claudeHome } = e2eEnv()
  fs.rmSync(path.dirname(claudeHome), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(claudeHome), { recursive: true })
  return claudeHome
}

type Tracking = 'global' | 'repo'
const track = (human: APIRequestContext, skillsTracking: Tracking) =>
  ok<{ skillsTracking: Tracking }>(human.patch('/api/settings', { data: { skillsTracking } }))

// Which copy the Agents pages track is one setting for the whole board, and the user-wide .claude is one
// folder: the tests that set either run one after another.
test.describe('the copy of the review skills the Agents pages track', () => {
  test.describe.configure({ mode: 'serial' })

  test('Global until another is picked, kept across reloads, and the same on both Agents pages', async ({
    page,
    human,
    agent,
    project,
  }) => {
    inDatabase((db) => db.prepare("delete from settings where key = 'skillsTracking'").run())
    expect((await ok<{ skillsTracking: Tracking }>(human.get('/api/settings'))).skillsTracking).toBe('global')
    const tab = (name: string) => page.getByRole('tablist', { name: 'Track' }).getByRole('tab', { name })
    const shows = async (tracking: Tracking) => {
      await expect(tab(tracking === 'global' ? 'Global' : 'By repo')).toHaveAttribute('aria-selected', 'true')
      await expect(tab(tracking === 'global' ? 'By repo' : 'Global')).toHaveAttribute(
        'aria-selected',
        'false',
      )
      await expect(page.getByRole('region', { name: 'On this machine' })).toHaveCount(
        tracking === 'global' ? 1 : 0,
      )
      await expect(page.getByRole('region', { name: 'In your repos' })).toHaveCount(
        tracking === 'repo' ? 1 : 0,
      )
    }
    const saved = async (tracking: Tracking) =>
      expect
        .poll(async () => (await ok<{ skillsTracking: Tracking }>(human.get('/api/settings'))).skillsTracking)
        .toBe(tracking)

    await page.goto('/agents')
    await shows('global')
    await expect(
      page
        .getByRole('region', { name: 'On this machine' })
        .getByRole('listitem', { name: '~/.claude on this machine' }),
    ).toBeVisible()

    // From the keyboard: the arrow moves to By repo, Enter picks it.
    await tab('Global').focus()
    await page.keyboard.press('ArrowRight')
    await expect(tab('By repo')).toBeFocused()
    await page.keyboard.press('Enter')
    await shows('repo')
    await saved('repo')
    await page.reload()
    await shows('repo')

    await tab('Global').click()
    await shows('global')
    await saved('global')
    await page.reload()
    await shows('global')

    // Both Agents pages show the one choice, also when moving between them without a reload.
    await page.goto(`/projects/${project.id}/agents`)
    await shows('global')
    await page.evaluate(() => Object.assign(window, { stillHere: true }))
    await tab('By repo').click()
    await saved('repo')
    await page.getByRole('banner').getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(page).toHaveURL(/^http:\/\/[^/]+\/agents(\?|$)/)
    await expect(page.getByRole('heading', { name: 'Connect agents' })).toBeVisible()
    await shows('repo')
    await tab('Global').click()
    await saved('global')
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/agents`))
    await shows('global')
    expect(await page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true)

    // Agents read the choice; only the human changes it.
    expect((await ok<{ skillsTracking: Tracking }>(agent.get('/api/settings'))).skillsTracking).toBe('global')
    expect((await agent.patch('/api/settings', { data: { skillsTracking: 'repo' } })).status()).toBe(403)
    expect((await human.patch('/api/settings', { data: { skillsTracking: 'both' } })).status()).toBe(400)
    expect((await ok<{ skillsTracking: Tracking }>(human.get('/api/settings'))).skillsTracking).toBe('global')
  })

  test('the global copy: outdated, opened to its files and the install line, up to date once installed', async ({
    page,
    human,
  }) => {
    const claude = emptyHome()
    await drifted(human, claude)
    await track(human, 'global')
    const total = (await ok<string[]>(human.get('/api/agent-setup/review-skills?list'))).length
    const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))

    await page.goto('/agents?shell=bash')
    const here = page.getByRole('region', { name: 'On this machine' })
    const entry = here.getByRole('listitem', { name: '~/.claude on this machine' })
    await expect(entry.getByText('Outdated', { exact: true })).toBeVisible()
    await expect(entry.getByText(path.resolve(claude), { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'In your repos' })).toHaveCount(0)
    await expect(page.getByRole('listitem', { name: / in / })).toHaveCount(0)

    // Opened: the files that are not current and the line that installs into ~/.claude.
    const more = entry.getByRole('button', { name: `3 of ${total} files differ or are missing` })
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(entry.getByRole('list', { name: 'Files not up to date' }).getByRole('listitem')).toHaveText([
      /^missing\s*\.claude\/agents\/todo-review-ticket\.md$/,
      /^outdated\s*\.claude\/skills\/feature-review\/SKILL\.md$/,
      /^missing\s*\.claude\/skills\/todo-review\/SKILL\.md$/,
    ])
    const line = (shell: 'bash' | 'powershell', token = '') =>
      entry.getByText(reviewSkillsInstall(shell, boardUrl, token), { exact: true })
    await expect(line('bash')).toBeVisible()
    await expect(entry.getByRole('button', { name: 'Copy' })).toBeVisible()
    await page.getByRole('tab', { name: 'PowerShell' }).first().click()
    await expect(line('powershell')).toBeVisible()
    await page.getByLabel('Gate token').fill('gate_e2e')
    await expect(line('powershell', 'gate_e2e')).toBeVisible()

    // What the line does: the bundle extracted into ~/.claude. Checked again, it is up to date and its
    // own skill is still there.
    await install(human, claude)
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Up to date', { exact: true })).toBeVisible()
    await expect(entry.getByRole('button')).toHaveCount(0)
    expect(fs.readFileSync(path.join(claude, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('Not the bundle.\n')

    // Nothing there: not installed, said of ~/.claude and not of a repo.
    emptyHome()
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Not installed', { exact: true })).toBeVisible()
    await expect(entry).not.toContainText('in the repo')
    await expect(entry).not.toContainText('Uses the ~/.claude install')
    await expect(entry.getByRole('button')).toHaveCount(0)
    expect(fs.existsSync(claude)).toBe(false)

    // A project's Agents page shows the same copy.
    await drifted(human, claude)
    await page.goto(`/projects/${seededProject().id}/agents`)
    await expect(
      page
        .getByRole('region', { name: 'On this machine' })
        .getByRole('listitem', { name: '~/.claude on this machine' })
        .getByText('Outdated', { exact: true }),
    ).toBeVisible()
  })

  test("each repo's own copy of the review skills: outdated, opened to its files and line, and up to date once installed", async ({
    page,
    human,
    project,
  }) => {
    await track(human, 'repo')
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
    await track(human, 'repo')
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

    test('an opened outdated copy wraps its path and line instead of widening the page', async ({
      page,
      human,
      project,
    }) => {
      const { dir } = await driftedCheckout(human)
      await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'drifted' } }))
      await drifted(human, emptyHome())
      const sideways = () =>
        page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
      for (const tracking of ['global', 'repo'] as const) {
        await track(human, tracking)
        for (const at of ['/agents?shell=powershell', `/projects/${project.id}/agents?shell=powershell`]) {
          await page.goto(at)
          await expect(page.getByRole('tablist', { name: 'Track' })).toBeVisible()
          const copy =
            tracking === 'global'
              ? page
                  .getByRole('region', { name: 'On this machine' })
                  .getByRole('listitem', { name: '~/.claude on this machine' })
              : page
                  .getByRole('region', { name: 'In your repos' })
                  .getByRole('listitem', { name: `drifted in ${project.name}` })
          await copy.getByRole('button', { name: /files differ or are missing$/ }).click()
          await expect(copy.getByText(/^\$t = Join-Path/)).toBeVisible()
          expect(await sideways(), `${tracking} ${at}`).toBe(false)
        }
      }
    })
  })
})
