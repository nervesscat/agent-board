import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PreviewRunner, Proc } from './managedPreview'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-cloud-')))
process.env.DATA_DIR = path.join(tmp, 'data')
// The tailnet entrance a cloud session reaches the board through.
process.env.PUBLIC_ORIGIN = 'https://board.tail1234.ts.net'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let mp: typeof import('./managedPreview')
let agents: typeof import('./agents')
let handle: (request: Request) => Promise<Response>
let projectId: number
let repoId: number

// --- git: an origin, the board's main checkout of it, and another machine that pushes to it ---

const code = path.join(tmp, 'code')
const origin = path.join(tmp, 'origin.git')
const main = path.join(code, 'shop')
const elsewhere = path.join(tmp, 'cloud', 'shop')

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim()

/** A commit on `branch` pushed from the other machine; its sha. */
function pushFromElsewhere(branch: string, file: string, text: string) {
  const has = git(elsewhere, 'branch', '--list', branch)
  git(elsewhere, 'checkout', '--quiet', ...(has ? [branch] : ['-b', branch, 'origin/main']))
  fs.writeFileSync(path.join(elsewhere, file), text)
  git(elsewhere, 'add', '.')
  git(elsewhere, 'commit', '--quiet', '-m', `${file}: ${text}`)
  git(elsewhere, '-c', 'push.negotiate=false', 'push', '--quiet', '--force', 'origin', `${branch}:${branch}`)
  return git(elsewhere, 'rev-parse', 'HEAD')
}

// --- the fake runner (as in managedPreview.test.ts): shell steps exit 0, servers answer ---

class FakeRunner implements PreviewRunner {
  calls: { command: string; cwd: string }[] = []
  private exits = new Map<number, (code: number | null) => void>()
  private up = new Set<string>()
  private urls = new Map<number, string>()
  private pid = 5000
  spawn(
    command: string,
    _args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    this.calls.push({ command, cwd: opts.cwd })
    fs.appendFileSync(opts.log, `${command}\n`)
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
let runner: FakeRunner

beforeAll(async () => {
  fs.mkdirSync(code, { recursive: true })
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  const seed = path.join(tmp, 'seed')
  git(tmp, 'init', '--quiet', '--initial-branch=main', seed)
  fs.writeFileSync(path.join(seed, 'README.md'), 'shop\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'first')
  git(seed, 'push', '--quiet', origin, 'main')
  git(tmp, 'clone', '--quiet', origin, main)
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true })
  git(tmp, 'clone', '--quiet', origin, elsewhere)

  dbm = await import('#/db')
  features = await import('./features')
  mp = await import('./managedPreview')
  agents = await import('./agents')
  const runConfig = await import('./runConfig')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })

  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'shop' }).returning().get().id
  repoId = dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'shop', repoPath: main, githubRepo: 'acme/shop', runsSeeded: true })
    .returning()
    .get().id
  runConfig.createRunConfig(
    repoId,
    {
      name: 'Preview',
      type: 'preview',
      install: '',
      build: 'true',
      start: 'node server.js',
      copyData: false,
    },
    'enrique',
  )
})

afterEach(async () => {
  for (const p of mp.activePreviews()) await mp.stopPreview(p.workspaceId, 'test over', 'test')
  mp.setPreviewRunner(null)
})

async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        authorization: 'Bearer token-of-test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return res
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    'claude',
  )
  return ((await res.json()) as { result: any }).result
}

const newTicket = (branch = '') =>
  features.createTicket(projectId, { title: 'remote work', status: 'in_progress', branch }, 'claude')

const workspacesOf = (ticketId: number) =>
  dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.ticketId, ticketId)).all()

