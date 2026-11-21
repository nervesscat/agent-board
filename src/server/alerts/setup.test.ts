import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AGENTS } from '#/lib/agents'
import type { DesktopUpdates, UpdatesState } from '#/lib/updates'
import type { HostTools } from '../hostTools'
import type { AlertActionContext, AlertCandidate, AlertContext, AlertType } from './registry'
import type { SetupEdges } from './setup'

// The alerts live in SQLite and read the skills from disk: point both at throwaway folders before anything
// loads them. Test mode, as the other alert tests.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-setup-alerts-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.CLAUDE_HOME = path.join(tmp, 'claude-home')
process.env.BOARD_ENV = 'test'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2030-06-15T12:00:00.000Z')

let setup: typeof import('./setup')
let agents: typeof import('../agents')
let evaluate: typeof import('./evaluate')
let feed: typeof import('./feed')
let projects: typeof import('../projects')
let features: typeof import('../features')
let tokens: typeof import('../tokens')
let hostTools: typeof import('../hostTools')
let schema: typeof import('#/db').schema
let db: typeof import('#/db').db
let eq: typeof import('drizzle-orm').eq

beforeAll(async () => {
  setup = await import('./setup')
  agents = await import('../agents')
  evaluate = await import('./evaluate')
  feed = await import('./feed')
  projects = await import('../projects')
  features = await import('../features')
  tokens = await import('../tokens')
  hostTools = await import('../hostTools')
  ;({ db, schema } = await import('#/db'))
  ;({ eq } = await import('drizzle-orm'))
}, 60_000)

let count = 0
const newProject = (label: string) => projects.createProject({ name: `${label} ${++count}` }, 'human').id

/** A project with a repo, which a ticket needs. */
const projectWithOneRepo = (label: string) => {
  const projectId = newProject(label)
  db.insert(schema.repos)
    .values({ projectId, name: 'repo', repoPath: folder('ticket-repo'), baseBranch: 'main' })
    .run()
  return projectId
}

