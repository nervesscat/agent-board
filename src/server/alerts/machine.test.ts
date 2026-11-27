import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileStore } from '../storage'
import type { PreviewRunner, Proc } from '../managedPreview'
import type { AlertCandidate, AlertContext, AlertType } from './registry'

// The alerts live in SQLite: point the db at a throwaway directory before anything loads it. Test mode, as
// the other alert tests run; claude is the tests' stand-in (e2e/fake-claude.mjs), run through node.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-machine-alerts-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'
process.env.HOME = path.join(tmp, 'home')
process.env.USERPROFILE = path.join(tmp, 'home')
process.env.CLAUDE_HOME = path.join(tmp, 'home', '.claude')
fs.mkdirSync(process.env.HOME, { recursive: true })
process.env.CLAUDE_BIN = process.execPath
process.env.CLAUDE_ARGS = JSON.stringify([
  fileURLToPath(new URL('../../../e2e/fake-claude.mjs', import.meta.url)),
])

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// gh is the edge of the PR refresh: it answers with what `ghFails` holds, an error, or finds nothing.
let ghFails: string | null = null
vi.mock('../git', async (original) => ({
  ...(await original<typeof import('../git')>()),
  listMyPrs: async () => {
    if (ghFails) throw new Error(ghFails)
    return []
  },
  currentGithubLogin: async () => 'enrique',
  prStateOf: async () => null,
}))

let db: typeof import('#/db').db
let schema: typeof import('#/db').schema
let projects: typeof import('../projects')
let features: typeof import('../features')
let machine: typeof import('./machine')
let registry: typeof import('./registry')
let evaluate: typeof import('./evaluate')
let actions: typeof import('./actions')
let hostTools: typeof import('../hostTools')
let mp: typeof import('../managedPreview')
let prs: typeof import('../prs')
let reports: typeof import('../reports')
let gen: typeof import('../reportGenerate')
let stages: typeof import('../stages')
let storage: typeof import('../storage')
let config: typeof import('../config').config
let originalEdges: typeof import('./machine').edges
let previewProject: number

// --- a repo on disk: the main checkout and worktrees next to it ---

const repos = path.join(tmp, 'code')
const main = path.join(repos, 'agent-board')
const LOCK = "lockfileVersion: '9.0'\n"

let worktrees = 0
function freshWorktree() {
  const dir = path.join(repos, `agent-board-wt${++worktrees}`)
  fs.mkdirSync(path.join(dir, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(main, '.git', 'worktrees', path.basename(dir))}\n`,
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), LOCK)
  fs.writeFileSync(path.join(dir, 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
  return dir
}

// --- the fake runner: the processes are promises the test controls ---

class FakeRunner implements PreviewRunner {
  killed: number[] = []
  up = new Set<string>()
  private exits = new Map<number, (code: number | null) => void>()
  private urls = new Map<number, string>()
  private pid = 5000

  spawn(
    command: string,
    _args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    fs.appendFileSync(opts.log, `${command} line\n`)
    const exited = new Promise<number | null>((resolve) => this.exits.set(pid, resolve))
    if (opts.shell) setTimeout(() => this.exits.get(pid)!(0), 0)
    else {
      const url = `http://127.0.0.1:${opts.env.PORT}`
      this.up.add(url)
      this.urls.set(pid, url)
    }
    return { pid, exited }
  }
  async killTree(pid: number) {
    this.killTreeSync(pid)
  }
  killTreeSync(pid: number) {
    this.killed.push(pid)
    const url = this.urls.get(pid)
    if (url) this.up.delete(url)
    this.exits.get(pid)?.(null)
  }
  async isFree() {
    return true
  }
  async listening(port: number) {
    return [`127.0.0.1:${port}`]
  }
  async answers(url: string) {
    return this.up.has(url)
  }
  async copyData(dest: string) {
    fs.mkdirSync(dest, { recursive: true })
  }
}

beforeAll(async () => {
  fs.mkdirSync(path.join(main, '.git'), { recursive: true })
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  ;({ db, schema } = await import('#/db'))
  projects = await import('../projects')
  features = await import('../features')
  machine = await import('./machine')
  registry = await import('./registry')
  evaluate = await import('./evaluate')
  actions = await import('./actions')
  hostTools = await import('../hostTools')
  mp = await import('../managedPreview')
  prs = await import('../prs')
  reports = await import('../reports')
  gen = await import('../reportGenerate')
  stages = await import('../stages')
  storage = await import('../storage')
  config = (await import('../config')).config
  originalEdges = { ...machine.edges }
}, 60_000)

// Each test has a project of its own, with the checkout's repo, so what an earlier test left stopped is not its.
beforeEach(() => {
  previewProject = projects.createProject({ name: 'previews' }, 'human').id
  db.insert(schema.repos)
    .values({
      projectId: previewProject,
      name: 'agent-board',
      repoPath: main,
      githubRepo: 'acme/agent-board',
    })
    .run()
})

afterEach(async () => {
  Object.assign(machine.edges, originalEdges)
  machine.resetMachineState()
  hostTools.setHostTools(null)
  ghFails = null
  // A refresh that works clears what an earlier one recorded.
  for (const f of prs.prRefreshFailures()) await prs.refreshPrs(f.projectId)
  for (const p of mp.activePreviews()) await mp.stopPreview(p.workspaceId, 'test over', 'test')
  mp.setPreviewRunner(null)
  db.delete(schema.settings).run()
  db.delete(schema.sessions).run()
  db.delete(schema.passkeys).run()
  db.delete(schema.alerts).run()
})

// --- helpers ---

const typeOf = (id: string): AlertType => {
  const found = machine.alertTypes.find((t) => t.type === id)
  if (!found) throw new Error(`no machine alert type ${id}`)
  return found
}

let count = 0

/** The check's context, the clock `offset` after now. */
function ctxOf(projectId: number | null, offset = 0): AlertContext {
  const at = Date.now() + offset
  return {
    projectId,
    now: () => at,
    projects: { list: () => projects.listProjects(), get: (id) => projects.getProject(id) },
  }
}

const check = async (type: string, projectId: number | null = null, offset = 0): Promise<AlertCandidate[]> =>
  typeOf(type).check(ctxOf(projectId, offset))