describe('the board skill for a session without MCP tools', () => {
  it('maps every MCP tool to a REST route, and names no tool the server lacks', async () => {
    const { TOOL_ROUTES } = await import('./skill/rest')
    const tools = ((await rpc('tools/list')).tools as { name: string }[]).map((t) => t.name).sort()
    expect(Object.keys(TOOL_ROUTES).sort()).toEqual(tools)
    expect(tools).toContain('preview_branch')
  })

  it('is served with transport=rest: the REST section, every tool, the board as the caller reached it', async () => {
    const res = await call('GET', '/api/agent-setup/skill?client=claude&transport=rest', undefined, {
      host: 'board.tail1234.ts.net',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown/)
    const skill = await res.text()
    const { TOOL_ROUTES } = await import('./skill/rest')
    expect(skill).toMatch(/^---\nname: board\n/)
    expect(skill).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(skill).toContain("## Without the board's MCP tools: REST")
    expect(skill).toContain('https://board.tail1234.ts.net/api/tickets/12/updates')
    expect(skill).not.toContain('claude mcp add')
    expect(skill).not.toContain('Its tools come from the `board` MCP')
    for (const [tool, route] of Object.entries(TOOL_ROUTES))
      expect(skill).toContain(`| \`${tool}\` | ${route.replaceAll('|', '\\|')} |`)
    // The section comes before the rest of the skill, where an agent reads it first.
    expect(skill.indexOf('REST\n')).toBeLessThan(skill.indexOf('## 1. Your project'))
  })

  it('stays as it was without transport, or with transport=mcp, on this machine', async () => {
    const plain = await (await call('GET', '/api/agent-setup/skill?client=claude')).text()
    expect(plain).toBe(agents.renderSkill('claude'))
    expect(await (await call('GET', '/api/agent-setup/skill?client=claude&transport=mcp')).text()).toBe(plain)
    expect(plain).not.toContain("Without the board's MCP tools")
    expect(plain).toContain(
      'claude mcp add --transport http --scope user board http://localhost:47100/api/mcp',
    )
    // An unknown transport is the MCP one, as an unknown client is Claude Code.
    expect(await (await call('GET', '/api/agent-setup/skill?transport=carrier-pigeon')).text()).toBe(plain)
  })

  it('is what the board and review skills tell a session that lacks the tools, the agent types or the Agent tool', async () => {
    expect(agents.renderSkill('claude')).toContain('/api/agent-setup/skill?transport=rest')
    const tar = Buffer.from(agents.reviewBundle()).toString('utf8')
    const heading = "## In a session without the board's tools, agent types or the Agent tool"
    expect(tar.split(heading)).toHaveLength(4)
    for (const said of [
      '?transport=rest',
      'board-mcp',
      'Start a general-purpose agent',
      'run each phase yourself',
      'POST /api/tickets/:id/branch-preview',
    ])
      expect(tar.split(said).length - 1, said).toBeGreaterThanOrEqual(3)
  })

  it('serves the stdio bridge as it is in scripts/', async () => {
    const res = await call('GET', '/api/agent-setup/board-mcp')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/)
    const want = fs.readFileSync(path.join(process.cwd(), 'scripts', 'board-mcp.mjs'), 'utf8')
    expect(await res.text()).toBe(want.replace(/\r\n/g, '\n'))
  })
})