/** A folder of its own, empty. */
const folder = (label: string) => {
  const dir = path.join(tmp, `${label}-${++count}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const ctxOf = (projectId: number | null, now = NOW): AlertContext => ({
  projectId,
  now: () => now,
  projects: { list: () => projects.listProjects(), get: (id) => projects.getProject(id) },
})
const actionCtx = (projectId: number | null, subject = ''): AlertActionContext => ({
  ...ctxOf(projectId),
  alert: { id: 1, type: 't', subject, projectId, data: {} },
})

const typeOf = (types: AlertType[], name: string) => types.find((t) => t.type === name)!
const check = async (type: AlertType, projectId: number | null = null, now = NOW) =>
  (await type.check(ctxOf(projectId, now))) as AlertCandidate[]
const action = (type: AlertType, id: string, subject = '') =>
  type.actions![id]!(actionCtx(type.scope === 'board' ? null : 1, subject))

// What the board reaches outside the database and the files: a home to install under, the desktop app's
// updater and the host-tools check. Each test sets what it needs.
const desktop = (over: Partial<DesktopUpdates> = {}): DesktopUpdates => ({
  mode: 'desktop',
  installed: '1.0.0',
  packageType: 'appimage',
  status: 'none',
  newest: null,
  progress: null,
  error: null,
  manual: null,
  checkedAt: null,
  settings: { autoCheck: true, prereleases: false },
  ...over,
})

interface Fakes {
  home: string
  inside: boolean
  state: UpdatesState
  tools: HostTools | null
  checked: HostTools | null
  calls: string[]
}
let fakes: Fakes
const edges = (): SetupEdges => ({
  home: () => fakes.home,
  updates: {
    inside: () => fakes.inside,
    state: async () => fakes.state,
    check: async () => {
      fakes.calls.push('check')
      return fakes.state
    },
    install: async () => {
      fakes.calls.push('install')
      return fakes.state
    },
  },
  tools: {
    last: () => fakes.tools,
    check: async () => {
      fakes.calls.push('tools')
      return fakes.checked ?? fakes.tools!
    },
  },
})
/** The check of the tools, every one fine (at the versions the board needs) but for those given. */
const toolsWith = (probes: Parameters<typeof import('../hostTools').hostToolsWith>[0]) =>
  hostTools.hostToolsWith({
    git: { path: '/usr/bin/git', version: '2.45.1' },
    node: { path: '/usr/bin/node', version: '24.1.0' },
    pnpm: { path: '/usr/bin/pnpm', version: '11.1.2' },
    ...probes,
  })
const types = () => setup.setupAlertTypes(edges())

beforeEach(() => {
  fs.rmSync(process.env.CLAUDE_HOME!, { recursive: true, force: true })
  fakes = {
    home: folder('home'),
    inside: true,
    state: { mode: 'checkout' },
    tools: null,
    checked: null,
    calls: [],
  }
})

describe('registration', () => {
  it('declares every type of the group with its idea, label and description', () => {
    const all = types()
    expect(all.map((t) => t.type)).toEqual([
      'skills-outdated',
      'repo-skills-outdated',
      'board-update-available',
      'release-due',
      'agent-token-expiring',
      'desktop-update-stuck',
      'repo-without-skills',
      'host-tool-broken',
    ])
    expect(new Set(all.map((t) => t.idea))).toEqual(new Set([1, 2, 3, 16, 17, 18, 19]))
    for (const t of all) {
      expect(t.group).toBe('setup')
      expect(t.label).not.toBe('')
      expect(t.description).not.toBe('')
    }
  })

  it('is what the registry holds for the group', async () => {
    const { allAlertTypes } = await import('./registry')
    expect(
      allAlertTypes()
        .filter((t) => t.group === 'setup')
        .map((t) => t.type),
    ).toEqual(setup.alertTypes.map((t) => t.type))
  })
})

describe('idea 1: skills outdated', () => {
  const skillsFile = (client: 'claude' | 'codex' | 'opencode') =>
    path.join(agents.skillDir(client, fakes.home), 'SKILL.md')

  it('says nothing when no skill is installed or every installed one is as served', async () => {
    const t = typeOf(types(), 'skills-outdated')
    expect(await check(t)).toEqual([])
    await agents.installSkill('claude', fakes.home)
    await agents.installSessionSkill('claude', fakes.home)
    await agents.installReviewSkills()
    expect(await check(t)).toEqual([])
    // The REST copy of the board skill is as served too.
    write(skillsFile('codex'), agents.renderSkill('codex', 'rest'))
    expect(await check(t)).toEqual([])
  })

  it('raises one alert listing the board, session and review skills that differ, with an Update button', async () => {
    const t = typeOf(types(), 'skills-outdated')
    write(skillsFile('claude'), '# an old board skill\n')
    await agents.installSessionSkill('claude', fakes.home)
    write(agents.sessionSkillFile('claude', fakes.home), '# an old session skill\n')
    await agents.installReviewSkills()
    const reviewFile = agents.reviewBundlePaths()[0]!
    write(path.join(process.env.CLAUDE_HOME!, ...reviewFile.split('/')), 'changed\n')

    const [alert] = await check(t)
    expect(alert).toMatchObject({ severity: 'warning', title: 'Skills were updated' })
    expect(alert!.subject).toBeUndefined()
    expect(alert!.details).toEqual(
      expect.arrayContaining([
        `Board skill for ${AGENTS.claude.label}: ${skillsFile('claude')}`,
        `Session skill for ${AGENTS.claude.label}: ${agents.sessionSkillFile('claude', fakes.home)}`,
        `Review skills: ${reviewFile} (outdated)`,
      ]),
    )
    expect(alert!.buttons).toContainEqual({ id: 'update', label: 'Update', kind: 'action', primary: true })
  })

  it('Update writes what the board serves, keeps a REST copy a REST copy, and resolves the alert', async () => {
    const t = typeOf(types(), 'skills-outdated')
    write(skillsFile('claude'), '# an old board skill\n')
    write(skillsFile('codex'), agents.renderSkill('codex', 'rest').replace('Keep the board', 'Keep a board'))
    await agents.installSessionSkill('opencode', fakes.home)
    write(agents.sessionSkillFile('opencode', fakes.home), 'old\n')
    await agents.installReviewSkills()
    const reviewFile = path.join(process.env.CLAUDE_HOME!, ...agents.reviewBundlePaths()[0]!.split('/'))
    write(reviewFile, 'changed\n')
    expect((await check(t)).length).toBe(1)

    const result = await action(t, 'update')
    expect(result).toMatchObject({ resolve: true })
    expect(fs.readFileSync(skillsFile('claude'), 'utf8')).toBe(agents.renderSkill('claude', 'mcp'))
    expect(fs.readFileSync(skillsFile('codex'), 'utf8')).toBe(agents.renderSkill('codex', 'rest'))
    expect(fs.readFileSync(agents.sessionSkillFile('opencode', fakes.home), 'utf8')).toBe(
      agents.sessionSkill(),
    )
    expect(fs.readFileSync(reviewFile, 'utf8').replace(/\r\n/g, '\n')).not.toBe('changed\n')
    expect(await check(t)).toEqual([])
  })

  it('raises an alert in the project for a repo whose own review skills differ, and not for one as served', async () => {
    const t = typeOf(types(), 'repo-skills-outdated')
    const projectId = newProject('repo skills')
    const repoPath = folder('repo')
    db.insert(schema.repos).values({ projectId, name: 'api', repoPath, baseBranch: 'main' }).run()
    const repo = db.select().from(schema.repos).where(eq(schema.repos.projectId, projectId)).get()!

    // Not installed in the repo: nothing to update (idea 18 is about that).
    expect(await check(t, projectId)).toEqual([])
    for (const p of agents.reviewBundlePaths()) write(path.join(repoPath, '.claude', ...p.split('/')), 'x')
    const [alert] = await check(t, projectId)
    expect(alert).toMatchObject({ subject: String(repo.id), severity: 'warning' })
    expect(alert!.title).toContain('api')
    expect(alert!.buttons!.map((b) => b.id)).toEqual(['copy', 'open'])
    // The same repo in another project is not asked about.
    expect(await check(t, newProject('other'))).toEqual([])
  })
})

describe('idea 2: a board update is available', () => {
  const newest = { version: '1.2.0', notes: '', notesMarkdown: '', date: '2030-06-10T00:00:00.000Z' }

  it('is raised for an offered release, whether or not a browser skipped it, with its version as the subject', async () => {
    fakes.state = desktop({ status: 'available', newest })
    const t = typeOf(types(), 'board-update-available')
    const [alert] = await check(t)
    expect(alert).toMatchObject({
      subject: '1.2.0',
      severity: 'info',
      title: 'CrossBoard 1.2.0 is available',
    })
    expect(alert!.body).toContain('1.0.0')
    expect(alert!.buttons).toContainEqual({
      id: 'install',
      label: 'Download and install',
      kind: 'action',
      primary: true,
    })
  })

  it('is silent when none is offered, while one downloads, and on a checkout', async () => {
    const t = typeOf(types(), 'board-update-available')
    fakes.state = desktop({ status: 'none' })
    expect(await check(t)).toEqual([])
    fakes.state = desktop({ status: 'downloading', newest })
    expect(await check(t)).toEqual([])
    fakes.state = { mode: 'checkout' }
    expect(await check(t)).toEqual([])
  })

  it('applies only inside the desktop app, and the button starts the install', async () => {
    const t = typeOf(types(), 'board-update-available')
    fakes.inside = false
    expect(t.applies!()).toBe(false)
    fakes.inside = true
    expect(t.applies!()).toBe(true)
    expect(await action(t, 'install')).toEqual({ message: 'Downloading the update' })
    expect(fakes.calls).toEqual(['install'])
  })
})

describe('idea 3: release due', () => {
  /** A project with a Release stage, and a ticket put in it `days` ago by a real move. */
  function releaseProject(stage: { key: string; name: string; kind?: 'review' | 'active' }) {
    const projectId = projectWithOneRepo('release')
    db.insert(schema.stages)
      .values({ projectId, key: stage.key, name: stage.name, kind: stage.kind ?? 'review', position: 30 })
      .run()
    const put = (title: string, days: number) => {
      const ticket = features.createTicket(projectId, { title }, 'human')
      features.updateTicket(ticket.id, { status: stage.key }, 'human')
      const at = new Date(NOW - days * DAY).toISOString()
      const move = db
        .select()
        .from(schema.ticketEvents)
        .where(eq(schema.ticketEvents.ticketId, ticket.id))
        .all()
        .filter((e) => e.kind === 'stage' && e.toStage === stage.key)
      expect(move).toHaveLength(1)
      db.update(schema.ticketEvents).set({ at }).where(eq(schema.ticketEvents.id, move[0]!.id)).run()
      return ticket
    }
    return { projectId, put }
  }
  const release = () => typeOf(types(), 'release-due')

  it('is silent in a project with no Release stage, even with many tickets in other stages', async () => {
    const projectId = projectWithOneRepo('no release')
    for (let i = 0; i < 6; i++)
      features.createTicket(projectId, { title: `t${i}`, status: 'review' }, 'human')
    expect(await check(release(), projectId)).toEqual([])
    // An active stage that merely has the name is not a review stage.
    const { projectId: other, put } = releaseProject({ key: 'release', name: 'Release', kind: 'active' })
    put('x', 30)
    expect(await check(release(), other)).toEqual([])
  })

  it('is raised when a ticket has waited the default days, listing it, with a link to the tickets', async () => {
    const { projectId, put } = releaseProject({ key: 'release', name: 'Release' })
    const old = put('Old fix', setup.RELEASE_DUE_DAYS)
    const [alert] = await check(release(), projectId)
    expect(alert).toMatchObject({ severity: 'info', title: 'Time to cut a release' })
    expect(alert!.details).toEqual([`#${old.id} Old fix (${setup.RELEASE_DUE_DAYS} d)`])
    expect(alert!.buttons).toEqual([
      { id: 'open', label: 'Open the tickets', kind: 'link', href: `/projects/${projectId}/features` },
    ])
  })

  it('is not raised for a few tickets that arrived recently, and the clock decides', async () => {
    const { projectId, put } = releaseProject({ key: 'release', name: 'Release' })
    for (let i = 0; i < setup.RELEASE_DUE_TICKETS - 1; i++) put(`recent ${i}`, 1)
    expect(await check(release(), projectId)).toEqual([])
    // Two days later the same tickets have waited long enough.
    expect(await check(release(), projectId, NOW + 2 * DAY)).toHaveLength(1)
  })

  it('is raised by the count alone, and finds the stage by its name when its key is another', async () => {
    const { projectId, put } = releaseProject({ key: 'ship_it', name: ' Release ' })
    for (let i = 0; i < setup.RELEASE_DUE_TICKETS; i++) put(`recent ${i}`, 0)
    const [alert] = await check(release(), projectId)
    expect(alert!.body).toContain(`${setup.RELEASE_DUE_TICKETS} tickets are waiting`)
  })

  it('ignores archived tickets, and goes through the evaluator into the feed', async () => {
    const { projectId, put } = releaseProject({ key: 'release', name: 'Release' })
    const gone = put('Archived one', 10)
    db.update(schema.tickets)
      .set({ archivedAt: new Date(NOW).toISOString() })
      .where(eq(schema.tickets.id, gone.id))
      .run()
    expect(await check(release(), projectId)).toEqual([])
    put('Waiting', 10)
    const out = await evaluate.evaluateAlerts({ projectId, type: 'release-due', now: () => NOW })
    expect(out.started).toHaveLength(1)
    const items = feed.notificationFeed(projectId, {}, NOW)
    expect(items.find((i) => i.type === 'release-due')).toMatchObject({ title: 'Time to cut a release' })
  })
})

