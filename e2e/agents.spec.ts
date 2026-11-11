import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext, Locator, Page } from '@playwright/test'

import {
  AGENTS,
  TOKEN_PLACEHOLDER,
  mcpSetup,
  repoClaudeDir,
  reviewSkillsInstall,
  skillInstall,
} from '#/lib/agents'
import { AGENT_CLIENTS } from '#/lib/constants'
import { inDatabase } from './db'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

test('the shell picked for the install lines is kept in the URL, remembered, and shared by the page', async ({
  page,
}) => {
  const hydration: string[] = []
  page.on('console', (m) => /hydrat/i.test(m.text()) && hydration.push(m.text()))
  const tabs = (name: string) => page.getByRole('tab', { name })
  const bash = 'bash / zsh'
  // The review skills' line at the top, into ~/.claude: the global copy in the run's CLAUDE_HOME may show
  // a line of its own, into that folder.
  const reviewLine = page.getByText(/^\$t = Join-Path .*-C "\$HOME\\\.claude"; Remove-Item \$t$/)

  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
  // The skill's install line and the review skills' each have a picker; bash until one is picked.
  await expect(tabs(bash)).toHaveCount(2)
  for (const tab of await tabs(bash).all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  await tabs('PowerShell').first().click()
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  // One choice for the page: the review skills' line follows.
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await expect(reviewLine).toBeVisible()

  await page.reload()
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(reviewLine).toBeVisible()

  // Without one in the URL, the shell this browser remembers comes back, and the URL says so.
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=powershell(&|$)/)
  await expect(page.getByText(/^New-Item -ItemType Directory/)).toBeVisible()
  await tabs(bash).first().click()
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)
  await expect(page.getByText(/^\$t = Join-Path/)).toHaveCount(0)

  // A link that names one wins over what is remembered.
  await page.goto('/agents?shell=powershell')
  for (const tab of await tabs('PowerShell').all()) await expect(tab).toHaveAttribute('aria-selected', 'true')
  await page.goto('/agents')
  await expect(page).toHaveURL(/[?&]shell=bash(&|$)/)

  expect(hydration).toEqual([])
})

test('Generate commands makes a token per agent, fills it into the MCP setup line, lists it and revokes it', async ({
  page,
  human,
}) => {
  const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))
  const mints: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/agent-tokens' && r.method() === 'POST') mints.push(r.url())
  })
  const shown = (text: string) => page.getByText(text, { exact: true })
  const tokens = page.getByRole('list', { name: 'Agent tokens' })

  await page.goto('/agents?shell=bash')
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
  // Nothing is made on load, and there is no field to paste a token into.
  await expect(page.getByLabel('Agent token', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Makes a token for this agent')).toContainText('1 year')
  await expect(page.getByText('Makes a token for this agent')).toContainText('shown only once')
  await expect(page.getByText('Makes a token for this agent')).toContainText('orchestrator')
  await expect(page.locator('main')).not.toContainText(/gate_|gate token|passkey gate/i)

  for (const client of AGENT_CLIENTS) {
    await page.getByRole('tab', { name: AGENTS[client].label }).click()
    // The commands carry the placeholder until Generate commands is pressed, named after the CLI.
    await expect(shown(mcpSetup(client, boardUrl, '').text)).toBeVisible()
    await expect(page.getByLabel('Agent name')).toHaveValue(client)
    const made = await generateCommands(page)
    expect(made.name).toBe(client)
    // The token those commands carry runs and delegates: Connect makes it an orchestrator.
    expect(made.role).toBe('orchestrator')
    await expect(page.getByRole('status').filter({ hasText: 'shown this once' })).toContainText(client)
    await expect(page.getByRole('status').filter({ hasText: 'shown this once' })).toContainText(
      'orchestrator',
    )
    await expect(shown(mcpSetup(client, boardUrl, made.token).text)).toBeVisible()
    // The install lines are not the MCP token's: they wait for a copy, which mints their own.
    for (const line of [
      skillInstall(client, 'bash', boardUrl, ''),
      reviewSkillsInstall('bash', boardUrl, ''),
    ])
      await expect(shown(line)).toBeVisible()
    for (const line of [
      skillInstall(client, 'bash', boardUrl, made.token),
      reviewSkillsInstall('bash', boardUrl, made.token),
    ])
      await expect(shown(line)).toHaveCount(0)
    const listed = tokens.getByRole('listitem').filter({ hasText: client }).first()
    await expect(listed).toContainText('never used')
    await expect(listed.getByText('Orchestrator', { exact: true })).toBeVisible()
  }
  expect(mints).toHaveLength(AGENT_CLIENTS.length)

  // Renamed: the token is that name's, and so is its row.
  const renamed = await generateCommands(page, 'review-bot')
  expect(renamed.name).toBe('review-bot')
  await expect(shown(mcpSetup('opencode', boardUrl, renamed.token).text)).toBeVisible()
  const row = tokens.getByRole('listitem').filter({ hasText: 'review-bot' })
  await expect(row).toContainText('expires')
  await expect(tokens).not.toContainText(renamed.token)
  // A name no agent can go by is not sent.
  await page.getByLabel('Agent name').fill('two words')
  await expect(page.getByRole('button', { name: 'Generate commands' })).toBeDisabled()

  // Revoked: gone from the list here and on the board.
  await row.getByRole('button', { name: /^Revoke review-bot/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(row).toHaveCount(0)
  const left = await ok<{ name: string }[]>(human.get('/api/agent-tokens'))
  expect(left.map((t) => t.name)).not.toContain('review-bot')
  expect(JSON.stringify(left)).not.toContain(renamed.token)

  // Shown once: a reload brings the placeholder back and makes nothing.
  await page.reload()
  await expect(page.getByText(/Bearer <token>/).first()).toBeVisible()
  await expect(page.getByText(renamed.token)).toHaveCount(0)
  expect(mints).toHaveLength(AGENT_CLIENTS.length + 1)
})

test("a token that answers after the page moved to another CLI never fills that CLI's commands", async ({
  page,
  human,
}) => {
  const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))
  const shown = (text: string) => page.getByText(text, { exact: true })
  // The POST is held until the page has moved on to Codex.
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let reached!: () => void
  const atBoard = new Promise<void>((r) => (reached = r))
  await page.route('**/api/agent-tokens', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    reached()
    await held
    await route.continue()
  })

  await page.goto('/agents?shell=bash')
  await page.getByRole('tab', { name: AGENTS.claude.label }).click()
  await expect(page.getByLabel('Agent name')).toHaveValue('claude')
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/agent-tokens' && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Generate commands' }).click()
  await atBoard
  await page.getByRole('tab', { name: AGENTS.codex.label }).click()
  await expect(page.getByLabel('Agent name')).toHaveValue('codex')
  release()
  const made = (await (await answered).json()) as { name: string; token: string }
  expect(made.name).toBe('claude')

  // The board made claude's token (the list shows it), but Codex's commands still wait for their own.
  await expect(
    page
      .getByRole('list', { name: 'Agent tokens' })
      .getByRole('listitem')
      .filter({ hasText: 'claude' })
      .first(),
  ).toBeVisible()
  await expect(shown(mcpSetup('codex', boardUrl, '').text)).toBeVisible()
  await expect(shown(skillInstall('codex', 'bash', boardUrl, ''))).toBeVisible()
  await expect(shown(reviewSkillsInstall('bash', boardUrl, ''))).toBeVisible()
  await expect(page.getByLabel('Agent name')).toHaveValue('codex')
  await expect(page.getByText(made.token)).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'shown this once' })).toHaveCount(0)
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

