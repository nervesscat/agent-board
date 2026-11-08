import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { BRIDGE, type DesktopChannel, listenForDesktop } from './updates'

const MODULE = path.join(import.meta.dirname, 'updates.ts')

/**
 * A real Node process with an IPC channel, as the server is under the desktop app: it listens for the
 * app (listenForDesktop on the process itself), holds a listening HTTP server, and on SIGTERM closes it
 * and nothing else, as Nitro's graceful shutdown does. How it ended, or 'alive' if it had not within 5 s.
 */
async function serverUnderTheApp(listen: boolean) {
  const script = [
    `import http from 'node:http'`,
    `import { runnerImport } from 'vite'`,
    `const { module: { BRIDGE, listenForDesktop } } = await runnerImport(${JSON.stringify(MODULE)})`,
    listen ? 'listenForDesktop()' : '',
    `const server = http.createServer().listen(0, '127.0.0.1')`,
    `process.on('SIGTERM', () => server.close())`,
    `server.on('listening', () => process.send({ channel: BRIDGE, ready: true }))`,
  ].join('\n')
  // The module through Vite's module runner (it is TypeScript), which leaves nothing open behind it.
  const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
    cwd: path.dirname(path.dirname(import.meta.dirname)),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ended = new Promise<string>((resolve) =>
    child.once('exit', (code, sig) => resolve(`exit ${code ?? sig}`)),
  )
  try {
    await new Promise((resolve) => child.once('message', resolve))
    // The app's hello and a message that is not for the board: listened to, and still no reason to stay.
    child.send({ channel: 'agent-board:updates', hello: true })
    child.send({ other: true })
    child.kill('SIGTERM')
    return await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r('alive'), 5000))])
  } finally {
    child.kill('SIGKILL')
  }
}

describe('listening for the desktop app', () => {
  it('lets the server end on SIGTERM once it closed what it holds, as it does without the app', async () => {
    expect(await serverUnderTheApp(false)).toBe('exit 0')
    expect(await serverUnderTheApp(true)).toBe('exit 0')
  }, 30_000)
})

/**
 * A real Node process with an IPC channel that listens for the app, which never says hello: what it
 * reports of two state requests, the first of them waiting out HELLO_WAIT_MS.
 */
async function serverNeverGreeted() {
  const script = [
    `import { runnerImport } from 'vite'`,
    `const { module: { HELLO_WAIT_MS, listenForDesktop, updatesState } } = await runnerImport(${JSON.stringify(MODULE)})`,
    'listenForDesktop()',
    // What a server holds open (its HTTP server): the wait itself holds nothing.
    'const held = setInterval(() => {}, 1000)',
    'let t = Date.now()',
    'const first = await updatesState()',
    'const waited = Date.now() - t',
    't = Date.now()',
    'const second = await updatesState()',
    `process.send({ bound: HELLO_WAIT_MS, first, waited, second, again: Date.now() - t })`,
    'clearInterval(held)',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
    cwd: path.dirname(path.dirname(import.meta.dirname)),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  try {
    return await new Promise<Record<string, unknown>>((resolve) =>
      child.once('message', (m) => resolve(m as Record<string, unknown>)),
    )
  } finally {
    child.kill('SIGKILL')
  }
}

/**
 * As serverUnderTheApp, with a state request waiting for a hello that has not come when SIGTERM does:
 * how it ended, and how long after the SIGTERM.
 */
async function serverStoppedWhileWaiting() {
  const script = [
    `import http from 'node:http'`,
    `import { runnerImport } from 'vite'`,
    `const { module: { BRIDGE, listenForDesktop, updatesState } } = await runnerImport(${JSON.stringify(MODULE)})`,
    'listenForDesktop()',
    'void updatesState()',
    `const server = http.createServer().listen(0, '127.0.0.1')`,
    `process.on('SIGTERM', () => server.close())`,
    `server.on('listening', () => process.send({ channel: BRIDGE, ready: true }))`,
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
    cwd: path.dirname(path.dirname(import.meta.dirname)),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ended = new Promise<string>((resolve) =>
    child.once('exit', (code, sig) => resolve(`exit ${code ?? sig}`)),
  )
  try {
    await new Promise((resolve) => child.once('message', resolve))
    const t = Date.now()
    child.kill('SIGTERM')
    const how = await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r('alive'), 5000))])
    return { how, after: Date.now() - t }
  } finally {
    child.kill('SIGKILL')
  }
}