describe('idea 16: an agent token about to expire', () => {
  const token = () => typeOf(types(), 'agent-token-expiring')
  /** A token made `ago` days before NOW: it runs a year from then. */
  const mint = (name: string, ago: number) => tokens.mintAgentToken(name, 'worker', new Date(NOW - ago * DAY))

  it('is silent for a token with more than 14 days left', async () => {
    mint('fresh-agent', 300)
    expect((await check(token())).filter((a) => a.title.includes('fresh-agent'))).toEqual([])
  })

  it('is raised at 14 days or fewer, as a warning, with its date, and a problem once expired', async () => {
    const soon = mint('soon-agent', 365 - 14)
    const gone = mint('gone-agent', 400)
    const found = await check(token())
    const a = found.find((c) => c.subject === String(soon.id))!
    expect(a).toMatchObject({ severity: 'warning', title: 'The token for soon-agent expires in 14 days' })
    expect(a.body).toContain(soon.expiresAt.slice(0, 10))
    const b = found.find((c) => c.subject === String(gone.id))!
    expect(b).toMatchObject({ severity: 'problem', title: 'The token for gone-agent has expired' })
    expect(a.buttons).toContainEqual({
      id: 'generate',
      label: 'Generate new commands',
      kind: 'link',
      href: '/agents',
    })
    expect(token().snoozeOptions).toEqual([7 * DAY])
  })

  it('moves with the clock: one day earlier it is not raised yet', async () => {
    const t = mint('edge-agent', 365 - 14)
    expect((await check(token(), null, NOW - DAY)).some((c) => c.subject === String(t.id))).toBe(false)
    expect((await check(token(), null, NOW)).some((c) => c.subject === String(t.id))).toBe(true)
  })

  it('stops once the agent has a newer token, or the token is revoked', async () => {
    const old = mint('renewed-agent', 360)
    const dying = mint('revoked-agent', 360)
    expect((await check(token())).map((c) => c.subject)).toEqual(
      expect.arrayContaining([String(old.id), String(dying.id)]),
    )
    mint('renewed-agent', 0)
    tokens.revokeAgentToken(dying.id, new Date(NOW))
    const after = (await check(token())).map((c) => c.subject)
    expect(after).not.toContain(String(old.id))
    expect(after).not.toContain(String(dying.id))
  })
})