const subjects = (found: AlertCandidate[]) => found.map((c) => c.subject ?? '')

/** Runs the type's check through the evaluator and answers its open alert rows. */
async function raise(type: string, projectId: number | null = null, offset = 0) {
  await evaluate.evaluateAlerts({
    type,
    ...(projectId !== null && { projectId }),
    now: () => Date.now() + offset,
  })
  return db
    .select()
    .from(schema.alerts)
    .where(and(eq(schema.alerts.type, type), isNull(schema.alerts.resolvedAt)))
    .all()
}

/** The human presses a button of an alert. */
const press = (alertId: number, buttonId: string, offset = 0) =>
  actions.runAlertAction({ agent: false }, alertId, buttonId, () => Date.now() + offset)

const tools = (probes: Parameters<typeof hostTools.hostToolsWith>[0] = {}) =>
  hostTools.setHostTools(hostTools.hostToolsWith(probes))

const newProject = () => projects.createProject({ name: `machine ${++count}` }, 'human').id

/** A ticket of the previews project with a workspace on a fresh worktree. */
function ticketWithWorktree(status = 'in_progress') {
  const t = features.createTicket(previewProject, { title: `preview me ${++count}`, status }, 'claude')
  const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat', path: freshWorktree() }, 'claude')
  return { t, ws }
}

const status = (workspaceId: number) => mp.managedPreview(workspaceId)?.status

async function startRunning(workspaceId: number) {
  mp.startPreview(workspaceId, 'claude')
  await vi.waitFor(() => expect(status(workspaceId)).toBe('running'))
}

const setLimit = (n: number) =>
  db
    .insert(schema.settings)
    .values({ key: 'previewLimit', value: n })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: n } })
    .run()

const remoteHost = 'box.tail.ts.net'
const entrance = { origin: `https://${remoteHost}`, host: remoteHost }

describe('the machine alert types', () => {
  it('are registered, once each, in the machine group, for the ideas of the lane', () => {
    const ids = machine.alertTypes.map((t) => t.type)
    expect(new Set(ids).size).toBe(ids.length)
    expect(machine.alertTypes.map((t) => t.idea).sort((a, b) => a - b)).toEqual([
      4, 5, 10, 11, 12, 13, 21, 22, 23, 32, 34,
    ])
    for (const t of machine.alertTypes) {
      expect(t.group).toBe('machine')
      expect(registry.findAlertType(t.type)).toBe(t)
    }
    const projectScoped = machine.alertTypes.filter((t) => t.scope === 'project').map((t) => t.idea)
    expect(projectScoped.sort((a, b) => a - b)).toEqual([10, 12, 32])
  })
})

