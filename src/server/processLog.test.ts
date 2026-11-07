import { spawn } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { errorStack, processLine } from './processLog'

const MODULE = path.join(import.meta.dirname, 'processLog.ts')
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z board pid \d+ /

/**
 * A real Node process that hooks the lines in (and runs `body` after), as the server does: its stderr,
 * how it ended, and its stdout once it printed `ready`, when `signal` is sent to it then.
 */
function run(body: string, signal?: NodeJS.Signals) {
  const script = `import { logProcessEnd } from ${JSON.stringify(MODULE)}\nlogProcessEnd()\n${body}`
  const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += String(c)))
  child.stdout.on('data', (c) => {
    if (signal && String(c).includes('ready')) child.kill(signal)
  })
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) =>
    child.on('close', (code, sig) => resolve({ code, signal: sig, stderr })),
  )
}

describe('processLine', () => {
  it('names the time, the pid, what happened, the uptime and the peak memory', () => {
    const line = processLine('received SIGTERM', new Date('2026-11-04T20:33:47.853Z'))
    expect(line).toMatch(
      new RegExp(
        `^2026-11-04T20:33:47\\.853Z board pid ${process.pid} received SIGTERM uptime=\\d+s maxrss=\\d+MB$`,
      ),
    )
  })
})

describe('errorStack', () => {
  it('is the stack of an Error, and says what anything else was', () => {
    const err = new Error('boom')
    expect(errorStack(err)).toBe(err.stack)
    expect(errorStack('nope')).toBe('non-error value: nope')
    expect(errorStack({ a: 1 })).toBe('non-error value: {"a":1}')
  })
})

describe('logProcessEnd', () => {
  it('SIGTERM with a graceful handler beside it: the line, then that handler ends the process', async () => {
    const r = await run(
      `process.on('SIGTERM', () => { console.error('graceful'); process.exit(0) })\n` +
        `setInterval(() => {}, 1000); console.log('ready')`,
      'SIGTERM',
    )
    expect(r).toMatchObject({ code: 0, signal: null })
    const lines = r.stderr.trim().split('\n')
    expect(lines[0]).toMatch(ISO)
    expect(lines[0]).toMatch(/received SIGTERM uptime=\d+s maxrss=\d+MB$/)
    expect(lines[1]).toBe('graceful')
    expect(lines[2]).toMatch(/board pid \d+ exiting code=0 /)
  })

  it('SIGTERM with a once-listener there before it (as Vite has): left to that listener, not re-raised', async () => {
    const script =
      `process.once('SIGTERM', () => setTimeout(() => { console.error('closed'); process.exit(0) }, 100))\n` +
      `const { logProcessEnd } = await import(${JSON.stringify(MODULE)})\nlogProcessEnd()\n` +
      `setInterval(() => {}, 1000); console.log('ready')`
    const child = spawn(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.stdout.on('data', (c) => String(c).includes('ready') && child.kill('SIGTERM'))
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on('close', (c, s) => resolve([c, s])),
    )
    expect([code, signal]).toEqual([0, null])
    expect(stderr).toMatch(/received SIGTERM uptime=/)
    expect(stderr).toContain('closed')
  })

  it('SIGHUP with nothing else listening still ends the process by the signal, after its line', async () => {
    const r = await run(`setInterval(() => {}, 1000); console.log('ready')`, 'SIGHUP')
    expect(r.signal).toBe('SIGHUP')
    expect(r.stderr).toMatch(/received SIGHUP uptime=/)
  })

  it('hooks in once per process, even from a fresh copy of the module (a dev reload)', async () => {
    const again = JSON.stringify(`${MODULE}?reloaded`)
    const r = await run(
      `const m = await import(${again}); m.logProcessEnd()\n` +
        `setInterval(() => {}, 1000); console.log('ready')`,
      'SIGHUP',
    )
    expect(r.signal).toBe('SIGHUP')
    expect(r.stderr.match(/received SIGHUP/g)).toHaveLength(1)
  })

  it('SIGINT with nothing else listening still ends the process by the signal', async () => {
    const r = await run(`setInterval(() => {}, 1000); console.log('ready')`, 'SIGINT')
    expect(r.signal).toBe('SIGINT')
    expect(r.stderr).toMatch(/received SIGINT uptime=/)
  })

  it('an uncaught exception at startup: its stack, a timestamped line, and the process still fails', async () => {
    const r = await run(`throw new Error('startup failed')`)
    expect(r.code).toBe(1)
    // A module's top-level throw reaches Node as the rejection of its evaluation.
    expect(r.stderr).toMatch(/board pid \d+ (uncaughtException|unhandledRejection) uptime=\d+s/)
    // Its stack, from our line and from Node's own report.
    expect(r.stderr.match(/Error: startup failed\n\s+at /g)?.length).toBeGreaterThanOrEqual(2)
    expect(r.stderr).toMatch(/exiting code=1 /)
  })

  it('an uncaught exception another handler traps (as Nitro does): its line, and the process goes on', async () => {
    const r = await run(
      `process.on('uncaughtException', () => {})\n` +
        `setTimeout(() => { throw new Error('later') }, 10)\n` +
        `setTimeout(() => { console.error('still running'); process.exit(0) }, 200)`,
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/uncaughtException uptime=\d+s maxrss=\d+MB\nError: later\n\s+at /)
    expect(r.stderr).toContain('still running')
  })

  it('an unhandled rejection another handler traps: its line with the stack, and the process goes on', async () => {
    const r = await run(
      `process.on('unhandledRejection', () => {})\n` +
        `Promise.reject(new Error('rejected'))\n` +
        `setTimeout(() => { console.error('still running'); process.exit(0) }, 200)`,
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/unhandledRejection uptime=\d+s maxrss=\d+MB\nError: rejected\n\s+at /)
    expect(r.stderr).toContain('still running')
  })

  it('an unhandled rejection nothing else handles still ends the process, as Node does by default', async () => {
    const r = await run(`Promise.reject(new Error('rejected'))\nsetInterval(() => {}, 1000)`)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/unhandledRejection uptime=/)
    expect(r.stderr).toContain('Error: rejected')
  })
})