describe('idea 17: an update stuck in the desktop app', () => {
  it('is raised for a manual step, with a button that copies the command', async () => {
    const t = typeOf(types(), 'desktop-update-stuck')
    fakes.state = desktop({
      status: 'manual',
      newest: { version: '1.3.0', notes: '', notesMarkdown: '', date: null },
      manual: { command: 'sudo dpkg -i /tmp/board.deb', file: '/tmp/board.deb' },
    })
    const [alert] = await check(t)
    expect(alert).toMatchObject({ subject: 'manual', severity: 'warning' })
    expect(alert!.title).toContain('Version 1.3.0')
    expect(alert!.buttons).toContainEqual({
      id: 'copy',
      label: 'Copy command',
      kind: 'copy',
      text: 'sudo dpkg -i /tmp/board.deb',
    })
  })

  it('is raised for a failed check, with the reason and Try again, which checks again and resolves', async () => {
    const t = typeOf(types(), 'desktop-update-stuck')
    fakes.state = desktop({ status: 'error', error: 'could not reach the update server' })
    const [alert] = await check(t)
    expect(alert).toMatchObject({ subject: 'error', title: 'The last update check failed' })
    expect(alert!.body).toBe('could not reach the update server')
    expect(alert!.buttons).toContainEqual({ id: 'retry', label: 'Try again', kind: 'action', primary: true })
    expect(await action(t, 'retry', 'error')).toMatchObject({ resolve: true })
    expect(fakes.calls).toEqual(['check'])
  })

  it('is silent in the other states, on a checkout, and does not apply outside the app', async () => {
    const t = typeOf(types(), 'desktop-update-stuck')
    for (const status of ['idle', 'checking', 'none', 'available', 'downloading', 'installing'] as const) {
      fakes.state = desktop({ status })
      expect(await check(t), status).toEqual([])
    }
    fakes.state = { mode: 'checkout' }
    expect(await check(t)).toEqual([])
    fakes.inside = false
    expect(t.applies!()).toBe(false)
  })
})