/**
 * Presses Generate commands (after naming the agent `name`, when given) and returns the token the board
 * made: the commands on the page carry it from then on.
 */
async function generateCommands(
  page: Page,
  name?: string,
): Promise<{ name: string; token: string; role: string }> {
  if (name !== undefined) await page.getByLabel('Agent name').fill(name)
  const minted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/agent-tokens' && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Generate commands' }).click()
  const res = await minted
  expect(res.status()).toBe(201)
  return (await res.json()) as { name: string; token: string; role: string }
}

/**
 * Copies the install line `entry` shows and runs it: the PowerShell one on Windows (with Windows' own tar
 * first, as a PowerShell terminal finds it), the bash one elsewhere. The copy mints the line's download
 * credential when the page has none yet, so it never carries the placeholder; a home and a temp folder of
 * its own keep a line for any other folder from reaching the real ones.
 */
async function runShownLine(page: Page, entry: Locator) {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash'
  await page
    .getByRole('tab', { name: shell === 'bash' ? 'bash / zsh' : 'PowerShell' })
    .first()
    .click()
  await entry.getByRole('button', { name: 'Copy', exact: true }).first().click()
  const line = entry.locator('pre').first()
  await expect(line).not.toContainText(TOKEN_PLACEHOLDER)
  const text = (await line.textContent())!
  const scratch = fs.mkdtempSync(path.join(e2eEnv().root, 'shell '))
  if (shell === 'bash') {
    execFileSync('bash', ['-c', text], { cwd: scratch, env: { ...process.env, HOME: scratch } })
  } else {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', text], {
      cwd: scratch,
      env: { ...process.env, TEMP: scratch, PATH: `${system32};${process.env.PATH}` },
    })
  }
}

/**
 * Copies an install line inside `scope` (the review skills' own line by default) and returns the short-lived
 * download credential that copy minted: every install line on the page carries it from then on.
 */
async function copyInstallLine(page: Page, scope: Locator = page.locator('section#review-skills')) {
  const minted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/agent-setup/skill-token' && r.request().method() === 'POST',
  )
  await scope.getByRole('button', { name: 'Copy', exact: true }).first().click()
  const res = await minted
  expect(res.status()).toBe(201)
  return (await res.json()) as { token: string; expiresAt: string }
}

