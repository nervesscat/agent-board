import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PreviewRunner, Proc } from './managedPreview'

/**
 * Stopping a link preview, against real processes: the servers are node children this test starts
 * (from a worktree, a sibling of it, or a folder elsewhere), and the board finds them and kills them
 * for real, by their port. Nothing here kills a process the test did not start.
 */

const WIN = process.platform === 'win32'

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// The board's own port is one a server of this test takes: never the live board's.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')
const boardPort = await freePort()
process.env.PORT = String(boardPort)

let mp: typeof import('./managedPreview')
let lp: typeof import('./linkPreview')
let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectPreviews: typeof import('./projectPreviews').projectPreviews
let projectId: number
let otherId: number

// --- the repo: a main checkout, and worktrees of it next to it ---

const repos = path.join(tmp, 'code')
const main = path.join(repos, 'agent-board')
let wtCount = 0

function freshWorktree() {
  const dir = path.join(repos, `agent-board-wt${++wtCount}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(main, '.git', 'worktrees', path.basename(dir))}\n`,
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'some-app' }))
  return dir
}

// --- the servers ---

// Listens on the host and port it is given (0: any), prints its port and its own child's pid; with
// `grandchild` it starts a child of its own first, as `vite` starts esbuild.
const SERVER = `
const http = require('node:http')
const [host, port, grandchild] = process.argv.slice(2)
const child = grandchild === 'grandchild'
  ? require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  : null
const server = http.createServer((_req, res) => res.end('a preview'))
server.listen(Number(port), host, () =>
  console.log(JSON.stringify({ port: server.address().port, child: child ? child.pid : null })),
)
`

interface Server {
  child: ChildProcess
  pid: number
  port: number
  grandchild: number | null
  exited: Promise<unknown>
}

const started: Server[] = []

/** `node <script>` from `cwd`, listening on `host`; resolves once it listens. */
async function serve(
  script: string,
  opts: { cwd: string; host?: string; port?: number; grandchild?: boolean },
): Promise<Server> {
  const file = path.resolve(opts.cwd, script)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, SERVER)
  const child = spawn(
    process.execPath,
    // The script by its whole path, as a package's bin starts it (Windows gives no working directory).
    [
      path.isAbsolute(script) ? script : path.join(opts.cwd, script),
      opts.host ?? '127.0.0.1',
      String(opts.port ?? 0),
      opts.grandchild ? 'grandchild' : '',
    ],
    { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  )
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const line = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) resolve(out.split('\n')[0]!)
    })
    child.once('exit', (code) => reject(new Error(`the server exited (${code}) before it listened`)))
  })
  const { port, child: grandchild } = JSON.parse(line) as { port: number; child: number | null }
  const s = { child, pid: child.pid!, port, grandchild, exited }
  started.push(s)
  return s
}

/** Whether the process still runs (a zombie waiting to be reaped does not). */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

const listening = async (port: number) => (await lp.listenersOn([port])).get(port) ?? []

afterEach(async () => {
  // Only what this test started.
  for (const s of started.splice(0)) {
    for (const pid of [s.grandchild, s.pid])
      if (pid && alive(pid))
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // gone meanwhile
        }
  }
  for (const p of mp.activePreviews()) await mp.stopPreview(p.workspaceId, 'test over', 'test')
  mp.setPreviewRunner(null)
})

// --- the board's previews, faked as in managedPreview.test.ts: builds hang or exit, servers answer ---

class FakeRunner implements PreviewRunner {
  codes: Record<string, number | 'hang'> = {}
  private exits = new Map<number, (code: number | null) => void>()
  private up = new Set<string>()
  private urls = new Map<number, string>()
  private pid = 1000
  spawn(
    command: string,
    _args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean },
  ): Proc {
    const pid = ++this.pid
    fs.appendFileSync(opts.log, `${command}\n`)
    const exited = new Promise<number | null>((resolve) => this.exits.set(pid, resolve))
    if (opts.shell) {
      const code = this.codes[command] ?? 0
      if (code !== 'hang') setTimeout(() => this.exits.get(pid)!(code), 0)
    } else {
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

let fake: FakeRunner
function useFake() {
  fake = new FakeRunner()
  mp.setPreviewRunner(fake)
  return fake
}

/** A worktree of the board itself, for the previews the board runs (with the fake runner). */
function boardWorktree() {
  const dir = freshWorktree()
  const lock = "lockfileVersion: '9.0'\n"
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock)
  fs.mkdirSync(path.join(dir, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', '.pnpm', 'lock.yaml'), lock)
  return dir
}

beforeAll(async () => {
  fs.mkdirSync(path.join(main, '.git'), { recursive: true })
  // A checkout of the board: its repo gets the board's preview run.
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  mp = await import('./managedPreview')
  lp = await import('./linkPreview')
  features = await import('./features')
  dbm = await import('#/db')
  ;({ projectPreviews } = await import('./projectPreviews'))
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'app' }).returning().get().id
  otherId = dbm.db.insert(dbm.schema.projects).values({ name: 'other' }).returning().get().id
  for (const id of [projectId, otherId])
    dbm.db.insert(dbm.schema.repos).values({ projectId: id, name: 'app', repoPath: main }).run()
})

let ticketCount = 0
const ticket = (project = projectId) =>
  features.createTicket(project, { title: `ticket ${++ticketCount}`, status: 'in_progress' }, 'claude')
const workspace = (path_: string, previewUrl: string, project = projectId) =>
  features.addWorkspace(ticket(project).id, { name: 'wt', branch: 'feat', path: path_, previewUrl }, 'claude')
const wsRow = (id: number) =>
  dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, id)).get()!