describe('idea 18: a repo without the board skills', () => {
  function projectWithRepo(name: string) {
    const projectId = newProject('no skills')
    const repoPath = folder(name)
    db.insert(schema.repos).values({ projectId, name, repoPath, baseBranch: 'main' }).run()
    return {
      projectId,
      repoPath,
      repoId: db.select().from(schema.repos).where(eq(schema.repos.repoPath, repoPath)).get()!.id,
    }
  }
  const t = () => typeOf(types(), 'repo-without-skills')

  it('is raised for a repo with no skill anywhere, per repo, with the install commands and Open', async () => {
    const { projectId, repoPath, repoId } = projectWithRepo('web')
    const [alert] = await check(t(), projectId)
    expect(alert).toMatchObject({
      subject: String(repoId),
      severity: 'warning',
      title: 'web has no board skill',
    })
    const copy = alert!.buttons!.find((b) => b.id === 'copy')!
    expect(copy).toMatchObject({ kind: 'copy' })
    const text = (copy as { text: string }).text
    expect(text).toContain('/api/agent-setup/skill?client=claude')
    expect(text).toContain('/api/agent-setup/session-skill')
    expect(text).toContain(`${repoPath}/.claude`)
    expect(alert!.buttons!.some((b) => b.id === 'open' && b.kind === 'link')).toBe(true)
    expect(t().stickyDismiss).toBe(true)
  })

  it('is silent once the repo has the review skills in its own .claude, or the board skill is there', async () => {
    const withBundle = projectWithRepo('bundle')
    for (const p of agents.reviewBundlePaths())
      write(path.join(withBundle.repoPath, '.claude', ...p.split('/')), 'x')
    expect(await check(t(), withBundle.projectId)).toEqual([])

    const withSkill = projectWithRepo('skill')
    write(path.join(withSkill.repoPath, '.claude', 'skills', 'board', 'SKILL.md'), '# board')
    expect(await check(t(), withSkill.projectId)).toEqual([])
  })

  it('is silent for every repo when the skills are installed on this machine', async () => {
    const { projectId } = projectWithRepo('global')
    expect((await check(t(), projectId)).length).toBe(1)
    await agents.installSkill('opencode', fakes.home)
    expect(await check(t(), projectId)).toEqual([])
    fs.rmSync(agents.skillDir('opencode', fakes.home), { recursive: true })
    expect((await check(t(), projectId)).length).toBe(1)
    await agents.installReviewSkills()
    expect(await check(t(), projectId)).toEqual([])
  })

  it('leaves out a repo whose checkout cannot be read', async () => {
    const projectId = newProject('gone repo')
    db.insert(schema.repos)
      .values({ projectId, name: 'gone', repoPath: path.join(tmp, 'does-not-exist'), baseBranch: 'main' })
      .run()
    expect(await check(t(), projectId)).toEqual([])
  })
})

