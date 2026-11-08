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