describe('a board-run preview of a branch pushed from another machine', () => {
  it('fetches the branch into a detached worktree beside the checkout, registers it and runs the preview', async () => {
    runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const sha = pushFromElsewhere('feat/login', 'login.txt', 'v1')
    const t = newTicket('feat/login')

    const res = await call('POST', `/api/tickets/${t.id}/branch-preview`, {})
    const body = (await res.json()) as any
    expect(res.status, JSON.stringify(body)).toBe(202)
    const dir = path.join(code, 'shop-preview-feat-login')
    expect(body).toMatchObject({ branch: 'feat/login', sha, path: dir })
    expect(body.preview.status).toBe('building')
    // A worktree of the main checkout, detached at origin's head: no local branch was made.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha)
    expect(() => git(dir, 'symbolic-ref', '-q', 'HEAD')).toThrow()
    expect(git(main, 'branch', '--list', 'feat/login')).toBe('')
    expect(fs.readFileSync(path.join(dir, 'login.txt'), 'utf8')).toBe('v1')
    expect(workspacesOf(t.id)).toEqual([
      expect.objectContaining({ id: body.workspace.id, path: dir, branch: 'feat/login', repoId }),
    ])
    await vi.waitFor(() => expect(mp.managedPreview(body.workspace.id)?.status).toBe('running'))
    // The run's start command, from the board's worktree.
    expect(runner.calls).toContainEqual({ command: process.execPath, cwd: dir })
  })

  it('moves that worktree to a new push and builds again, in the same workspace', async () => {
    runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    pushFromElsewhere('feat/cart', 'cart.txt', 'v1')
    const t = newTicket('feat/cart')
    const first = (await (await call('POST', `/api/tickets/${t.id}/branch-preview`, {})).json()) as any
    await vi.waitFor(() => expect(mp.managedPreview(first.workspace.id)?.status).toBe('running'))
    const before = mp.managedPreview(first.workspace.id)!

    // A force-push too: the worktree follows origin, whatever happened to the branch.
    git(elsewhere, 'reset', '--quiet', '--hard', 'origin/main')
    const sha = pushFromElsewhere('feat/cart', 'cart.txt', 'v2')
    const res = await call('POST', `/api/tickets/${t.id}/branch-preview`, { branch: 'feat/cart' })
    const again = (await res.json()) as any
    expect(res.status, JSON.stringify(again)).toBe(202)
    expect(again.sha).toBe(sha)
    expect(again.workspace.id).toBe(first.workspace.id)
    expect(workspacesOf(t.id)).toHaveLength(1)
    expect(fs.readFileSync(path.join(first.path, 'cart.txt'), 'utf8')).toBe('v2')
    await vi.waitFor(() => expect(mp.managedPreview(first.workspace.id)?.status).toBe('running'))
    expect(mp.managedPreview(first.workspace.id)!.startedAt).not.toBe(before.startedAt)
  })

  it('is the MCP tool preview_branch too', async () => {
    runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const sha = pushFromElsewhere('feat/search', 'search.txt', 'v1')
    const t = newTicket()
    const result = await rpc('tools/call', {
      name: 'preview_branch',
      arguments: { ticketId: t.id, branch: 'feat/search' },
    })
    expect(result.isError, result.content[0].text).toBeFalsy()
    const out = JSON.parse(result.content[0].text)
    expect(out).toMatchObject({
      branch: 'feat/search',
      sha,
      path: path.join(code, 'shop-preview-feat-search'),
    })
    await vi.waitFor(() => expect(mp.managedPreview(out.workspace.id)?.status).toBe('running'))
  })

  it('refuses what it cannot preview, and changes nothing', async () => {
    runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const t = newTicket()
    const refused = async (body: unknown, status: number, said: RegExp) => {
      const res = await call('POST', `/api/tickets/${t.id}/branch-preview`, body)
      const out = (await res.json()) as { error: string }
      expect(res.status, out.error).toBe(status)
      expect(out.error).toMatch(said)
    }
    await refused({}, 400, /no branch to preview/)
    await refused({ branch: '--upload-pack=touch x' }, 400, /not a branch name/)
    await refused({ branch: 'a..b' }, 400, /not a branch name/)
    await refused({ branch: 'never-pushed' }, 404, /origin has no branch never-pushed/)
    await refused({ branch: 'main', repoId: 9999 }, 400, /not one of ticket/)
    expect(fs.existsSync(path.join(code, 'shop-preview-never-pushed'))).toBe(false)
    expect(workspacesOf(t.id)).toEqual([])

    // A folder there that someone works in: on a branch, or with changes, or not a worktree at all.
    pushFromElsewhere('feat/busy', 'busy.txt', 'v1')
    git(main, 'fetch', '--quiet', 'origin')
    const busy = path.join(code, 'shop-preview-feat-busy')
    git(main, 'worktree', 'add', '--quiet', '-b', 'feat/busy', busy, 'origin/feat/busy')
    await refused({ branch: 'feat/busy' }, 409, /is on feat\/busy: the board only moves/)

    pushFromElsewhere('feat/dirty', 'dirty.txt', 'v1')
    const dirty = path.join(code, 'shop-preview-feat-dirty')
    git(main, 'fetch', '--quiet', 'origin')
    git(main, 'worktree', 'add', '--quiet', '--detach', dirty, 'origin/feat/dirty')
    fs.writeFileSync(path.join(dirty, 'dirty.txt'), 'my edit')
    pushFromElsewhere('feat/dirty', 'dirty.txt', 'v2')
    await refused({ branch: 'feat/dirty' }, 409, /has changes the board would lose/)
    expect(fs.readFileSync(path.join(dirty, 'dirty.txt'), 'utf8')).toBe('my edit')

    pushFromElsewhere('feat/plain', 'plain.txt', 'v1')
    fs.mkdirSync(path.join(code, 'shop-preview-feat-plain'))
    await refused({ branch: 'feat/plain' }, 409, /exists and cannot be used/)
    expect(workspacesOf(t.id)).toEqual([])
  })

  it("refuses a folder that previews another ticket's branch, and a closed ticket", async () => {
    runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    pushFromElsewhere('feat/shared', 'shared.txt', 'v1')
    const a = newTicket('feat/shared')
    const first = await call('POST', `/api/tickets/${a.id}/branch-preview`, {})
    expect(first.status).toBe(202)
    const b = newTicket('feat/shared')
    const res = await call('POST', `/api/tickets/${b.id}/branch-preview`, {})
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/is workspace \d+ of ticket \d+/)

    const done = newTicket('feat/shared')
    features.updateTicket(done.id, { status: 'done' }, 'enrique')
    const closed = await call('POST', `/api/tickets/${done.id}/branch-preview`, {})
    expect(closed.status).toBe(409)
    expect(((await closed.json()) as { error: string }).error).toMatch(/the ticket is done/)
  })
})