describe('idea 19: a host tool is missing or broken', () => {
  const tool = () => typeOf(types(), 'host-tool-broken')

  it('is silent while git, node and pnpm run, and says nothing before the first check', async () => {
    expect(await check(tool())).toEqual([])
    fakes.tools = toolsWith({})
    expect(await check(tool())).toEqual([])
  })

  it('raises a problem for a missing tool with what it breaks and the fix, and a Check again button', async () => {
    fakes.tools = toolsWith({ pnpm: { path: null } })
    const [alert] = await check(tool())
    expect(alert).toMatchObject({
      subject: 'pnpm',
      severity: 'problem',
      title: "pnpm was not found on the board's PATH",
      body: 'This breaks managed previews.',
    })
    expect(alert!.details![0]).toContain('corepack enable pnpm')
    expect(alert!.buttons).toEqual([
      { id: 'check-again', label: 'Check again', kind: 'action', primary: true },
    ])
  })

  it('raises one for a tool that does not run, and one that is older than the board needs', async () => {
    fakes.tools = toolsWith({
      git: { path: '/usr/bin/git', version: null },
      node: { path: '/usr/bin/node', version: '22.4.1' },
      pnpm: { path: '/usr/bin/pnpm', version: '11.0.0' },
    })
    const found = await check(tool())
    expect(found.map((c) => c.subject)).toEqual(['git', 'node'])
    expect(found[0]!.title).toContain('did not run')
    expect(found[1]!.title).toBe('node 22.4.1 is older than the 24 the board needs')
    // Newer is fine.
    fakes.tools = toolsWith({ node: { path: '/usr/bin/node', version: '24.0.0' } })
    expect(await check(tool())).toEqual([])
  })

  it('does not cover claude or gh', async () => {
    fakes.tools = toolsWith({ claude: { path: null }, gh: { path: null } })
    expect(await check(tool())).toEqual([])
  })

  it('compares dotted versions part by part', () => {
    expect(setup.compareVersions('2.9.1', '2.25')).toBeLessThan(0)
    expect(setup.compareVersions('24', '24.0.0')).toBe(0)
    expect(setup.compareVersions('11.1.2', '11')).toBeGreaterThan(0)
  })

  it('Check again runs the check, resolves the alert when the tool works now, and says so when it does not', async () => {
    fakes.tools = toolsWith({ pnpm: { path: null } })
    fakes.checked = toolsWith({})
    expect(await action(tool(), 'check-again', 'pnpm')).toEqual({ message: 'Working now', resolve: true })
    fakes.checked = toolsWith({ pnpm: { path: null } })
    expect(await action(tool(), 'check-again', 'pnpm')).toEqual({
      message: 'Still not working',
      resolve: false,
    })
    expect(fakes.calls).toEqual(['tools', 'tools'])
  })
})