describe('a request before the app says hello', () => {
  it('answers as a checkout once HELLO_WAIT_MS passes with no hello, and waits no more after that', async () => {
    const r = await serverNeverGreeted()
    expect(r.first).toEqual({ mode: 'checkout' })
    expect(r.waited).toBeGreaterThanOrEqual((r.bound as number) - 50)
    expect(r.waited).toBeLessThan((r.bound as number) + 2000)
    expect(r.second).toEqual({ mode: 'checkout' })
    expect(r.again).toBeLessThan(100)
  }, 30_000)

  it('does not keep the server from ending on SIGTERM while it waits', async () => {
    const { how, after } = await serverStoppedWhileWaiting()
    expect(how).toBe('exit 0')
    expect(after).toBeLessThan(2000)
  }, 30_000)
})

/**
 * What the built server holds for the app: a stand-in channel that records what is sent over it and
 * lets the test say what comes back.
 */
function fakeApp() {
  const listeners: ((message: unknown) => void)[] = []
  const sent: { id: string }[] = []
  const channel: DesktopChannel = {
    send: (message) => {
      sent.push(message as { id: string })
      return true
    },
    on(_event, listener) {
      listeners.push(listener)
    },
  }
  return { channel, sent, say: (message: unknown) => listeners.forEach((l) => l(message)) }
}

const KEPT = Symbol.for('agent-board.desktopUpdates')

describe('a refusal from the app, through the routes', () => {
  it('reaches the browser as the app said it, with its status, though the build holds two copies of the module', async () => {
    // The built server bundles the plugin that listens for the app apart from the routes that ask it:
    // each copy has its own HttpError class, so an `instanceof` check in the routes misses the other's.
    try {
      const app = fakeApp()
      listenForDesktop(app.channel)
      app.say({ channel: BRIDGE, hello: true })
      vi.resetModules()
      const routes = await import('./updates')
      const { api } = await import('./http')
      const handler = api(async () => {
        await routes.installUpdate()
        return new Response('installed')
      })
      const answered = handler({
        request: new Request('http://localhost/api/updates/install', { method: 'POST' }),
      })
      await vi.waitFor(() => expect(app.sent).toHaveLength(1))
      app.say({ channel: BRIDGE, id: app.sent[0].id, ok: false, status: 409, error: 'nothing to install' })
      const res = await answered
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'nothing to install' })
    } finally {
      delete (globalThis as Record<symbol, unknown>)[KEPT]
    }
  })
})

/**
 * As serverStoppedWhileWaiting, but with an HTTP request in flight when SIGTERM comes, as the server
 * has under a poll: its shutdown closes the HTTP server, which waits for that request. How it ended,
 * and how long after the SIGTERM.
 */
async function serverStoppedWithRequestInFlight() {
  const script = [
    `import http from 'node:http'`,
    `import { runnerImport } from 'vite'`,
    `const { module: { BRIDGE, listenForDesktop, updatesState } } = await runnerImport(${JSON.stringify(MODULE)})`,
    'listenForDesktop()',
    `const server = http.createServer(async (req, res) => {`,
    `  process.send({ channel: BRIDGE, inFlight: true })`,
    `  res.end(JSON.stringify(await updatesState()))`,
    `}).listen(0, '127.0.0.1')`,
    `process.on('SIGTERM', () => server.close())`,
    `server.on('listening', () => process.send({ channel: BRIDGE, port: server.address().port }))`,
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
    cwd: path.dirname(path.dirname(import.meta.dirname)),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ended = new Promise<string>((resolve) =>
    child.once('exit', (code, sig) => resolve(`exit ${code ?? sig}`)),
  )
  const listening = new Promise<number>((resolve) =>
    child.on('message', (m) => {
      if (isPort(m)) resolve(m.port)
    }),
  )
  const inFlight = new Promise<void>((resolve) =>
    child.on('message', (m) => {
      if (isInFlight(m)) resolve()
    }),
  )
  try {
    const port = await listening
    // One request on its own connection: a keep-alive socket would hold the server for Node's keep-alive
    // timeout whatever the wait does.
    http
      .get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => res.resume())
      .on('error', () => {})
    await inFlight
    const t = Date.now()
    child.kill('SIGTERM')
    const how = await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r('alive'), 5000))])
    return { how, after: Date.now() - t }
  } finally {
    child.kill('SIGKILL')
  }
}

const isPort = (m: unknown): m is { port: number } =>
  typeof m === 'object' && m !== null && typeof (m as { port?: unknown }).port === 'number'
const isInFlight = (m: unknown): boolean =>
  typeof m === 'object' && m !== null && (m as { inFlight?: unknown }).inFlight === true

describe('a request still waiting for the hello when the server stops', () => {
  it('lets the server end at once on SIGTERM, not after HELLO_WAIT_MS', async () => {
    const { how, after } = await serverStoppedWithRequestInFlight()
    expect(how).toBe('exit 0')
    expect(after).toBeLessThan(1000)
  }, 30_000)
})
