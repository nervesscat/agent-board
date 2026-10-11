import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { freePort, killAll, killTree, startServer } from './server.mjs'

// A build of its own in place of the board's: `server/index.mjs` answers every request with its pid
// and, like the board's server when its port is taken, exits quietly when it cannot listen.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-server-test-'))
const buildDir = path.join(root, 'build')
fs.mkdirSync(path.join(buildDir, 'server'), { recursive: true })
fs.writeFileSync(
  path.join(buildDir, 'server', 'index.mjs'),
  `import http from 'node:http'
if (process.env.CRASH) process.exit(3)
let first = Number(process.env.SLOW_FIRST ?? 0)
const server = http.createServer((req, res) => {
  setTimeout(() => res.end(String(process.pid)), first)
  first = 0
})
server.on('error', () => process.exit(0))
server.listen(Number(process.env.PORT), process.env.HOST)
`,
)
const log = path.join(root, 'server.log')
const start = (port) =>
  startServer({ target: process.cwd(), buildDir, dataDir: path.join(root, 'data'), port, human: 'h', log })

const others = []
afterEach(async () => {
  killAll()
  await Promise.all(others.splice(0).map((s) => new Promise((r) => s.close(r))))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

/** Who answers: the pid in the body of a request to the server the harness talks to. */
const answeredBy = async (server) => (await server.request('/who')).text

describe('startServer', () => {
  it('two starts on the same free port each end on a server of their own', async () => {
    const port = await freePort(47380)
    const [a, b] = await Promise.all([start(port), start(port)])
    expect(new Set([a.port, b.port]).size).toBe(2)
    expect([a.port, b.port]).toContain(port)
    for (const s of [a, b]) {
      expect(s.proc.exitCode).toBeNull()
      expect(await answeredBy(s)).toBe(String(s.pid))
    }
  }, 60_000)

  it('a second start on a port the first one holds moves to the next free port', async () => {
    const port = await freePort(47380)
    const a = await start(port)
    const b = await start(port)
    expect(a.port).toBe(port)
    expect(b.port).toBeGreaterThan(port)
    expect(await answeredBy(a)).toBe(String(a.pid))
    expect(await answeredBy(b)).toBe(String(b.pid))
  }, 60_000)

  it('never takes another process that answers on its port for its own server', async () => {
    const port = await freePort(47380)
    const other = http.createServer((req, res) => res.end('someone else'))
    others.push(other)
    await new Promise((r) => other.listen(port, '127.0.0.1', r))
    const s = await start(port)
    expect(s.port).not.toBe(port)
    expect(await answeredBy(s)).toBe(String(s.pid))
  }, 60_000)

  it('moves on when its own server exits because something else holds the port', async () => {
    const port = await freePort(47380)
    // Holds the port without ever answering, so only the server's exit says it is taken.
    const other = net.createServer((socket) => socket.destroy())
    others.push(other)
    await new Promise((r) => other.listen(port, '127.0.0.1', r))
    const s = await start(port)
    expect(s.port).not.toBe(port)
    expect(await answeredBy(s)).toBe(String(s.pid))
    expect(fs.readFileSync(log, 'utf8')).toMatch(/exited \(0\) with the port in use/)
  }, 60_000)

  it('in a process of its own, moves on when a 200 comes from another server while its own exits', async () => {
    // Vitest's worker keeps its own loop alive; a harness at its first start holds nothing but the
    // server it waits for, so the start runs where nothing else does.
    const port = await freePort(47380)
    const other = http.createServer((req, res) => res.end('someone else'))
    others.push(other)
    await new Promise((r) => other.listen(port, '127.0.0.1', r))
    const script = path.join(root, 'alone.mjs')
    fs.writeFileSync(
      script,
      `import { startServer } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/bench/server.mjs')).href)}
const s = await startServer(JSON.parse(process.argv[2]))
console.log(s.port)
await s.stop()
`,
    )
    const alone = path.join(root, 'alone.log')
    const opts = {
      target: process.cwd(),
      buildDir,
      dataDir: path.join(root, 'data'),
      port,
      human: 'h',
      log: alone,
    }
    const child = spawn(process.execPath, [script, JSON.stringify(opts)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const code = await new Promise((resolve) => child.once('exit', resolve))
    expect(code, out).toBe(0)
    expect(Number(out.trim())).toBeGreaterThan(port)
    expect(fs.readFileSync(alone, 'utf8')).toContain(`port ${port} is another server's`)
  }, 60_000)

  it('keeps its own server when its first answer is slow (vite dev compiling it)', async () => {
    process.env.SLOW_FIRST = '6000'
    try {
      const port = await freePort(47380)
      const s = await start(port)
      expect(s.port).toBe(port)
      expect(await answeredBy(s)).toBe(String(s.pid))
    } finally {
      delete process.env.SLOW_FIRST
    }
  }, 60_000)

  it('fails clearly, with nothing left uncaught, when its server exits during the run', async () => {
    const s = await start(await freePort(47380))
    expect(await s.memory()).toMatchObject({ type: 'memory', rss: expect.any(Number) })
    expect(await s.background()).toMatchObject({ type: 'background' })
    killTree(s.proc)
    await new Promise((resolve) =>
      (s.proc.exitCode ?? s.proc.signalCode) !== null ? resolve() : s.proc.once('exit', resolve),
    )
    await expect(s.background()).rejects.toThrow(/bench server exited .*during the run/)
    await expect(s.memory()).rejects.toThrow(/bench server exited .*during the run/)
    await expect(s.request('/who')).rejects.toThrow(/bench server exited .*during the run/)
    await s.stop()
  }, 60_000)

  it('fails clearly when the channel to its server has closed before its exit is seen', async () => {
    const s = await start(await freePort(47380))
    // Closed from this side: the server has not exited yet, so only the send itself can fail.
    s.proc.disconnect()
    await expect(s.background()).rejects.toThrow(/bench server exited.* during the run/)
    await expect(s.memory()).rejects.toThrow(/bench server exited.* during the run/)
    await s.stop()
  }, 60_000)

  it('fails clearly when its server exits on a free port, without trying another', async () => {
    process.env.CRASH = '1'
    try {
      await expect(start(await freePort(47380))).rejects.toThrow(/exited \(3\) before it answered/)
    } finally {
      delete process.env.CRASH
    }
  }, 60_000)
})