describe('4 agent login or CLI problem', () => {
  it('is raised when the claude CLI is missing, and not when it was found', async () => {
    tools({ claude: { path: null } })
    const [found] = await check('agent-login')
    expect(found).toMatchObject({
      subject: 'cli',
      // The board can do without claude: info, as the host-tools check says.
      severity: 'info',
      title: expect.stringMatching(/not found/),
    })
    expect(found!.buttons).toEqual([{ id: 'check', label: 'Check again', kind: 'action', primary: true }])
    tools()
    expect(await check('agent-login')).toEqual([])
    hostTools.setHostTools(null)
    expect(await check('agent-login')).toEqual([])
  })

  it('is raised when the claude CLI is older than the board takes', async () => {
    tools({ claude: { path: '/usr/bin/claude', version: '0.2.5' } })
    const [found] = await check('agent-login')
    expect(found).toMatchObject({ subject: 'cli', title: expect.stringMatching(/too old \(0\.2\.5\)/) })
    tools({ claude: { path: '/usr/bin/claude', version: machine.CLAUDE_MIN_VERSION } })
    expect(await check('agent-login')).toEqual([])
    expect(machine.versionBelow('1.10.0', '1.9.0')).toBe(false)
    expect(machine.versionBelow('1.9', '1.9.1')).toBe(true)
  })

  /** A project whose reports are on, with a day of activity, and the prompt that steers the stand-in. */
  function reportingProject(mode: string) {
    const p = newProject()
    reports.setReportSettings(
      p,
      { cadence: 'daily', prompt: `Short bullets.\n[fake-claude: ${mode}]` },
      'enrique',
      {},
    )
    db.insert(schema.activity)
      .values({ projectId: p, actor: 'enrique', kind: 'ticket', text: 'did a thing' })
      .run()
    return p
  }

  it('is raised when a report failed because claude was refused its login, and clears when one succeeds', async () => {
    const script = path.join(tmp, 'claude-logged-out.mjs')
    fs.writeFileSync(
      script,
      "process.stdin.resume(); process.stderr.write('Invalid API key. Please run /login'); process.exit(1)\n",
    )
    const p = reportingProject('good')
    const fakeArgs = config.claudeArgs
    config.claudeArgs = [script]
    try {
      await expect(gen.generateReport(p)).rejects.toThrow(/Please run \/login/)
    } finally {
      config.claudeArgs = fakeArgs
    }
    const [found] = await check('agent-login')
    expect(found).toMatchObject({ subject: 'login', severity: 'problem' })
    expect(found!.details).toEqual([expect.stringMatching(/Invalid API key/)])
    expect(found!.details![0]).toContain(projects.getProject(p).name)

    // The stand-in signs in: the next report is written, and the alert goes.
    await gen.generateReport(p)
    expect(await check('agent-login')).toEqual([])
  })

  it.each([
    ['Invalid API key. Please run /login', true],
    ['invalid key', true],
    ['Please run /login to continue', true],
    ['Error: Not logged in', true],
    ['not authenticated', true],
    ['Authentication failed', true],
    ['Authentication required', true],
    ['API Error: 401 Unauthorized', true],
    ['Login required', true],
    ['Credit balance is too low', false],
    ['OAuth token has expired', false],
    ['token expired', false],
    ['oauth', false],
    ['rate limit reached', false],
    ['connection reset', false],
  ])('reads %j as a sign-in problem: %s', (text, expected) => {
    expect(machine.needsLogin(text)).toBe(expected)
  })

  it('is the only alert for a refused login or a missing claude: the report-failed alert leaves them to it', async () => {
    const housekeeping = await import('./housekeeping')
    const script = path.join(tmp, 'claude-logged-out-2.mjs')
    fs.writeFileSync(
      script,
      "process.stdin.resume(); process.stderr.write('Invalid API key. Please run /login'); process.exit(1)\n",
    )
    const refused = reportingProject('good')
    const other = reportingProject('fail')
    const fakeArgs = config.claudeArgs
    config.claudeArgs = [script]
    try {
      await expect(gen.generateReport(refused)).rejects.toThrow()
    } finally {
      config.claudeArgs = fakeArgs
    }
    await expect(gen.generateReport(other)).rejects.toThrow()
    expect(housekeeping.checkReportFailed(ctxOf(refused))).toEqual([])
    expect(subjects(await check('agent-login'))).toEqual(['login'])
    // Any other failure is the report's own, and the report alert says it.
    expect(housekeeping.checkReportFailed(ctxOf(other))).toHaveLength(1)
    // With the last tools check finding claude missing, the machine alert says that too.
    tools({ claude: { path: null } })
    expect(housekeeping.checkReportFailed(ctxOf(other))).toEqual([])
    expect(subjects(await check('agent-login'))).toEqual(['cli', 'login'])
    // Signed in again: what the generation state kept is gone, for the tests after this one.
    await gen.generateReport(refused)
  })

  it('is not raised for a report that failed for another reason', async () => {
    const p = reportingProject('fail')
    await expect(gen.generateReport(p)).rejects.toThrow(/asked to fail/)
    expect(gen.generationState(p).error).not.toBeNull()
    expect(await check('agent-login')).toEqual([])
  })

  it('Check again looks at the tools again and resolves the alert when claude is found', async () => {
    tools({ claude: { path: null } })
    const [row] = await raise('agent-login')
    machine.edges.recheckTools = async () =>
      hostTools.setHostTools(hostTools.hostToolsWith({ claude: { path: null } }))
    expect(await press(row!.id, 'check')).toMatchObject({
      resolved: false,
      message: expect.stringMatching(/^Still failing/),
    })
    machine.edges.recheckTools = async () => hostTools.setHostTools(hostTools.hostToolsWith({}))
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: true })
  })
  /** A project whose last report was refused for want of a sign-in. */
  async function refusedLogin() {
    const script = path.join(tmp, `claude-refused-${++count}.mjs`)
    fs.writeFileSync(
      script,
      "process.stdin.resume(); process.stderr.write('Invalid API key. Please run /login'); process.exit(1)\n",
    )
    const p = reportingProject('good')
    const fakeArgs = config.claudeArgs
    config.claudeArgs = [script]
    try {
      await expect(gen.generateReport(p)).rejects.toThrow(/Please run \/login/)
    } finally {
      config.claudeArgs = fakeArgs
    }
    expect(await check('agent-login')).toMatchObject([{ subject: 'login' }])
    return p
  }

  it('ends when the report of the failed period is written by hand', async () => {
    const p = await refusedLogin()
    const { period } = gen.generationState(p).error!
    await reports.postReport(p, { period, body: 'Written by hand' }, 'enrique')
    expect(await check('agent-login')).toEqual([])
  })

  it('ends when reports are switched off for the project', async () => {
    const p = await refusedLogin()
    reports.setReportSettings(p, { cadence: 'off' }, 'enrique')
    expect(await check('agent-login')).toEqual([])
  })

  it('has a Check again that stays honest: it fails while the login failure stands and resolves when it ends', async () => {
    machine.edges.recheckTools = async () => hostTools.setHostTools(hostTools.hostToolsWith({}))
    const p = await refusedLogin()
    const [row] = await raise('agent-login')
    expect(row!.subject).toBe('login')
    expect(JSON.parse(row!.buttons).map((b: { id: string }) => b.id)).toEqual(['check', 'reports'])
    // The tools are fine and the check ran again, but nothing says claude signed in.
    expect(await press(row!.id, 'check')).toMatchObject({
      ok: false,
      resolved: false,
      message: expect.stringMatching(/^Still failing: .*sign-in/),
    })
    const { period } = gen.generationState(p).error!
    await reports.postReport(p, { period, body: 'Written by hand' }, 'enrique')
    expect(await press(row!.id, 'check')).toMatchObject({ ok: true, resolved: true })
  })

  it('leaves a report that failed for another reason to the report alert, whose description says so', async () => {
    const housekeeping = await import('./housekeeping')
    const type = housekeeping.alertTypes.find((t) => t.type === 'report-generation-failed')!
    expect(type.description).toBe(
      'claude could not write the report: it timed out, did not fill the template or failed otherwise',
    )
    expect(type.description).not.toMatch(/signed in|installed/)
  })
})