const rowOf = async (id: number, project = projectId) =>
  (await projectPreviews(project)).find((p) => p.workspace.id === id)!

async function call(method: string, pathname: string, as: 'human' | 'agent' = 'human') {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  const request = new Request(`http://localhost${pathname}`, {
    method,
    // An agent token: an agent, as opposed to the human's passkey session.
    headers: as === 'agent' ? { authorization: 'Bearer token-of-test' } : {},
  })
  const res = await handle({ request, actor: as === 'agent' ? 'claude' : 'enrique' })
  return { status: res.status, body: (await res.json()) as any }
}
const stopLink = (id: number, as: 'human' | 'agent' = 'human') =>
  call('POST', `/api/workspaces/${id}/preview/stop-link`, as)

describe('the rule, by itself', () => {
  it('matches a worktree on a path boundary only, `..` resolved', () => {
    const wt = path.join(repos, 'agent-board-x')
    expect(lp.isInside(wt, wt)).toBe(true)
    expect(lp.isInside(path.join(wt, 'node_modules', '.bin', '..', 'vite', 'bin', 'vite.js'), wt)).toBe(true)
    expect(lp.isInside(`${wt}-other${path.sep}server.js`, wt)).toBe(false)
    expect(lp.isInside(path.join(wt, '..', 'outside', 'server.js'), wt)).toBe(false)
    expect(lp.isInside(path.dirname(wt), wt)).toBe(false)
    if (WIN) expect(lp.isInside(wt.toUpperCase() + '\\server.js', wt)).toBe(true)
  })

  it('reads every listening address when asked (what the preview proxy checks), LAN ones too', () => {
    const netstat = [
      '  TCP    127.0.0.1:8151         0.0.0.0:0              LISTENING       102',
      '  TCP    192.168.1.5:8153       0.0.0.0:0              LISTENING       104',
    ].join('\r\n')
    expect(lp.parseNetstat(netstat, true).map((l) => [l.port, l.address])).toEqual([
      [8151, '127.0.0.1:8151'],
      [8153, '192.168.1.5:8153'],
    ])
    const ss = [
      'LISTEN 0 511 127.0.0.1:8150 0.0.0.0:* users:(("node",pid=201,fd=20))',
      'LISTEN 0 511 *:8152 *:*',
      'LISTEN 0 511 10.0.0.2:8153 0.0.0.0:* users:(("node",pid=204,fd=20))',
    ].join('\n')
    expect(lp.parseSs(ss, true).map((l) => [l.port, l.address])).toEqual([
      [8150, '127.0.0.1:8150'],
      [8152, '*:8152'],
      [8153, '10.0.0.2:8153'],
    ])
    const lsof = ['p301', 'n127.0.0.1:8150', 'n*:8151', 'n10.0.0.2:8152'].join('\n')
    expect(lp.parseLsof(lsof, true).map((l) => [l.port, l.address])).toEqual([
      [8150, '127.0.0.1:8150'],
      [8151, '*:8151'],
      [8152, '10.0.0.2:8152'],
    ])
    expect(lp.hostPort('[::1]:8154')).toEqual({ host: '::1', port: 8154 })
  })

  it('reads the listening sockets of netstat, ss and lsof, on loopback or every address only', () => {
    const netstat = [
      '  TCP    0.0.0.0:8150           0.0.0.0:0              LISTENING       101',
      '  TCP    127.0.0.1:8151         0.0.0.0:0              ESCUCHANDO      102',
      '  TCP    127.0.0.1:8152         127.0.0.1:50000        ESTABLISHED     103',
      '  TCP    192.168.1.5:8153       0.0.0.0:0              LISTENING       104',
      '  TCP    [::1]:8154             [::]:0                 LISTENING       105',
      '  TCP    [::]:8155              [::]:0                 LISTENING       106',
    ].join('\r\n')
    expect(lp.parseNetstat(netstat).map((l) => [l.port, l.pid])).toEqual([
      [8150, 101],
      [8151, 102],
      [8154, 105],
      [8155, 106],
    ])
    const ss = [
      'LISTEN 0 511 127.0.0.1:8150 0.0.0.0:* users:(("node",pid=201,fd=20))',
      'LISTEN 0 511 [::1]:8151 [::]:* users:(("node",pid=202,fd=20),("node",pid=203,fd=20))',
      'LISTEN 0 511 *:8152 *:*',
      'LISTEN 0 511 10.0.0.2:8153 0.0.0.0:* users:(("node",pid=204,fd=20))',
    ].join('\n')
    expect(lp.parseSs(ss).map((l) => [l.port, l.pid])).toEqual([
      [8150, 201],
      [8151, 202],
      [8151, 203],
      [8152, null],
    ])
    const lsof = ['p301', 'n127.0.0.1:8150', 'n[::1]:8150', 'p302', 'n*:8151', 'n10.0.0.2:8152'].join('\n')
    expect(lp.parseLsof(lsof).map((l) => [l.port, l.pid])).toEqual([
      [8150, 301],
      [8150, 301],
      [8151, 302],
    ])
  })

  it('on macOS takes the working directory and the executable from lsof, never a fragment of the command line', () => {
    const dir = path.join(tmp, 'mac')
    const wt = path.join(dir, 'app-a')
    const copy = path.join(dir, 'app-a copy')
    for (const d of [wt, copy]) fs.mkdirSync(d, { recursive: true })
    const lsof = (cwd: string, ...txt: string[]) =>
      ['p42', 'fcwd', `n${cwd}`, ...txt.flatMap((t) => ['ftxt', `n${t}`])].join('\n')

    // `node "<wt> copy/server.js"` run from the copy: ps would print `node <wt> copy/server.js`, whose
    // fragment `<wt>` is the worktree. lsof gives the copy as a whole, and no arguments are read.
    const fromCopy = lp.parseLsofProcess(42, lsof(copy, '/usr/local/bin/node', '/usr/lib/dyld'))!
    expect(fromCopy).toEqual({ pid: 42, exe: '/usr/local/bin/node', args: [], cwd: copy })
    expect(lp.runsFrom(fromCopy, [wt])).toBe(false)
    expect(lp.runsFrom({ ...fromCopy, args: ['/usr/local/bin/node', wt, 'copy/server.js'] }, [wt])).toBe(true)

    // Run from the worktree, or its executable in it: from the worktree.
    expect(lp.runsFrom(lp.parseLsofProcess(42, lsof(wt, '/usr/local/bin/node'))!, [wt])).toBe(true)
    const esbuild = path.join(wt, 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild')
    expect(lp.runsFrom(lp.parseLsofProcess(42, lsof(copy, esbuild))!, [wt])).toBe(true)
    // A library it loaded from the worktree is not its executable.
    expect(lp.runsFrom(lp.parseLsofProcess(42, lsof(copy, '/usr/local/bin/node', esbuild))!, [wt])).toBe(
      false,
    )
    // Another process's lines, or none (it is gone): nothing about this one.
    expect(lp.parseLsofProcess(42, ['p43', 'fcwd', `n${wt}`].join('\n'))).toBeNull()
    expect(lp.parseLsofProcess(42, '')).toBeNull()
  })

  it('names the worktree by its real path, and as registered only when that is the same folder', () => {
    const code = path.join(tmp, 'roots')
    const feat = path.join(code, 'app-feat')
    fs.mkdirSync(path.join(feat, 'src'), { recursive: true })
    const type = WIN ? 'junction' : 'dir'
    fs.symlinkSync(path.join(feat, 'src'), path.join(code, 'lnk'), type)
    fs.symlinkSync(feat, path.join(code, 'feat-link'), type)
    const real = (p: string) => fs.realpathSync.native(p)

    // A link to the worktree: both name it.
    expect(lp.worktreeRoots(path.join(code, 'feat-link'), feat)).toEqual([feat, path.join(code, 'feat-link')])
    expect(lp.worktreeRoots(feat, feat)).toEqual([feat])

    // `<link>/..`: to the OS (Linux, macOS) the worktree, the link's target's parent; read as the rule
    // reads paths, the folder holding the link. Only the folder that was checked is a root.
    const registered = [code, 'lnk', '..'].join(path.sep)
    const checked = real(registered)
    const roots = lp.worktreeRoots(registered, checked)
    for (const root of roots) expect(real(root)).toBe(checked)
    if (!WIN) {
      expect(checked).toBe(feat)
      expect(roots).toEqual([feat])
      expect(roots.some((root) => lp.isInside(path.join(code, 'app-other', 'server.js'), root))).toBe(false)
    }
  })

  it('splits a Windows command line by its quotes', () => {
    expect(
      lp.splitCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe"  C:\\wt\\node_modules\\vite\\bin\\vite.js dev --port 8150 ""',
      ),
    ).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\wt\\node_modules\\vite\\bin\\vite.js',
      'dev',
      '--port',
      '8150',
      '',
    ])
  })
})