/** The bundle as served, file by file: the tar extracted into a folder of its own. */
async function servedBundle(human: APIRequestContext) {
  const claude = path.join(fs.mkdtempSync(path.join(e2eEnv().root, 'served ')), '.claude')
  await install(human, claude)
  const paths = await ok<string[]>(human.get('/api/agent-setup/review-skills?list'))
  return Object.fromEntries(paths.map((p) => [p, fs.readFileSync(path.join(claude, p), 'utf8')]))
}

/** How many lines a text has, line endings aside, as git counts them. */
const lineCount = (text: string) => {
  const lf = text.replace(/\r\n/g, '\n')
  return lf.split('\n').length - (lf.endsWith('\n') ? 1 : 0)
}

/** The button of one file in a copy's list of files not up to date. */
const fileButton = (scope: Locator, file: string) =>
  scope
    .getByRole('list', { name: 'Files not up to date' })
    .getByRole('button', { name: new RegExp(`\\.claude/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })

/** The open dialog fits the viewport and scrolls inside, and the page behind it stays where it was. */
async function scrollsInside(page: Page) {
  const dialog = page.getByRole('dialog')
  const box = (await dialog.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const before = await page.evaluate(() => window.scrollY)
  await dialog.hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
}

type Tracking = 'global' | 'repo'
const track = (human: APIRequestContext, skillsTracking: Tracking) =>
  ok<{ skillsTracking: Tracking }>(human.patch('/api/settings', { data: { skillsTracking } }))

test('an agent can neither mint the download credential nor install the skills', async ({ agent }) => {
  const mint = await agent.post('/api/agent-setup/skill-token', { data: {} })
  expect(mint.status()).toBe(403)
  expect((await mint.json()).error).toMatch(/only the human/)
  for (const data of [{ client: 'claude', kind: 'skill' }, { kind: 'review-skills' }]) {
    const install = await agent.post('/api/agent-setup/skill/install', { data })
    expect(install.status()).toBe(403)
    expect((await install.json()).error).toMatch(/only the human/)
  }
})

// Which copy the Connect an agent page tracks is one setting for the whole board, and the user-wide .claude is one
// folder: the tests that set either run one after another.
test.describe('the review skills on the Connect an agent page: the copy it tracks, and installing them', () => {
  test.describe.configure({ mode: 'serial' })

  test('Global until another is picked, and kept across reloads and pages', async ({
    page,
    human,
    agent,
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

    // The one choice comes back from another page without a reload.
    await tab('By repo').click()
    await saved('repo')
    await page.evaluate(() => Object.assign(window, { stillHere: true }))
    await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(/\/settings(\?|$)/)
    await page.goBack()
    await expect(page).toHaveURL(/^http:\/\/[^/]+\/agents(\?|$)/)
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
    await shows('repo')
    expect(await page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true)
    await tab('Global').click()
    await saved('global')
    await shows('global')

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
    // The run's CLAUDE_HOME is not ~/.claude: the status says the line installs into it.
    const status = await ok<{ global: object }>(human.get('/api/agent-setup/review-skills/status'))
    expect(status.global).toMatchObject({ path: path.resolve(claude), installTo: path.resolve(claude) })

    await page.goto('/agents?shell=bash')
    const here = page.getByRole('region', { name: 'On this machine' })
    const entry = here.getByRole('listitem', { name: '~/.claude on this machine' })
    await expect(entry.getByText('Outdated', { exact: true })).toBeVisible()
    await expect(entry.getByText(path.resolve(claude), { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'In your repos' })).toHaveCount(0)
    await expect(page.getByRole('listitem', { name: / in / })).toHaveCount(0)
    // Said of the folder CLAUDE_HOME names, not of ~/.claude, which the line above still installs into.
    await expect(here).toContainText(
      'The copy in the folder CLAUDE_HOME names on the machine the board runs on',
    )
    await expect(here).not.toContainText('The line above brings it up to date')
    await expect(page.getByText(reviewSkillsInstall('bash', boardUrl, ''), { exact: true })).toBeVisible()

    // Opened: the files that are not current and the line that installs into the folder checked.
    const more = entry.getByRole('button', { name: `3 of ${total} files differ or are missing` })
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(entry.getByRole('list', { name: 'Files not up to date' }).getByRole('listitem')).toHaveText([
      /^missing\s*\.claude\/agents\/todo-review-ticket\.md$/,
      /^outdated\s*\.claude\/skills\/feature-review\/SKILL\.md$/,
      /^missing\s*\.claude\/skills\/todo-review\/SKILL\.md$/,
    ])
    const line = (shell: 'bash' | 'powershell', token = '') =>
      entry.getByText(reviewSkillsInstall(shell, boardUrl, token, path.resolve(claude)), { exact: true })
    await expect(line('bash')).toBeVisible()
    await expect(entry.getByRole('button', { name: 'Copy' })).toBeVisible()
    await page.getByRole('tab', { name: 'PowerShell' }).first().click()
    await expect(line('powershell')).toBeVisible()
    // Copying it mints the short-lived credential it then carries.
    const { token } = await copyInstallLine(page, entry)
    await expect(line('powershell', token)).toBeVisible()

    // What the line does, run as shown: the bundle extracted into the folder checked. Checked again, it
    // is up to date and its own skill is still there.
    await runShownLine(page, entry)
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Up to date', { exact: true })).toBeVisible()
    await expect(entry.getByRole('button')).toHaveCount(0)
    expect(fs.readFileSync(path.join(claude, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('Not the bundle.\n')

    // Nothing there: not installed, said of that folder and not of a repo, with the line that installs
    // into it (the one above would not).
    emptyHome()
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Not installed', { exact: true })).toBeVisible()
    await expect(entry).not.toContainText('in the repo')
    await expect(entry).not.toContainText('Uses the ~/.claude install')
    await expect(entry.getByText('None of these files are there yet: this line installs them.')).toBeVisible()
    await expect(entry.getByRole('button')).toHaveCount(1)
    expect(fs.existsSync(claude)).toBe(false)
    await runShownLine(page, entry)
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Up to date', { exact: true })).toBeVisible()
    emptyHome()
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
    const { token } = await copyInstallLine(page, drifted)
    await expect(line('powershell', token)).toBeVisible()
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

    // Every repo row names its project, the board-wide list On Connect.
    await page.reload()
    await expect(drifted).toContainText(project.name)
    await expect(plain).toBeVisible()
  })

  test('a stale file in the global copy opens to what the line would change in it, read anew each time', async ({
    page,
    human,
  }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    const claude = emptyHome()
    await drifted(human, claude)
    await track(human, 'global')
    const served = await servedBundle(human)

    await page.goto('/agents?shell=bash')
    const here = page.getByRole('region', { name: 'On this machine' })
    const entry = here.getByRole('listitem', { name: '~/.claude on this machine' })
    await entry.getByRole('button', { name: /files differ or are missing$/ }).click()
    const list = entry.getByRole('list', { name: 'Files not up to date' })
    const stale = [
      'agents/todo-review-ticket.md',
      'skills/feature-review/SKILL.md',
      'skills/todo-review/SKILL.md',
    ]
    await expect(list.getByRole('listitem')).toHaveCount(3)
    for (const [i, p] of stale.entries())
      await expect(list.getByRole('listitem').nth(i).getByRole('button')).toHaveAccessibleName(
        new RegExp(`\\.claude/${p.replace(/\./g, '\\.')}$`),
      )

    // The edited skill: the extra line in the installed copy is removed, in a hunk near the end, with the
    // installed file as the old side and the served one as the new.
    const file = fileButton(entry, 'skills/feature-review/SKILL.md')
    await file.click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: '.claude/skills/feature-review/SKILL.md' }),
    ).toBeVisible()
    const installed = path.join(path.resolve(claude), 'skills', 'feature-review', 'SKILL.md')
    await expect(dialog.locator('[data-line="header"]')).toHaveText([
      `--- a/${installed.replace(/^\/+/, '')}`,
      '+++ b/skills/feature-review/SKILL.md (served by the board)',
    ])
    await expect(dialog.locator('[data-line="hunk"]')).toHaveText([/^@@ -\d+,5 \+\d+,3 @@$/])
    await expect(dialog.locator('[data-line="del"]').last()).toHaveText(/^\d+\s*-An older line\.$/)
    await expect(dialog.locator('[data-line="add"]')).toHaveCount(0)
    // Three lines of context and the two removed, not the whole file.
    await expect(dialog.locator('[data-line="context"]')).toHaveCount(3)
    await expect(dialog.locator('[data-line="del"]')).toHaveCount(2)

    // Escape closes it, back on the file; from the keyboard it opens again, and Close closes it.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(file).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(file).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog.locator('[data-line="del"]')).toHaveCount(2)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(file).toBeFocused()
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(entry.getByText(/^mkdir -p/)).toBeVisible()

    // A missing file: all of the served one added, from /dev/null. Long, it scrolls inside the dialog only.
    await fileButton(entry, 'skills/todo-review/SKILL.md').click()
    await expect(dialog.getByRole('heading', { name: '.claude/skills/todo-review/SKILL.md' })).toBeVisible()
    await expect(dialog.locator('[data-line="header"]').first()).toHaveText('--- /dev/null')
    const lines = lineCount(served['skills/todo-review/SKILL.md']!)
    await expect(dialog.locator('[data-line="hunk"]')).toHaveText([`@@ -0,0 +1,${lines} @@`])
    await expect(dialog.locator('[data-line="add"]')).toHaveCount(lines)
    await expect(dialog.locator('[data-line="del"]')).toHaveCount(0)
    await scrollsInside(page)
    await page.keyboard.press('Escape')

    // Installed since the list was read: pressed again, the file shows no changes, not the earlier diff.
    await install(human, claude)
    await file.click()
    await expect(dialog.getByText('No changes: the installed copy is up to date')).toBeVisible()
    await expect(dialog.locator('[data-line]')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // A folder where a file should be: outdated, and the dialog says it can't be read.
    const checklists = path.join(claude, 'skills', 'feature-review', 'checklists.md')
    fs.rmSync(checklists)
    fs.mkdirSync(checklists)
    await here.getByRole('button', { name: 'Check again' }).click()
    await expect(list.getByRole('listitem')).toHaveText([
      /^outdated\s*\.claude\/skills\/feature-review\/checklists\.md$/,
    ])
    await fileButton(entry, 'skills/feature-review/checklists.md').click()
    await expect(
      dialog.getByText(/The installed copy can.t be read as text \(a folder is in its place\)/),
    ).toBeVisible()
    await expect(dialog.getByText('Loading…')).toHaveCount(0)
    await expect(dialog.locator('[data-line]')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test("a stale file in a repo's own copy opens to the diff of that repo's .claude", async ({
    page,
    human,
    project,
  }) => {
    await drifted(human, emptyHome())
    await track(human, 'repo')
    const { dir, claude } = await driftedCheckout(human)
    await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'drifted' } }))
    const served = await servedBundle(human)

    await page.goto('/agents?shell=bash')
    const entry = page
      .getByRole('region', { name: 'In your repos' })
      .getByRole('listitem', { name: `drifted in ${project.name}` })
    await entry.getByRole('button', { name: /files differ or are missing$/ }).click()
    await fileButton(entry, 'skills/feature-review/SKILL.md').click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: '.claude/skills/feature-review/SKILL.md' }),
    ).toBeVisible()
    const installed = path.join(claude, 'skills', 'feature-review', 'SKILL.md')
    const old = dialog.locator('[data-line="header"]').first()
    await expect(old).toHaveText(`--- a/${installed.replace(/^\/+/, '')}`)
    await expect(old).not.toContainText(e2eEnv().claudeHome.replace(/^\/+/, ''))
    await expect(dialog.locator('[data-line="del"]').last()).toHaveText(/-An older line\.$/)
    await expect(dialog.locator('[data-line="add"]')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()

    await fileButton(entry, 'agents/todo-review-ticket.md').click()
    await expect(dialog.locator('[data-line="header"]').first()).toHaveText('--- /dev/null')
    await expect(dialog.locator('[data-line="add"]')).toHaveCount(
      lineCount(served['agents/todo-review-ticket.md']!),
    )
    await expect(dialog.locator('[data-line="del"]')).toHaveCount(0)
  })

  test('a diff left open closes once its file is up to date, and never opens again by itself', async ({
    page,
    human,
  }) => {
    const claude = emptyHome()
    await drifted(human, claude)
    await track(human, 'global')
    const served = await servedBundle(human)
    const skill = path.join(claude, 'skills', 'feature-review', 'SKILL.md')
    const diffs: string[] = []
    page.on('request', (r) => r.url().includes('/review-skills/diff') && diffs.push(r.url()))
    // The page reads the copies again when it is shown again (the user back from the terminal), once the
    // last read is older than the board's 5 seconds: time is moved on rather than waited for.
    await page.clock.install()
    const backToThePage = async () => {
      await page.clock.fastForward(6_000)
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    }

    await page.goto('/agents?shell=bash')
    const entry = page.getByRole('listitem', { name: '~/.claude on this machine' })
    const dialog = page.getByRole('dialog')
    await entry.getByRole('button', { name: /files differ or are missing$/ }).click()
    const files = entry.getByRole('list', { name: 'Files not up to date' }).getByRole('listitem')

    // The file is brought up to date while its diff is open; the copy still has others to install.
    await fileButton(entry, 'skills/feature-review/SKILL.md').click()
    await expect(dialog.locator('[data-line="del"]')).toHaveCount(2)
    fs.writeFileSync(skill, served['skills/feature-review/SKILL.md']!)
    await backToThePage()
    await expect(dialog).toHaveCount(0)
    await expect(files).toHaveCount(2)

    // The whole copy brought up to date while a diff is open.
    await fileButton(entry, 'skills/todo-review/SKILL.md').click()
    await expect(dialog.locator('[data-line="add"]').first()).toBeVisible()
    await install(human, claude)
    await backToThePage()
    await expect(dialog).toHaveCount(0)
    await expect(entry.getByText('Up to date', { exact: true })).toBeVisible()

    // Outdated again: the list is there to press, and no diff opens or is asked for until one is pressed.
    const asked = diffs.length
    fs.appendFileSync(skill, '\nAn older line.\n')
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(entry.getByText('Outdated', { exact: true })).toBeVisible()
    await backToThePage()
    await expect(entry.getByRole('button', { name: /files differ or are missing$/ })).toBeVisible()
    await expect(dialog).toHaveCount(0)
    expect(diffs).toHaveLength(asked)
    // Nor is the page left behind a dialog: the list is as it was, and still answers.
    const more = entry.getByRole('button', { name: /files differ or are missing$/ })
    await expect(files).toHaveText([/^outdated\s*\.claude\/skills\/feature-review\/SKILL\.md$/])
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  test('added and removed lines are told apart by sign and colour, in light and in dark', async ({
    page,
    human,
  }) => {
    const claude = emptyHome()
    await drifted(human, claude)
    // One line edited near the top as well: removed, added and unchanged lines in one view.
    const skill = path.join(claude, 'skills', 'feature-review', 'SKILL.md')
    const text = fs.readFileSync(skill, 'utf8')
    const first = text.split('\n').find((l) => l.trim().length > 20)!
    fs.writeFileSync(skill, text.replace(first, `${first} (edited)`))
    await track(human, 'global')

    const looks: Record<string, Record<string, { bg: string; color: string }>> = {}
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto('/agents?shell=bash')
      if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      const entry = page.getByRole('listitem', { name: '~/.claude on this machine' })
      await entry.getByRole('button', { name: /files differ or are missing$/ }).click()
      await fileButton(entry, 'skills/feature-review/SKILL.md').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.locator('[data-line="add"]')).toHaveCount(1)
      const look = async (kind: string) => {
        const row = dialog.locator(`[data-line="${kind}"]`).first()
        await expect(row, kind).toHaveCSS('font-family', /mono/i)
        return row.evaluate((el) => {
          const s = getComputedStyle(el)
          return { bg: s.backgroundColor, color: s.color }
        })
      }
      looks[colorScheme] = { add: await look('add'), del: await look('del'), context: await look('context') }
      await expect(dialog.locator('[data-line="add"]').first()).toContainText(`+${first}`)
      await expect(dialog.locator('[data-line="del"]').first()).toContainText(`-${first} (edited)`)
      const { add, del, context } = looks[colorScheme]!
      expect(add.bg, colorScheme).not.toBe(context.bg)
      expect(add.bg, colorScheme).not.toBe(del.bg)
      expect(del.bg, colorScheme).not.toBe(context.bg)
      expect(add.color, colorScheme).not.toBe(del.color)
    }
    // The added lines' text follows the theme, as the board's other green does.
    expect(looks.dark!.add.color).not.toBe(looks.light!.add.color)
    expect(looks.dark!.context.color).not.toBe(looks.light!.context.color)
  })

  test('copying an install line mints one download credential, and every install line then carries it', async ({
    page,
    human,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: e2eEnv().baseURL })
    const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))
    const claude = emptyHome()
    await track(human, 'global')
    const mints: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/agent-setup/skill-token' && r.method() === 'POST')
        mints.push(r.url())
    })
    const copy = async (scope: Locator) => {
      const answered = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/agent-setup/skill-token' && r.request().method() === 'POST',
      )
      await scope.getByRole('button', { name: 'Copy', exact: true }).click()
      return (await (await answered).json()) as { token: string; expiresAt: string }
    }

    await page.goto('/agents?shell=bash')
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
    await page.getByRole('tab', { name: AGENTS.claude.label }).click()
    // Nothing is minted on load: the lines say <token>.
    await expect(page.getByText(skillInstall('claude', 'bash', boardUrl, ''), { exact: true })).toBeVisible()
    await expect(page.getByText(reviewSkillsInstall('bash', boardUrl, ''), { exact: true })).toBeVisible()
    expect(mints).toHaveLength(0)

    // The first copy mints one, and the clipboard carries it.
    const step2 = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '2. Install the skill' }) })
    const { token, expiresAt } = await copy(step2)
    expect(mints).toHaveLength(1)
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(skillInstall('claude', 'bash', boardUrl, token))
    // Every install line on the page carries it, with when it expires.
    await expect(
      page.getByText(skillInstall('claude', 'bash', boardUrl, token), { exact: true }),
    ).toBeVisible()
    await expect(page.getByText(reviewSkillsInstall('bash', boardUrl, token), { exact: true })).toBeVisible()
    await expect(
      page.getByText(reviewSkillsInstall('bash', boardUrl, token, claude), { exact: true }),
    ).toBeVisible()
    const note = page.getByRole('status').filter({ hasText: 'about ten minutes' })
    await expect(note).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', expiresAt)
    // Another line's copy reuses it: one mint for the visit.
    const step3 = page.locator('section#review-skills')
    await step3.getByRole('button', { name: 'Copy', exact: true }).first().click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(reviewSkillsInstall('bash', boardUrl, token))
    expect(mints).toHaveLength(1)
    // It is kept as its hash only.
    const row = inDatabase(
      (db) =>
        db.prepare('select token_hash from skill_tokens order by id desc limit 1').get() as {
          token_hash: string
        },
    )
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'))

    // Ten minutes on the page's clock, that credential has expired: the next copy makes a new one instead
    // of copying the dead one, and every line on the page carries the new one.
    await page.clock.install()
    await page.clock.fastForward(Date.parse(expiresAt) - Date.now() + 2_000)
    const fresh = await copy(step2)
    expect(mints).toHaveLength(2)
    expect(fresh.token).not.toBe(token)
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(skillInstall('claude', 'bash', boardUrl, fresh.token))
    await expect(
      page.getByText(skillInstall('claude', 'bash', boardUrl, token), { exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByText(skillInstall('claude', 'bash', boardUrl, fresh.token), { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(reviewSkillsInstall('bash', boardUrl, fresh.token), { exact: true }),
    ).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', fresh.expiresAt)
  })

  test("a repo's own install line mints the page's credential too", async ({
    page,
    human,
    project,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: e2eEnv().baseURL })
    const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))
    const { dir } = await driftedCheckout(human)
    await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'mint line' } }))
    await track(human, 'repo')
    await page.goto('/agents?shell=bash')
    const entry = page
      .getByRole('region', { name: 'In your repos' })
      .getByRole('listitem', { name: `mint line in ${project.name}` })
    await entry.getByRole('button', { name: /files differ or are missing$/ }).click()
    const line = entry.getByText(reviewSkillsInstall('bash', boardUrl, '', repoClaudeDir(dir)), {
      exact: true,
    })
    await expect(line).toBeVisible()
    const mints: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/agent-setup/skill-token' && r.method() === 'POST')
        mints.push(r.url())
    })
    const answered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/agent-setup/skill-token' && r.request().method() === 'POST',
    )
    await entry.getByRole('button', { name: 'Copy', exact: true }).click()
    const { token } = (await (await answered).json()) as { token: string }
    expect(mints).toHaveLength(1)
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(reviewSkillsInstall('bash', boardUrl, token, repoClaudeDir(dir)))
    // The page's other lines carry the same one.
    await expect(page.getByText(reviewSkillsInstall('bash', boardUrl, token), { exact: true })).toBeVisible()
    await expect(
      page.getByText(skillInstall('claude', 'bash', boardUrl, token), { exact: true }),
    ).toBeVisible()
  })

  test('the board skill button installs it under the home the board runs as, saying where, when and what', async ({
    page,
    human,
  }) => {
    const { home } = e2eEnv()
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true })
    const { boardUrl } = await ok<{ boardUrl: string }>(human.get('/api/agent-setup'))
    const tokensBefore = (await ok<unknown[]>(human.get('/api/agent-tokens'))).length
    const served = await (await human.get('/api/agent-setup/skill?client=claude')).text()

    await page.goto('/agents?shell=bash')
    await page.getByRole('tab', { name: AGENTS.claude.label }).click()
    const step2 = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '2. Install the skill' }) })
    const answered = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/agent-setup/skill/install' && r.request().method() === 'POST',
    )
    await step2.getByRole('button', { name: 'Install skill' }).click()
    const made = (await (await answered).json()) as { at: string; files: { path: string; action: string }[] }
    const file = path.join(home, '.claude', 'skills', 'board', 'SKILL.md')
    expect(made.files).toEqual([{ path: file, action: 'created' }])
    const card = step2.getByRole('status', { name: 'Installed the board skill' })
    await expect(card).toContainText(file)
    await expect(card).toContainText('created')
    await expect(card.locator('time')).toHaveAttribute('datetime', made.at)
    expect(fs.readFileSync(file, 'utf8')).toBe(served)
    // The copy line stays beside it, for another machine, and the button reads Update skill now.
    await expect(page.getByText(skillInstall('claude', 'bash', boardUrl, ''), { exact: true })).toBeVisible()
    await expect(step2.getByRole('button', { name: 'Update skill' })).toBeVisible()
    // Neither press needs a token: the agent tokens are as they were.
    expect((await ok<unknown[]>(human.get('/api/agent-tokens'))).length).toBe(tokensBefore)
  })

  test('the review skills button installs the bundle, then reads Update skill, and adds no agent token', async ({
    page,
    human,
  }) => {
    const { claudeHome } = e2eEnv()
    emptyHome()
    const tokensBefore = (await ok<unknown[]>(human.get('/api/agent-tokens'))).length
    const served = await servedBundle(human)
    const paths = Object.keys(served)

    await page.goto('/agents?shell=bash')
    const step3 = page.locator('section#review-skills')
    const button = step3.getByRole('button', { name: 'Install skill' })
    await expect(button).toBeVisible()
    const answered = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/agent-setup/skill/install' && r.request().method() === 'POST',
    )
    await button.click()
    const made = (await (await answered).json()) as { at: string; files: { path: string; action: string }[] }
    expect(made.files.map((f) => f.path)).toEqual(paths.map((p) => path.join(claudeHome, ...p.split('/'))))
    const card = step3.getByRole('status', { name: 'Installed the review skills' })
    await expect(card.getByRole('listitem')).toHaveCount(paths.length)
    await expect(card.locator('time')).toHaveAttribute('datetime', made.at)
    for (const p of paths)
      expect(fs.readFileSync(path.join(claudeHome, ...p.split('/')), 'utf8'), p).toBe(served[p])
    // The status read again after the install turns the button into Update skill.
    await expect(step3.getByRole('button', { name: 'Update skill' })).toBeVisible()
    // Nothing was added to the agent tokens, and no token was needed.
    expect((await ok<unknown[]>(human.get('/api/agent-tokens'))).length).toBe(tokensBefore)
  })

  test('a forced failure names the path and the status, says what to check and offers Retry; the line stays', async ({
    page,
    human,
  }) => {
    const { claudeHome } = e2eEnv()
    const dir = path.dirname(claudeHome)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(claudeHome, 'not a folder\n')
    // The first file the bundle writes, as the tar lays it out.
    const paths = await ok<string[]>(human.get('/api/agent-setup/review-skills?list'))
    const target = path.join(claudeHome, ...paths[0]!.split('/'))
    const posts: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/agent-setup/skill/install' && r.method() === 'POST')
        posts.push(r.url())
    })
    try {
      await page.goto('/agents?shell=bash')
      const step3 = page.locator('section#review-skills')
      await step3.getByRole('button', { name: 'Install skill' }).click()
      const card = step3.getByRole('alert', { name: 'Could not install the review skills' })
      await expect(card).toContainText('HTTP 500')
      await expect(card).toContainText(target)
      await expect(card).toContainText('belongs to the user the board runs as')
      await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible()
      // The copy line is still on the page, for another machine.
      await expect(step3.getByText(/api\/agent-setup\/review-skills/).first()).toBeVisible()
      const again = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/agent-setup/skill/install' && r.request().method() === 'POST',
      )
      await card.getByRole('button', { name: 'Retry' }).click()
      expect((await again).status()).toBe(500)
      expect(posts).toHaveLength(2)
      await expect(card).toBeVisible()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a project's Team page keeps the cycle and the default agents, and sends to Connect for the skills", async ({
    page,
    project,
  }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    await page.goto(`/projects/${project.id}/agents`)
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible()
    const cycle = page.getByRole('region', { name: 'Default agents' })
    await expect(cycle).toContainText('The build and review cycle:')
    // No install surface of its own: no name field, no token, no install line, no Track toggle.
    await expect(page.getByLabel('Agent name')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Generate commands' })).toHaveCount(0)
    await expect(page.getByRole('tablist', { name: 'Track' })).toHaveCount(0)
    await expect(page.getByText(/mkdir -p|Join-Path/)).toHaveCount(0)
    await expect(cycle.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute('href', '/agents')
    // The cycle's agents still add from here.
    await cycle.getByRole('button', { name: 'Add the default agents' }).click()
    await expect(cycle.getByText('All added')).toBeVisible()
    await expect(page.getByText('@spec')).toBeVisible()
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
        {
          const at = '/agents?shell=powershell'
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

    test("a stale file's diff fits the phone: long lines scroll inside the diff, never the page", async ({
      page,
      human,
      project,
    }) => {
      const { dir } = await driftedCheckout(human)
      await ok(human.post('/api/repos', { data: { projectId: project.id, repoPath: dir, name: 'drifted' } }))
      await drifted(human, emptyHome())
      const sideways = () =>
        page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
      const within = async (what: Locator, name: string) => {
        const box = (await what.boundingBox())!
        expect(box.x, name).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width, name).toBeLessThanOrEqual(390)
      }
      for (const tracking of ['global', 'repo'] as const) {
        await track(human, tracking)
        await page.goto('/agents?shell=bash')
        const copy =
          tracking === 'global'
            ? page.getByRole('listitem', { name: '~/.claude on this machine' })
            : page.getByRole('listitem', { name: `drifted in ${project.name}` })
        await copy.getByRole('button', { name: /files differ or are missing$/ }).click()
        for (const file of ['agents/todo-review-ticket.md', 'skills/feature-review/SKILL.md']) {
          const name = `${tracking} ${file}`
          await fileButton(copy, file).click()
          const dialog = page.getByRole('dialog')
          const changes = dialog.getByRole('region', { name: 'Changes' })
          await expect(changes.locator('[data-line="hunk"]')).toHaveCount(1)
          await expect(dialog).toHaveCSS('opacity', '1')
          expect(await sideways(), name).toBe(false)
          await within(dialog, name)
          await within(changes, name)
          if (file.startsWith('agents/')) {
            // The agent's long lines are wider than the phone: its diff scrolls sideways, on its own.
            expect(await changes.evaluate((el) => el.scrollWidth > el.clientWidth), name).toBe(true)
            await scrollsInside(page)
          }
          await dialog.getByRole('button', { name: 'Close' }).click()
          await expect(dialog).toHaveCount(0)
        }
      }
    })
  })
})