describe('5 GitHub access', () => {
  it('is raised when gh is signed out, and not when it is signed in or not known', async () => {
    tools({
      gh: {
        path: '/usr/bin/gh',
        version: '2.50.0',
        signedIn: false,
        authOutput: 'You are not logged into any GitHub hosts',
      },
    })
    const [found] = await check('github-access')
    expect(found).toMatchObject({ subject: 'gh-signed-out', severity: 'problem' })
    tools({ gh: { path: '/usr/bin/gh', version: '2.50.0', signedIn: null } })
    expect(await check('github-access')).toEqual([])
    tools()
    expect(await check('github-access')).toEqual([])
  })

  it('is raised when gh was not found', async () => {
    tools({ gh: { path: null } })
    expect(subjects(await check('github-access'))).toEqual(['gh-missing'])
  })

  it('is raised when the PR queue could not refresh for want of a login, and clears when it refreshes', async () => {
    ghFails = 'HTTP 401: Bad credentials (https://api.github.com/graphql)'
    await expect(prs.refreshPrs(previewProject)).rejects.toThrow(/Bad credentials/)
    const [found] = await check('github-access')
    expect(found).toMatchObject({ subject: 'refresh', severity: 'problem' })
    expect(found!.details).toEqual([expect.stringContaining('Bad credentials')])
    ghFails = null
    await prs.refreshPrs(previewProject)
    expect(await check('github-access')).toEqual([])
  })

  it('is not raised for a refresh that failed for another reason', async () => {
    ghFails = 'gh pr list failed in /somewhere'
    await expect(prs.refreshPrs(previewProject)).rejects.toThrow(/gh pr list failed/)
    expect(await check('github-access')).toEqual([])
  })

  it('does not read a rate limit (403) as a login problem', async () => {
    ghFails = 'HTTP 403: API rate limit exceeded'
    await expect(prs.refreshPrs(previewProject)).rejects.toThrow(/rate limit/)
    expect(await check('github-access')).toEqual([])
    ghFails = 'HTTP 403: Forbidden, the token lacks the repo scope'
    await expect(prs.refreshPrs(previewProject)).rejects.toThrow(/scope/)
    expect(await check('github-access')).toHaveLength(1)
  })

  it('Check again refreshes the failed project, and resolves once gh works again', async () => {
    ghFails = 'HTTP 401: Bad credentials'
    await expect(prs.refreshPrs(previewProject)).rejects.toThrow()
    const [row] = await raise('github-access')
    expect(row!.subject).toBe('refresh')
    // The tools check is its own edge here: this machine's gh is not the one under test.
    machine.edges.recheckTools = async () => {}
    // Still failing: the refresh runs again, fails again, the alert stays.
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: false })
    // gh is signed in again; nothing refreshes the project but the button.
    ghFails = null
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: true })
    expect(prs.prRefreshFailures()).toEqual([])
  })

  it('forgets the failure of a project that was deleted', async () => {
    const doomed = projects.createProject({ name: `doomed ${++count}` }, 'human').id
    db.insert(schema.repos)
      .values({ projectId: doomed, name: 'app', repoPath: main, githubRepo: 'acme/app' })
      .run()
    ghFails = 'HTTP 401: Bad credentials'
    await expect(prs.refreshPrs(doomed)).rejects.toThrow()
    expect(await check('github-access')).toHaveLength(1)
    projects.deleteProject(doomed, 'enrique')
    expect(prs.prRefreshFailures().map((f) => f.projectId)).not.toContain(doomed)
    expect(await check('github-access')).toEqual([])
  })

  it('Check again runs the tools check and resolves the alert once gh is signed in', async () => {
    tools({
      gh: {
        path: '/usr/bin/gh',
        version: '2.50.0',
        signedIn: false,
        authOutput: 'not logged into any GitHub hosts',
      },
    })
    const [row] = await raise('github-access')
    expect(row!.subject).toBe('gh-signed-out')
    let rechecked = 0
    machine.edges.recheckTools = async () => {
      rechecked++
    }
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: false })
    machine.edges.recheckTools = async () => {
      rechecked++
      hostTools.setHostTools(hostTools.hostToolsWith({}))
    }
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: true })
    expect(rechecked).toBe(2)
  })
})

describe('10 leftover processes', () => {
  it('is raised for a preview whose ticket went silent, and not while its agent is working', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const { t, ws } = ticketWithWorktree()
    await startRunning(ws.id)
    // Five minutes in, the ticket's lease is live: someone is behind the preview.
    expect(await check('leftover-process', previewProject, 5 * MIN)).toEqual([])
    const [found] = await check('leftover-process', previewProject, 2 * HOUR)
    expect(found).toMatchObject({ severity: 'warning', title: expect.stringContaining(`#${t.id}`) })
    expect(found!.subject).toBe(`run:${ws.id}:${mp.previewRunOf(ws.id)!.id}`)
    expect(found!.buttons!.map((b) => b.id)).toEqual(['stop', 'ticket'])
    // Another project does not show it.
    expect(await check('leftover-process', newProject(), 2 * HOUR)).toEqual([])
  })

  it('is raised for a preview still running on a closed or archived ticket', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const closed = ticketWithWorktree()
    const archived = ticketWithWorktree()
    await startRunning(closed.ws.id)
    await startRunning(archived.ws.id)
    expect(await check('leftover-process', previewProject)).toEqual([])
    // The rows say what the board would have acted on; the runs were left behind.
    const done = stages.listStages(previewProject).find((s) => s.kind === 'done')!.key
    db.update(schema.tickets).set({ status: done }).where(eq(schema.tickets.id, closed.t.id)).run()
    db.update(schema.tickets)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.tickets.id, archived.t.id))
      .run()
    const found = await check('leftover-process', previewProject)
    expect(found.map((c) => c.body)).toEqual([
      expect.stringContaining('its ticket is closed'),
      expect.stringContaining('its ticket is archived'),
    ])
  })

  it('is not raised for a preview that is stopped', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const { ws } = ticketWithWorktree()
    await startRunning(ws.id)
    await mp.stopPreview(ws.id, 'done', 'claude')
    expect(await check('leftover-process', previewProject, 2 * HOUR)).toEqual([])
  })

  it('Stop it stops the run through the board, and kills its process', async () => {
    const runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const { ws } = ticketWithWorktree()
    await startRunning(ws.id)
    const pid = mp.managedPreview(ws.id)!.pid!
    const [row] = await raise('leftover-process', previewProject, 2 * HOUR)
    expect(await press(row!.id, 'stop', 2 * HOUR)).toMatchObject({ resolved: true })
    expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'stopped', reason: 'stopped from an alert' })
    expect(runner.killed).toContain(pid)
    // Its alert goes with it.
    expect(await check('leftover-process', previewProject, 2 * HOUR)).toEqual([])
  })
})