describe('stopping a link preview, against real processes', { timeout: 60_000 }, () => {
  it('stops a server that runs from the worktree on 127.0.0.1: its tree goes, the port is free, the link stays', async () => {
    const wt = freshWorktree()
    const s = await serve('server.js', { cwd: wt, grandchild: true })
    const url = `http://127.0.0.1:${s.port}`
    const ws = workspace(wt, url)

    // The listing says it can be stopped, and asking twice kills nothing.
    expect(await rowOf(ws.id)).toMatchObject({ running: true, check: { running: true }, linkStop: null })
    expect(await rowOf(ws.id)).toMatchObject({ linkStop: null })
    expect(alive(s.pid)).toBe(true)
    const activity = () => dbm.db.select().from(dbm.schema.activity).all()
    const before = activity().length

    const res = await stopLink(ws.id)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      workspaceId: ws.id,
      kind: 'link',
      port: s.port,
      pids: [s.pid],
      freed: true,
    })
    // Free when the answer came, the child and its own child gone.
    expect(await listening(s.port)).toEqual([])
    await s.exited
    await vi.waitFor(() => expect(alive(s.grandchild!)).toBe(false))

    // The link stays; the next listing says at once that it does not answer.
    expect(wsRow(ws.id).previewUrl).toBe(url)
    expect(await rowOf(ws.id)).toMatchObject({ running: false, check: { running: false }, url })
    const logged = activity().slice(before)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      actor: 'enrique',
      kind: 'workspace',
      refId: ws.ticketId,
      text: expect.stringContaining(`stopped the preview on :${s.port}`),
    })
  })

  it('stops one that listens on ::1 only, linked as [::1] or as localhost', async () => {
    for (const host of ['[::1]', 'localhost']) {
      const wt = freshWorktree()
      let s: Server
      try {
        s = await serve('server.js', { cwd: wt, host: '::1' })
      } catch {
        // No IPv6 loopback on this machine: nothing to stop on it.
        return
      }
      const ws = workspace(wt, `http://${host}:${s.port}`)
      const res = await stopLink(ws.id)
      expect(res.status, host).toBe(200)
      await s.exited
      expect(alive(s.pid)).toBe(false)
    }
  })

  it.runIf(WIN)('matches the worktree whatever the case of the registered path', async () => {
    const wt = freshWorktree()
    const s = await serve('server.js', { cwd: wt })
    const mixed = wt.replace(/agent-board-wt/, 'AGENT-Board-WT').replace(/^[a-z]:/i, (d) => d.toLowerCase())
    const ws = workspace(mixed, `http://127.0.0.1:${s.port}`)
    expect((await stopLink(ws.id)).status).toBe(200)
    await s.exited
  })

  it('refuses a sibling whose name starts with the worktree, and a path that leaves it with ..', async () => {
    const wt = freshWorktree()
    const sibling = await serve('server.js', { cwd: `${wt}-other` })
    const ws = workspace(wt, `http://127.0.0.1:${sibling.port}`)
    const res = await stopLink(ws.id)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      `the process on :${sibling.port} (pid ${sibling.pid}) does not run from ${wt}`,
    )
    expect(alive(sibling.pid)).toBe(true)

    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    // Spelled through the worktree, as given: path.join would resolve the `..` here already.
    const escaped = await serve([wt, '..', 'outside', 'server.js'].join(path.sep), { cwd: outside })
    const ws2 = workspace(wt, `http://127.0.0.1:${escaped.port}`)
    const res2 = await stopLink(ws2.id)
    expect(res2.status).toBe(409)
    expect(res2.body.error).toMatch(/does not run from/)
    expect(alive(escaped.pid)).toBe(true)
    expect((await rowOf(ws2.id)).linkStop).toMatch(/does not run from/)
  })

  it('refuses a path written through a link and .. that leaves the worktree as the rule reads it', async () => {
    const wt = freshWorktree()
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    const link = path.join(repos, `lnk-${path.basename(wt)}`)
    fs.symlinkSync(path.join(wt, 'src'), link, WIN ? 'junction' : 'dir')
    // A server in a folder next to the worktree, under the folder holding the link.
    const sibling = await serve('server.js', { cwd: path.join(repos, `next-to-${path.basename(wt)}`) })
    const ws = workspace([link, '..'].join(path.sep), `http://127.0.0.1:${sibling.port}`)
    const res = await stopLink(ws.id)
    // Linux and macOS resolve it to the worktree, which passes, but the server is not in it; Windows
    // reads `..` first, and the folder holding the link is no worktree.
    if (WIN)
      expect(res).toMatchObject({
        status: 400,
        body: { error: expect.stringMatching(/only worktrees next to/) },
      })
    else
      expect(res).toMatchObject({
        status: 409,
        body: { error: `the process on :${sibling.port} (pid ${sibling.pid}) does not run from ${wt}` },
      })
    expect(alive(sibling.pid)).toBe(true)
  })

  it('refuses, and kills nothing, for every case the rule leaves out', async () => {
    const wt = freshWorktree()
    const s = await serve('server.js', { cwd: wt })
    const at = `http://127.0.0.1:${s.port}`
    const expectRefused = async (wsId: number, status: number, error: RegExp, project = projectId) => {
      const res = await stopLink(wsId)
      expect(res.status, error.source).toBe(status)
      expect(res.body.error).toMatch(error)
      expect((await rowOf(wsId, project)).linkStop ?? '').toMatch(error)
      expect(alive(s.pid)).toBe(true)
    }
    // Off this machine.
    await expectRefused(workspace(wt, `https://example.com:${s.port}`).id, 400, /is not on this machine/)
    // Nothing listens.
    const closed = await freePort()
    await expectRefused(
      workspace(wt, `http://127.0.0.1:${closed}`).id,
      409,
      new RegExp(`nothing listens on :${closed}`),
    )
    // No path, a folder that is not a worktree, the main checkout, the board's own folder.
    await expectRefused(workspace('', at).id, 400, /no local path/)
    const plain = path.join(repos, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    await expectRefused(workspace(plain, at).id, 400, /is not a git worktree/)
    await expectRefused(workspace(main, at).id, 400, /main checkout/)
    await expectRefused(workspace(process.cwd(), at).id, 400, /the board's own folder/)
    // A project without a repo (its only one removed after the ticket was made).
    const bare = dbm.db.insert(dbm.schema.projects).values({ name: 'no repo' }).returning().get().id
    const repo = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: bare, name: 'gone', repoPath: main })
      .returning()
      .get()
    const orphan = workspace(wt, at, bare)
    dbm.db.delete(dbm.schema.repos).where(eq(dbm.schema.repos.id, repo.id)).run()
    await expectRefused(orphan.id, 400, /has no repo/, bare)
    // A process from elsewhere.
    const elsewhere = await serve('server.js', { cwd: path.join(tmp, 'elsewhere') })
    const res = await stopLink(workspace(wt, `http://127.0.0.1:${elsewhere.port}`).id)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/does not run from/)
    expect(alive(elsewhere.pid)).toBe(true)
  })

  it("refuses the board's own port, a port a preview the board runs holds, and the board's own process", async () => {
    // The board's port (PORT, set above) held by a server of this test, from the worktree.
    const wt = freshWorktree()
    const onBoardPort = await serve('server.js', { cwd: wt, port: boardPort })
    const res = await stopLink(workspace(wt, `http://127.0.0.1:${boardPort}`).id)
    expect(res).toMatchObject({ status: 400, body: { error: `:${boardPort} is the board's own port` } })
    expect(alive(onBoardPort.pid)).toBe(true)

    // A preview the board runs (faked) on a port a server of this test holds.
    useFake()
    const held = await serve('server.js', { cwd: wt })
    const ports = { ...mp.PORTS }
    Object.assign(mp.PORTS, { from: held.port, to: held.port })
    try {
      const managed = features.addWorkspace(ticket().id, { name: 'wt', path: boardWorktree() }, 'claude')
      mp.startPreview(managed.id, 'claude')
      await vi.waitFor(() => expect(mp.managedPreview(managed.id)?.status).toBe('running'))
    } finally {
      Object.assign(mp.PORTS, ports)
    }
    const res2 = await stopLink(workspace(wt, `http://127.0.0.1:${held.port}`).id)
    expect(res2.status).toBe(409)
    expect(res2.body.error).toMatch(new RegExp(`:${held.port} is a preview the board runs`))
    expect(alive(held.pid)).toBe(true)

    // The board's own process: refused before its command line is even read.
    const own = http.createServer((_req, res) => res.end('the board'))
    await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve))
    try {
      const port = (own.address() as AddressInfo).port
      const res3 = await stopLink(workspace(wt, `http://127.0.0.1:${port}`).id)
      expect(res3).toMatchObject({ status: 409, body: { error: `the board itself listens on :${port}` } })
    } finally {
      await new Promise((resolve) => own.close(resolve))
    }
  })

  it('is the human’s only: an agent gets 403 and the server keeps running', async () => {
    const wt = freshWorktree()
    const s = await serve('server.js', { cwd: wt })
    const ws = workspace(wt, `http://127.0.0.1:${s.port}`)
    const res = await stopLink(ws.id, 'agent')
    expect(res).toMatchObject({ status: 403, body: { error: expect.stringMatching(/only the human/) } })
    expect(alive(s.pid)).toBe(true)
    expect((await call('POST', `/api/projects/${projectId}/previews/stop`, 'agent')).status).toBe(403)
    expect(alive(s.pid)).toBe(true)
    expect((await stopLink(999_999)).status).toBe(404)
  })

  it('looks again when asked: a server swapped since the listing is refused', async () => {
    const wt = freshWorktree()
    const first = await serve('server.js', { cwd: wt })
    const ws = workspace(wt, `http://127.0.0.1:${first.port}`)
    expect((await rowOf(ws.id)).linkStop).toBeNull()
    first.child.kill('SIGKILL')
    await first.exited
    const swapped = await serve('server.js', { cwd: path.join(tmp, 'swapped'), port: first.port })
    const res = await stopLink(ws.id)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/does not run from/)
    expect(alive(swapped.pid)).toBe(true)
  })
})

