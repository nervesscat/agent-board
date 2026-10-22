import { type ChildProcess, execFile, spawn } from 'node:child_process'

import { config } from './config'
import { hostTools, toolProblem } from './hostTools'
import { HttpError } from './http'

const WIN = process.platform === 'win32'
/** More than any report: past this, what claude prints is not a report. */
const MAX_OUTPUT = 4 * 1024 * 1024
/** How much of what claude said on stderr goes into the error. */
const ERROR_TAIL = 500

/**
 * One run of the `claude` CLI in print mode: `config.claudeBin` with `config.claudeArgs` first, then
 * `-p --output-format text`, the prompt written to its stdin (never an argument, so its size is not
 * bounded by the command line). Resolves with what it printed; rejects (502) when it cannot start (one
 * not found says so and how to fix `CLAUDE_BIN`), exits non-zero or outlives `timeoutMs` (`config.claudeTimeoutMs` by default), killed then with
 * whatever it started.
 */
export function runClaude(
  prompt: string,
  { timeoutMs = config.claudeTimeoutMs }: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, [...config.claudeArgs, '-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group off Windows, so what it starts goes with it; taskkill /T does it there.
      detached: !WIN,
    })
    const out: Buffer[] = []
    let outSize = 0
    let err = ''
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      reject(new HttpError(502, message))
    }
    const timer = setTimeout(
      () => fail(`claude did not answer within ${Math.round(timeoutMs / 1000)} s and was stopped`),
      timeoutMs,
    )

    child.on('error', (e) =>
      fail(((e as NodeJS.ErrnoException).code === 'ENOENT' && toolProblem('claude', e)) || cannotRun(e)),
    )
    child.stdout.on('data', (chunk: Buffer) => {
      outSize += chunk.length
      if (outSize > MAX_OUTPUT) fail('claude printed more than a report: stopped it')
      else out.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      err = (err + chunk).slice(-ERROR_TAIL)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        const said = err.trim()
        return fail(`claude exited with ${code ?? signal}${said ? `: ${said}` : ''}`)
      }
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(out).toString('utf8'))
    })
    // It may exit before reading all of it; how it exited says why, so the broken pipe says nothing.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt, 'utf8')
  })
}

/**
 * A start that failed with claude not missing: the last check found it, yet the spawn did not start
 * it. Found as a batch shim (`claude.cmd`) is the usual cause on Windows, which the board starts
 * without a shell and so cannot run: that says so and how to point CLAUDE_BIN at the program itself.
 */
function cannotRun(e: Error): string {
  const said = `could not run claude (${config.claudeBin}): ${e.message}`
  const found = hostTools()?.tools.find((t) => t.name === 'claude')?.path
  if (!found || !/\.(cmd|bat)$/i.test(found)) return said
  return (
    `${said}: claude was found as ${found}, a batch shim the board cannot start directly; ` +
    "set CLAUDE_BIN in .env (config.env for the desktop app) to the full path of claude's .exe, " +
    'then restart the board'
  )
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (WIN) {
    const pid = child.pid
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (e) => {
      if (e) child.kill()
    })
  } else
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
}