describe('11 resources', () => {
  const GB = 1024 ** 3

  it('is raised for a disk below a tenth free or below 2 GB free, a problem when nearly full', async () => {
    const disk = (free: number, total: number) => (machine.edges.disk = () => ({ free, total }))
    disk(500 * GB, 1000 * GB)
    expect(await check('machine-resources')).toEqual([])
    // Plenty of space in all, but a tenth: running low, not almost full.
    disk(80 * GB, 1000 * GB)
    expect(await check('machine-resources')).toMatchObject([
      { subject: 'disk', severity: 'warning', title: 'The disk is running low: 80.0 GB free' },
    ])
    disk(1.5 * GB, 10 * GB)
    expect(await check('machine-resources')).toMatchObject([
      { subject: 'disk', severity: 'warning', title: 'The disk is almost full: 1.5 GB free' },
    ])
    disk(40 * GB, 1000 * GB)
    expect(await check('machine-resources')).toMatchObject([
      { title: 'The disk is almost full: 40.0 GB free' },
    ])
    disk(20 * GB, 1000 * GB)
    expect(await check('machine-resources')).toMatchObject([{ subject: 'disk', severity: 'problem' }])
    machine.edges.disk = () => null
    expect(await check('machine-resources')).toEqual([])
  })

  it('has no button tied to one project: the alert shows in every project, so a link would be wrong in all but one', async () => {
    machine.edges.disk = () => ({ free: GB, total: 100 * GB })
    const [found] = await check('machine-resources')
    expect(found!.buttons ?? []).toEqual([])
    expect(JSON.stringify(found)).not.toMatch(/\/projects\//)
    expect(found!.details).toEqual([expect.stringContaining('Data folder:')])
  })

  it('is raised for a load that stays high over several checks, and not for one spike', async () => {
    let load = 8
    machine.edges.load = () => ({ load, cores: 4 })
    machine.edges.memory = () => ({ free: 8 * GB, total: 16 * GB })
    const at = (n: number) => check('machine-resources', null, n * MIN)
    expect(await at(0)).toEqual([])
    expect(await at(1)).toEqual([])
    // The third strained check in a row.
    expect(await at(2)).toMatchObject([{ subject: 'load', severity: 'warning' }])
    // A calm check breaks the run: the next strained ones start counting again.
    load = 1
    expect(await at(3)).toEqual([])
    load = 8
    expect(await at(4)).toEqual([])
    expect(await at(5)).toEqual([])
    expect(await at(6)).toMatchObject([{ subject: 'load' }])
  })

  it('counts a check about every half minute, and a long gap starts over', async () => {
    machine.edges.load = () => ({ load: 8, cores: 4 })
    machine.edges.memory = () => ({ free: 8 * GB, total: 16 * GB })
    // Checks a second apart are one sample, however often the evaluator runs.
    for (let s = 0; s < 5; s++) expect(await check('machine-resources', null, s * 1000)).toEqual([])
    expect(await check('machine-resources', null, 40_000)).toEqual([])
    expect(await check('machine-resources', null, 80_000)).toMatchObject([{ subject: 'load' }])
    // An hour later the run is broken: one strained check is not sustained.
    expect(await check('machine-resources', null, HOUR)).toEqual([])
  })

  it('is raised for memory that stays short over several checks', async () => {
    machine.edges.load = () => ({ load: 0.5, cores: 4 })
    let free = 0.5 * GB
    machine.edges.memory = () => ({ free, total: 16 * GB })
    const at = (n: number) => check('machine-resources', null, n * MIN)
    expect(await at(0)).toEqual([])
    expect(await at(1)).toEqual([])
    expect(await at(2)).toMatchObject([{ subject: 'memory', severity: 'warning' }])
    free = 8 * GB
    expect(await at(3)).toEqual([])
  })

  it('reads this machine by default', () => {
    const real = originalEdges
    expect(real.disk()!.total).toBeGreaterThan(0)
    expect(real.load().cores).toBeGreaterThan(0)
    expect(real.memory().total).toBeGreaterThan(0)
  })
})

describe('12 preview stopped by a restart', () => {
  it('is raised for a preview the board restart stopped while its ticket is in review', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const { t, ws } = ticketWithWorktree('review')
    await startRunning(ws.id)
    expect(await check('preview-restarted', previewProject)).toEqual([])
    // The board goes down: every run goes with it, and its reason says so.
    mp.stopAllPreviews()
    expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'stopped', reason: mp.RESTARTED })
    const [found] = await check('preview-restarted', previewProject)
    expect(found).toMatchObject({ severity: 'info', title: expect.stringContaining(`#${t.id}`) })
    expect(found!.buttons!.map((b) => b.id)).toEqual(['restart', 'ticket'])
    expect(await check('preview-restarted', newProject())).toEqual([])
  })

  it('is not raised when the ticket is not in review, or the preview was stopped by hand', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const working = ticketWithWorktree('in_progress')
    const reviewed = ticketWithWorktree('review')
    await startRunning(working.ws.id)
    await startRunning(reviewed.ws.id)
    await mp.stopPreview(reviewed.ws.id, 'stopped by the human', 'enrique')
    mp.stopAllPreviews()
    expect(await check('preview-restarted', previewProject)).toEqual([])
  })

  it('Restart starts the preview again through the board', async () => {
    mp.setPreviewRunner(new FakeRunner())
    const { ws } = ticketWithWorktree('review')
    await startRunning(ws.id)
    mp.stopAllPreviews()
    const [row] = await raise('preview-restarted', previewProject)
    expect(await press(row!.id, 'restart')).toMatchObject({ resolved: true })
    await vi.waitFor(() => expect(status(ws.id)).toBe('running'))
    expect(await check('preview-restarted', previewProject)).toEqual([])
  })
})