describe('Stop all', { timeout: 60_000 }, () => {
  it("stops the project's previews the board runs and the links it may; skips the rest with why", async () => {
    // A project of its own: no link of another test points at a port one of these servers took.
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'stop all' }).returning().get().id
    dbm.db.insert(dbm.schema.repos).values({ projectId: project, name: 'app', repoPath: main }).run()
    const f = useFake()
    const running = features.addWorkspace(
      ticket(project).id,
      { name: 'running', path: boardWorktree() },
      'claude',
    )
    mp.startPreview(running.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(running.id)?.status).toBe('running'))
    f.codes['pnpm build'] = 'hang'
    const building = features.addWorkspace(
      ticket(project).id,
      { name: 'building', path: boardWorktree() },
      'claude',
    )
    mp.startPreview(building.id, 'claude')
    expect(mp.managedPreview(building.id)?.status).toBe('building')

    const wt = freshWorktree()
    const mine = await serve('server.js', { cwd: wt })
    const stoppable = workspace(wt, `http://127.0.0.1:${mine.port}`, project)
    const stranger = await serve('server.js', { cwd: path.join(tmp, 'stranger') })
    const notMine = workspace(freshWorktree(), `http://127.0.0.1:${stranger.port}`, project)
    const hosted = workspace(freshWorktree(), 'https://example.com/hosted', project)

    // Another project's, of both kinds, keep running.
    f.codes['pnpm build'] = 0
    const theirs = features.addWorkspace(
      ticket(otherId).id,
      { name: 'theirs', path: boardWorktree() },
      'claude',
    )
    mp.startPreview(theirs.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(theirs.id)?.status).toBe('running'))
    const theirWt = freshWorktree()
    const theirServer = await serve('server.js', { cwd: theirWt })
    workspace(theirWt, `http://127.0.0.1:${theirServer.port}`, otherId)

    const res = await call('POST', `/api/projects/${project}/previews/stop`)
    expect(res.status).toBe(200)
    const stopped = res.body.stopped as { workspaceId: number; kind: string }[]
    expect(stopped.map((s) => [s.workspaceId, s.kind]).sort()).toEqual(
      [
        [running.id, 'managed'],
        [building.id, 'managed'],
        [stoppable.id, 'link'],
      ].sort(),
    )
    expect(res.body.skipped).toEqual([
      {
        workspaceId: notMine.id,
        ticketId: notMine.ticketId,
        reason: `the process on :${stranger.port} (pid ${stranger.pid}) does not run from ${fs.realpathSync.native(wsRow(notMine.id).path)}`,
      },
    ])
    // The link off this machine is left out: it is not on this machine to stop.
    expect(JSON.stringify(res.body)).not.toContain(`"workspaceId":${hosted.id}`)

    expect(mp.managedPreview(running.id)).toMatchObject({ status: 'stopped', reason: 'stopped by enrique' })
    expect(mp.managedPreview(building.id)?.status).toBe('stopped')
    await mine.exited
    expect(alive(stranger.pid)).toBe(true)
    expect(mp.managedPreview(theirs.id)?.status).toBe('running')
    expect(alive(theirServer.pid)).toBe(true)

    // Nothing left: empty lists.
    expect(await call('POST', `/api/projects/${project}/previews/stop`)).toMatchObject({
      status: 200,
      body: { stopped: [], skipped: [expect.objectContaining({ workspaceId: notMine.id })] },
    })
    const empty = dbm.db.insert(dbm.schema.projects).values({ name: 'empty' }).returning().get().id
    expect(await call('POST', `/api/projects/${empty}/previews/stop`)).toEqual({
      status: 200,
      body: { stopped: [], skipped: [] },
    })
    expect((await call('POST', '/api/projects/999999/previews/stop')).status).toBe(404)
  })

  it('stops a link of its own on a workspace whose preview the board runs, building or relinked meanwhile', async () => {
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'both kinds' }).returning().get().id
    dbm.db.insert(dbm.schema.repos).values({ projectId: project, name: 'app', repoPath: main }).run()
    const f = useFake()

    // Running, its link replaced by an agent's own server (set_preview) while it runs.
    const relinkedWt = boardWorktree()
    const relinked = features.addWorkspace(
      ticket(project).id,
      { name: 'relinked', path: relinkedWt },
      'claude',
    )
    mp.startPreview(relinked.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(relinked.id)?.status).toBe('running'))
    const second = await serve('server.js', { cwd: relinkedWt })
    features.setWorkspacePreview(relinked.id, `http://127.0.0.1:${second.port}`, 'claude')

    // Running on its own link: its stop clears the link, and nothing is stopped twice.
    const own = features.addWorkspace(ticket(project).id, { name: 'own', path: boardWorktree() }, 'claude')
    mp.startPreview(own.id, 'claude')
    await vi.waitFor(() => expect(mp.managedPreview(own.id)?.status).toBe('running'))

    // Building (its build never ends): the board sets its link only once its preview answers, so the
    // agent's link stays meanwhile.
    f.codes['pnpm build'] = 'hang'
    const buildingWt = boardWorktree()
    const first = await serve('server.js', { cwd: buildingWt })
    const building = features.addWorkspace(
      ticket(project).id,
      { name: 'building', path: buildingWt, previewUrl: `http://127.0.0.1:${first.port}` },
      'claude',
    )
    const build = mp.startPreview(building.id, 'claude').logs.build
    await vi.waitFor(() => expect(fs.readFileSync(build, 'utf8')).toContain('pnpm build'))
    expect(mp.managedPreview(building.id)?.status).toBe('building')
    expect(wsRow(building.id).previewUrl).toBe(`http://127.0.0.1:${first.port}`)

    const res = await call('POST', `/api/projects/${project}/previews/stop`)
    expect(res.status).toBe(200)
    const stopped = res.body.stopped as { workspaceId: number; kind: string; port: number }[]
    expect(stopped.map((s) => [s.workspaceId, s.kind]).sort()).toEqual(
      [
        [building.id, 'managed'],
        [building.id, 'link'],
        [relinked.id, 'managed'],
        [relinked.id, 'link'],
        [own.id, 'managed'],
      ].sort(),
    )
    expect(
      stopped
        .filter((s) => s.kind === 'link')
        .map((s) => s.port)
        .sort(),
    ).toEqual([first.port, second.port].sort())
    expect(res.body.skipped).toEqual([])
    await first.exited
    await second.exited
    expect(wsRow(own.id).previewUrl).toBe('')
    expect(wsRow(building.id).previewUrl).toBe(`http://127.0.0.1:${first.port}`)
  })
})

