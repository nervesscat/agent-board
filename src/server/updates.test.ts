import { spawn } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

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