describe('13 a migration applied', () => {
  // The test process's own boot applied every migration; each test says which ones this boot applied.
  beforeEach(() => {
    machine.edges.migrationsAtBoot = () => []
  })

  it('is raised for the migrations applied since the marker, named by the journal', async () => {
    const applied = machine.edges.migrations()
    expect(applied.length).toBeGreaterThan(2)
    // The first look only notes where the board stands.
    expect(await check('migration-applied')).toEqual([])
    const marker = () =>
      db.select().from(schema.settings).where(eq(schema.settings.key, 'alertMigrationsSeen')).get()?.value
    expect(marker()).toEqual({ at: applied.at(-1)!.at, announced: applied.map((m) => m.at) })
    expect(await check('migration-applied')).toEqual([])

    // The marker from before the last two migrations: they are what changed.
    db.update(schema.settings)
      .set({ value: { at: applied.at(-3)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    const [found] = await check('migration-applied')
    const last = applied.slice(-2).map((m) => m.name)
    expect(found).toMatchObject({
      subject: `migrated:${applied.at(-1)!.at}`,
      severity: 'info',
      title: 'The board applied 2 database migrations when it started',
      details: last,
    })
    expect(last.every((n) => /^\d{4}_/.test(n))).toBe(true)
  })

  it('Got it marks them seen, and a migration applied later is a new alert', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    db.update(schema.settings)
      .set({ value: { at: applied.at(-2)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    const [row] = await raise('migration-applied')
    expect(await press(row!.id, 'seen')).toMatchObject({ resolved: true })
    expect(await check('migration-applied')).toEqual([])

    const newer = { at: applied.at(-1)!.at + 1000, name: '0099_something_new' }
    machine.edges.migrations = () => [...applied, newer]
    expect(await check('migration-applied')).toMatchObject([
      { subject: `migrated:${newer.at}`, details: ['0099_something_new'] },
    ])
  })

  it('announces a migration applied late, with a when older than the marker', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    const late = { at: applied[0]!.at - 1000, name: '0000_late_merge' }
    machine.edges.migrations = () => [late, ...applied]
    expect(await check('migration-applied')).toMatchObject([
      { subject: `migrated:${applied.at(-1)!.at}`, details: [late.name] },
    ])
  })

  it('an old marker row with only at raises nothing it covers', async () => {
    const applied = machine.edges.migrations()
    db.insert(schema.settings)
      .values({ key: 'alertMigrationsSeen', value: { at: applied.at(-1)!.at } })
      .run()
    expect(await check('migration-applied')).toEqual([])
    db.update(schema.settings)
      .set({ value: { at: applied.at(-3)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    expect(await check('migration-applied')).toMatchObject([
      { details: applied.slice(-2).map((m) => m.name) },
    ])
  })

  it('Got it on a late migration marks it announced, so it is not raised again', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    const late = { at: applied[0]!.at - 1000, name: '0000_late_merge' }
    machine.edges.migrations = () => [late, ...applied]
    const [row] = await raise('migration-applied')
    expect(await press(row!.id, 'seen')).toMatchObject({ resolved: true })
    expect(await check('migration-applied')).toEqual([])
  })

  it('a legacy marker still announces a migration this boot applied late', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    db.update(schema.settings)
      .set({ value: { at: applied.at(-1)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    // The oldest one was applied by this boot, with a `when` older than the marker.
    machine.edges.migrationsAtBoot = () => [applied[0]!.at]
    expect(await check('migration-applied')).toMatchObject([{ details: [applied[0]!.name] }])
  })

  it('a legacy marker does not announce an older migration this boot did not apply', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    db.update(schema.settings)
      .set({ value: { at: applied.at(-1)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    const late = { at: applied[0]!.at - 1000, name: '0000_late_merge' }
    machine.edges.migrations = () => [late, ...applied]
    expect(await check('migration-applied')).toEqual([])
  })

  it('Got it on a migration this boot applied late, under a legacy marker, is not raised again', async () => {
    const applied = machine.edges.migrations()
    await check('migration-applied')
    db.update(schema.settings)
      .set({ value: { at: applied.at(-1)!.at } })
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .run()
    machine.edges.migrationsAtBoot = () => [applied[0]!.at]
    const [row] = await raise('migration-applied')
    expect(row).toMatchObject({ subject: `migrated:${applied.at(-1)!.at}` })
    expect(await press(row!.id, 'seen')).toMatchObject({ resolved: true })
    // The marker is in the new format now: the boot's list no longer raises what it marked seen.
    const marker = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, 'alertMigrationsSeen'))
      .get()
    expect(marker?.value).toEqual({ at: applied.at(-1)!.at, announced: applied.map((m) => m.at) })
    expect(await check('migration-applied')).toEqual([])
  })

  it('says nothing of a backup: the board makes none', () => {
    expect(typeOf('migration-applied').description).not.toMatch(/backup/i)
  })
})

describe('21 only one passkey', () => {
  let keys = 0
  const passkey = (over: Partial<typeof schema.passkeys.$inferInsert> = {}) =>
    db
      .insert(schema.passkeys)
      .values({
        credentialId: `cred-${++keys}`,
        publicKey: 'key',
        rpId: 'localhost',
        name: `Device ${keys}`,
        ...over,
      })
      .returning()
      .get()

  it('is raised for exactly one passkey, and not for none or two', async () => {
    expect(await check('one-passkey')).toEqual([])
    const only = passkey({ name: 'Work laptop' })
    const [found] = await check('one-passkey')
    expect(found).toMatchObject({ severity: 'info', title: 'You have only one passkey' })
    expect(found!.body).toContain('Work laptop')
    expect(found!.buttons).toEqual([
      { id: 'add', label: 'Add a passkey', kind: 'link', href: '/settings#devices' },
    ])
    passkey()
    expect(await check('one-passkey')).toEqual([])
    db.delete(schema.passkeys).where(eq(schema.passkeys.id, only.id)).run()
    expect(await check('one-passkey')).toHaveLength(1)
  })

  it('is a warning on a board reached from other devices', async () => {
    passkey()
    machine.edges.entrance = () => entrance
    expect(await check('one-passkey')).toMatchObject([{ severity: 'warning' }])
  })

  it('snoozes for 30 days and a dismissal is kept when the alert comes back', async () => {
    const type = typeOf('one-passkey')
    expect(type.snoozeOptions).toEqual([30 * DAY])
    expect(type.stickyDismiss).toBe(true)
    passkey()
    const [row] = await raise('one-passkey')
    actions.dismissAlert({ agent: false }, row!.id)
    const second = passkey()
    expect(await raise('one-passkey')).toEqual([])
    db.delete(schema.passkeys).where(eq(schema.passkeys.id, second.id)).run()
    const [back] = await raise('one-passkey')
    expect(back!.id).toBe(row!.id)
    expect(back!.dismissedAt).not.toBeNull()
  })
})

describe('22 sign-in from a new device', () => {
  let keys = 0
  const passkey = (over: Partial<typeof schema.passkeys.$inferInsert> = {}) =>
    db
      .insert(schema.passkeys)
      .values({
        credentialId: `new-${++keys}`,
        publicKey: 'key',
        rpId: remoteHost,
        name: `Phone ${keys}`,
        ...over,
      })
      .returning()
      .get()
  const session = (passkeyId: number, expiresIn = DAY) =>
    db
      .insert(schema.sessions)
      .values({
        tokenHash: `tok-${++keys}`,
        passkeyId,
        expiresAt: new Date(Date.now() + expiresIn).toISOString(),
        lastSeenAt: new Date().toISOString(),
      })
      .run()

  it('applies only to a board reached from other devices', () => {
    expect(registry.applies(typeOf('new-device'))).toBe(false)
    machine.edges.entrance = () => entrance
    expect(registry.applies(typeOf('new-device'))).toBe(true)
  })

  it('is raised for a device that made its passkey lately and has a live session', async () => {
    machine.edges.entrance = () => entrance
    const phone = passkey({ name: 'Ana phone' })
    session(phone.id)
    const [found] = await check('new-device')
    expect(found).toMatchObject({
      subject: `passkey:${phone.id}`,
      severity: 'warning',
      title: 'New sign-in from Ana phone',
    })
    expect(found!.buttons!.map((b) => b.id)).toEqual(['sign-out', 'devices'])
  })

  it('is not raised for this machine, an old device, or one that is signed out', async () => {
    machine.edges.entrance = () => entrance
    session(passkey({ rpId: 'localhost' }).id)
    session(passkey({ createdAt: new Date(Date.now() - 8 * DAY).toISOString() }).id)
    passkey()
    session(passkey().id, -MIN)
    expect(await check('new-device')).toEqual([])
    // The same device is old a week on.
    const fresh = passkey()
    session(fresh.id)
    expect(await check('new-device')).toHaveLength(1)
    expect(await check('new-device', null, 8 * DAY)).toEqual([])
  })

  it('Sign out ends the device’s sessions', async () => {
    machine.edges.entrance = () => entrance
    const phone = passkey()
    const other = passkey()
    session(phone.id)
    session(phone.id)
    session(other.id)
    const [row] = await raise('new-device')
    const mine = db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.subject, `passkey:${phone.id}`))
      .get()!
    expect(mine.id).toBe(row!.id)
    expect(await press(row!.id, 'sign-out')).toMatchObject({
      resolved: true,
      message: 'Signed out 2 sessions.',
    })
    const left = db.select().from(schema.sessions).all()
    expect(left.map((s) => s.passkeyId)).toEqual([other.id])
  })
})

describe('23 tailnet entrance not reachable', () => {
  it('applies only when the entrance is on', () => {
    expect(registry.applies(typeOf('tailnet-entrance'))).toBe(false)
    machine.edges.entrance = () => entrance
    expect(registry.applies(typeOf('tailnet-entrance'))).toBe(true)
  })

  it('is raised when the entrance does not answer, and not when it does', async () => {
    machine.edges.entrance = () => entrance
    let answer = { ok: false, message: 'Tailscale is Stopped on this machine: sign in first' }
    machine.edges.checkEntrance = async () => answer
    const [found] = await check('tailnet-entrance')
    expect(found).toMatchObject({
      severity: 'problem',
      title: `The tailnet link ${entrance.origin} is not answering`,
    })
    expect(found!.body).toContain('Tailscale is Stopped')
    expect(found!.buttons!.map((b) => b.id)).toEqual(['check', 'tailnet'])
    machine.resetMachineState()
    answer = { ok: true, message: 'fine' }
    expect(await check('tailnet-entrance')).toEqual([])
  })

  it('keeps the answer for a few minutes and asks again after', async () => {
    machine.edges.entrance = () => entrance
    let asked = 0
    machine.edges.checkEntrance = async () => ({ ok: ++asked > 1, message: 'down' })
    expect(await check('tailnet-entrance')).toHaveLength(1)
    expect(await check('tailnet-entrance', null, MIN)).toHaveLength(1)
    expect(asked).toBe(1)
    expect(await check('tailnet-entrance', null, machine.ENTRANCE_TTL_MS + MIN)).toEqual([])
    expect(asked).toBe(2)
  })

  it('does not wait for an entrance that never answers', async () => {
    machine.edges.entrance = () => entrance
    machine.edges.checkEntrance = () => new Promise(() => {})
    const started = Date.now()
    expect(await check('tailnet-entrance')).toEqual([])
    expect(Date.now() - started).toBeLessThan(machine.SLOW_WAIT_MS + 1000)
  })

  it('treats a check that threw as not answering', async () => {
    machine.edges.entrance = () => entrance
    machine.edges.checkEntrance = async () => {
      throw new Error('tailscale: command not found')
    }
    expect(await check('tailnet-entrance')).toMatchObject([
      { body: expect.stringContaining('command not found') },
    ])
  })

  it('Check again asks the entrance now and resolves the alert once it answers', async () => {
    machine.edges.entrance = () => entrance
    let ok = false
    machine.edges.checkEntrance = async () => ({ ok, message: 'No answer from the listener' })
    const [row] = await raise('tailnet-entrance')
    expect(await press(row!.id, 'check')).toMatchObject({
      resolved: false,
      message: 'No answer from the listener',
    })
    ok = true
    expect(await press(row!.id, 'check')).toMatchObject({ resolved: true, message: 'The entrance answers.' })
  })
})

describe('32 preview limit reached', () => {
  it('is raised for a start the limit refused, listing the previews in use', async () => {
    mp.setPreviewRunner(new FakeRunner())
    setLimit(1)
    const first = ticketWithWorktree()
    const second = ticketWithWorktree()
    await startRunning(first.ws.id)
    expect(await check('preview-limit', previewProject)).toEqual([])
    expect(() => mp.startPreview(second.ws.id, 'claude')).toThrow(/at most 1/)
    const [found] = await check('preview-limit', previewProject)
    expect(found).toMatchObject({
      severity: 'warning',
      title: `The preview of #${second.t.id} ${second.t.title} did not start: the limit is reached`,
    })
    expect(found!.details).toEqual([expect.stringContaining(`#${first.t.id}`)])
    expect(found!.buttons).toEqual([
      { id: 'stop-oldest', label: 'Stop the oldest and start this one', kind: 'action', primary: true },
      { id: 'previews', label: 'Open Previews', kind: 'link', href: `/projects/${previewProject}/previews` },
    ])
    expect(await check('preview-limit', newProject())).toEqual([])
  })

  it('is not raised once there is room, or when nothing was refused', async () => {
    mp.setPreviewRunner(new FakeRunner())
    setLimit(1)
    const first = ticketWithWorktree()
    const second = ticketWithWorktree()
    await startRunning(first.ws.id)
    // The limit is full, but nobody was refused.
    expect(await check('preview-limit', previewProject)).toEqual([])
    expect(() => mp.startPreview(second.ws.id, 'claude')).toThrow()
    expect(await check('preview-limit', previewProject)).toHaveLength(1)
    // The human raises the limit: there is room.
    setLimit(2)
    expect(await check('preview-limit', previewProject)).toEqual([])
    // Back to full, and the refused one starts by itself: nothing waits any more.
    setLimit(1)
    await mp.stopPreview(first.ws.id, 'room', 'enrique')
    mp.startPreview(second.ws.id, 'enrique')
    await vi.waitFor(() => expect(status(second.ws.id)).toBe('running'))
    expect(await check('preview-limit', previewProject)).toEqual([])
  })

  it('is raised for a day after the refusal, then forgotten', async () => {
    mp.setPreviewRunner(new FakeRunner())
    setLimit(1)
    await startRunning(ticketWithWorktree().ws.id)
    expect(() => mp.startPreview(ticketWithWorktree().ws.id, 'claude')).toThrow()
    expect(await check('preview-limit', previewProject, 23 * HOUR)).toHaveLength(1)
    expect(await check('preview-limit', previewProject, 25 * HOUR)).toEqual([])
  })

  it('Stop the oldest stops it and starts the refused preview', async () => {
    const runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    setLimit(2)
    const old = ticketWithWorktree()
    const newer = ticketWithWorktree()
    const wanted = ticketWithWorktree()
    await startRunning(old.ws.id)
    await new Promise((r) => setTimeout(r, 5))
    await startRunning(newer.ws.id)
    expect(() => mp.startPreview(wanted.ws.id, 'claude')).toThrow()
    const [row] = await raise('preview-limit', previewProject)
    expect(await press(row!.id, 'stop-oldest')).toMatchObject({ resolved: true })
    expect(status(old.ws.id)).toBe('stopped')
    expect(mp.managedPreview(old.ws.id)!.reason).toBe('stopped to make room')
    expect(status(newer.ws.id)).toBe('running')
    await vi.waitFor(() => expect(status(wanted.ws.id)).toBe('running'))
    expect(await check('preview-limit', previewProject)).toEqual([])
  })

  it('Stop the oldest stops nothing when the refused preview cannot start anyway', async () => {
    mp.setPreviewRunner(new FakeRunner())
    setLimit(1)
    const running = ticketWithWorktree()
    const wanted = ticketWithWorktree()
    await startRunning(running.ws.id)
    expect(() => mp.startPreview(wanted.ws.id, 'claude')).toThrow()
    const [row] = await raise('preview-limit', previewProject)
    // Its worktree is gone: the start would be refused, so nothing is stopped for it.
    fs.rmSync(db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wanted.ws.id)).get()!.path, {
      recursive: true,
    })
    await expect(press(row!.id, 'stop-oldest')).rejects.toThrow()
    expect(status(running.ws.id)).toBe('running')
  })
})

describe('34 file storage unreachable', () => {
  /** A store that answers from memory, or fails every call with `failure`. */
  function store(failure: Error | null = null): FileStore & { held: Map<string, Buffer> } {
    const held = new Map<string, Buffer>()
    const gate = async () => {
      if (failure) throw failure
    }
    return {
      kind: 's3',
      held,
      put: async (key, bytes) => {
        await gate()
        held.set(key, bytes)
      },
      read: async () => {
        throw new Error('not used')
      },
      localPath: (key) => key,
      ensureLocal: async (key) => key,
      delete: async (key) => {
        await gate()
        held.delete(key)
      },
    }
  }

  it('applies only to a board with S3 storage', () => {
    expect(registry.applies(typeOf('file-storage'))).toBe(false)
    machine.edges.store = () => store()
    expect(registry.applies(typeOf('file-storage'))).toBe(true)
  })

  it('is raised when the store fails a write, and not when it answers (the probe object is removed)', async () => {
    const down = store(new Error('file storage unreachable (http://minio:9000): connect ECONNREFUSED'))
    machine.edges.store = () => down
    const [found] = await check('file-storage')
    expect(found).toMatchObject({ severity: 'problem', title: 'The file storage is not answering' })
    expect(found!.body).toContain('ECONNREFUSED')
    expect(found!.buttons!.map((b) => b.id)).toEqual(['test', 'settings'])

    machine.resetMachineState()
    const up = store()
    machine.edges.store = () => up
    expect(await check('file-storage')).toEqual([])
    expect(up.held.size).toBe(0)
  })

  it('is raised for a real S3 client that cannot reach its endpoint', async () => {
    const real = storage.s3Store(
      {
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        bucket: 'attachments',
        accessKey: 'a',
        secretKey: 's',
      },
      path.join(tmp, 'cache-probe'),
    )
    fs.mkdirSync(path.join(tmp, 'cache-probe'), { recursive: true })
    machine.edges.store = () => real
    const [found] = await check('file-storage')
    expect(found).toMatchObject({ severity: 'problem' })
    expect(found!.body).toContain('file storage unreachable')
  }, 30_000)

  it('keeps the answer for a couple of minutes', async () => {
    let calls = 0
    const counting = store()
    const put = counting.put
    counting.put = async (...args) => {
      calls++
      return put(...args)
    }
    machine.edges.store = () => counting
    await check('file-storage')
    await check('file-storage', null, MIN)
    expect(calls).toBe(1)
    await check('file-storage', null, machine.STORAGE_TTL_MS + MIN)
    expect(calls).toBe(2)
  })

  it('Test the connection probes now and resolves the alert once the store answers', async () => {
    let failure: Error | null = new Error('bucket is gone')
    const flaky = store()
    const put = flaky.put
    flaky.put = async (...args) => {
      if (failure) throw failure
      return put(...args)
    }
    machine.edges.store = () => flaky
    const [row] = await raise('file-storage')
    expect(await press(row!.id, 'test')).toMatchObject({
      resolved: false,
      message: 'No answer: bucket is gone',
    })
    failure = null
    expect(await press(row!.id, 'test')).toMatchObject({
      resolved: true,
      message: 'The file storage answers.',
    })
  })
})