describe('on a preview board', { timeout: 60_000 }, () => {
  it('stops no link: the Stop is refused, Stop all skips it, and the row says why', async () => {
    // A preview board runs on a copy of the live data: its links point at servers that really run.
    const reason = 'links are stopped by the live board (or a test-mode one), not by a preview'
    const project = dbm.db.insert(dbm.schema.projects).values({ name: 'preview board' }).returning().get().id
    dbm.db.insert(dbm.schema.repos).values({ projectId: project, name: 'app', repoPath: main }).run()
    const wt = freshWorktree()
    const s = await serve('server.js', { cwd: wt })
    const ws = workspace(wt, `http://127.0.0.1:${s.port}`, project)
    expect((await rowOf(ws.id, project)).linkStop).toBeNull()

    const config = await import('./config')
    const mode = vi
      .spyOn(config, 'authMode')
      .mockReturnValue({ boardEnv: 'development', off: true, human: 'enrique' })
    try {
      expect((await rowOf(ws.id, project)).linkStop).toBe(reason)
      expect(await stopLink(ws.id)).toEqual({ status: 400, body: { error: reason } })
      expect(await call('POST', `/api/projects/${project}/previews/stop`)).toEqual({
        status: 200,
        body: { stopped: [], skipped: [{ workspaceId: ws.id, ticketId: ws.ticketId, reason }] },
      })
      expect(alive(s.pid)).toBe(true)
    } finally {
      mode.mockRestore()
    }

    // A test-mode board (the e2e suite's) stops it, as the live board does.
    const testMode = vi
      .spyOn(config, 'authMode')
      .mockReturnValue({ boardEnv: 'test', off: true, human: 'human' })
    try {
      expect((await rowOf(ws.id, project)).linkStop).toBeNull()
      expect((await stopLink(ws.id)).status).toBe(200)
    } finally {
      testMode.mockRestore()
    }
    await s.exited
  })
})

describe('the links a worktree’s removal stops', () => {
  // A port free now and out of the range the live board's own previews use: a fake preview takes it,
  // and never binds it.
  const previewPort = async (): Promise<number> => {
    const port = await freePort()
    return port >= 47100 && port <= 47199 ? previewPort() : port
  }
  /** The board runs the workspace's preview (faked) on `port`. */
  async function runPreview(workspaceId: number, port: number) {
    const ports = { ...mp.PORTS }
    Object.assign(mp.PORTS, { from: port, to: port })
    try {
      mp.startPreview(workspaceId, 'claude')
      await vi.waitFor(() => expect(mp.managedPreview(workspaceId)?.status).toBe('running'))
    } finally {
      Object.assign(mp.PORTS, ports)
    }
    expect(mp.managedPreview(workspaceId)!.port).toBe(port)
  }
  const linkedAt = async (worktree: string) => (await import('./cleanup')).linkedPreviews()(worktree)

  it('lists a link of its own on a workspace whose preview the board runs from the worktree', async () => {
    useFake()
    const wt = boardWorktree()
    const ws = features.addWorkspace(ticket().id, { name: 'wt', path: wt }, 'claude')
    await runPreview(ws.id, await previewPort())
    // The agent's own server, linked while the board's preview runs: the removal stops that preview first.
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    features.setWorkspacePreview(ws.id, url, 'claude')
    expect(await linkedAt(wt)).toEqual([{ workspaceId: ws.id, ticketId: ws.ticketId, url, port }])
    // The Previews page's Stop still refuses it while that preview runs.
    expect(lp.stoppableLinkPort(wsRow(ws.id))).toBeNull()
  })

  it('never lists a link to the port of that preview itself', async () => {
    useFake()
    const wt = boardWorktree()
    const ws = features.addWorkspace(ticket().id, { name: 'wt', path: wt }, 'claude')
    const port = await previewPort()
    await runPreview(ws.id, port)
    // Its own link, as the board set it.
    expect(wsRow(ws.id).previewUrl).toBe(mp.managedPreview(ws.id)!.url)
    expect(await linkedAt(wt)).toEqual([])
    features.setWorkspacePreview(ws.id, `http://localhost:${port}`, 'claude')
    expect(await linkedAt(wt)).toEqual([])
  })

  it('leaves out a link the rule refuses for another reason while that preview runs', async () => {
    useFake()
    const wt = boardWorktree()
    const ws = features.addWorkspace(ticket().id, { name: 'wt', path: wt }, 'claude')
    await runPreview(ws.id, await previewPort())
    const linked = async (url: string, at = wt) => {
      features.setWorkspacePreview(ws.id, url, 'claude')
      return linkedAt(at)
    }
    // The board's own port, and one off this machine.
    expect(await linked(`http://127.0.0.1:${boardPort}`)).toEqual([])
    expect(await linked('https://example.com')).toEqual([])
    // A port the board's preview of another worktree holds.
    const theirs = features.addWorkspace(ticket().id, { name: 'wt', path: boardWorktree() }, 'claude')
    const theirPort = await previewPort()
    await runPreview(theirs.id, theirPort)
    expect(await linked(`http://127.0.0.1:${theirPort}`)).toEqual([])

    const own = `http://127.0.0.1:${await freePort()}`
    // Registered at another folder since its preview started: that folder's removal stops no preview of it.
    const moved = boardWorktree()
    dbm.db.update(dbm.schema.workspaces).set({ path: moved }).where(eq(dbm.schema.workspaces.id, ws.id)).run()
    expect(await linked(own, moved)).toEqual([])
    dbm.db.update(dbm.schema.workspaces).set({ path: wt }).where(eq(dbm.schema.workspaces.id, ws.id)).run()
    expect(await linked(own)).toHaveLength(1)

    // A preview board stops no link.
    const config = await import('./config')
    const mode = vi
      .spyOn(config, 'authMode')
      .mockReturnValue({ boardEnv: 'development', off: true, human: 'enrique' })
    try {
      expect(await linkedAt(wt)).toEqual([])
    } finally {
      mode.mockRestore()
    }
  })
})
