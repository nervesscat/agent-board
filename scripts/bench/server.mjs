// Builds the target checkout into a folder of the harness's own and runs that build as a board in
// test mode (no gate, loopback only, never the live port) on a copy of the data, with the preload
// that counts SQL statements and child processes per request.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIVE_PORT = 47100
const WIN = process.platform === 'win32'
const PRELOAD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.mjs')).href

// --- every process the harness started, stopped on any way out ---

const running = new Set()

/** Kills a process and everything it started (on Windows a build is pnpm → node → workers). */
export function killTree(proc) {
  running.delete(proc)
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return
  if (WIN)
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

export function killAll() {
  for (const proc of [...running]) killTree(proc)
}

function track(proc) {
  running.add(proc)
  proc.once('exit', () => running.delete(proc))
  return proc
}

// --- the build ---

/** `pnpm build` of the target into `outDir` (BOARD_BUILD_DIR); the target's own .output is never used. */
export async function build(target, outDir, log) {
  const config = fs.readFileSync(path.join(target, 'vite.config.ts'), 'utf8')
  if (!config.includes('BOARD_BUILD_DIR'))
    throw new Error(
      `${target} cannot build into a folder of its own (its vite.config.ts has no BOARD_BUILD_DIR), so it is not benchmarked`,
    )
  fs.rmSync(outDir, { recursive: true, force: true })
  const started = Date.now()
  const proc = track(
    spawn('pnpm build --logLevel error', {
      cwd: target,
      shell: true,
      detached: !WIN,
      windowsHide: true,
      env: { ...process.env, BOARD_BUILD_DIR: outDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  const out = []
  proc.stdout.on('data', (d) => out.push(d))
  proc.stderr.on('data', (d) => out.push(d))
  const code = await new Promise((resolve) => proc.once('exit', resolve))
  fs.writeFileSync(log, Buffer.concat(out))
  if (code !== 0) throw new Error(`the build of ${target} failed (exit ${code}); see ${log}`)
  if (!fs.existsSync(path.join(outDir, 'server', 'index.mjs')))
    throw new Error(`the build of ${target} left no ${path.join(outDir, 'server', 'index.mjs')}`)
  return Date.now() - started
}

// --- ports ---

async function isFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, host)
    })
    if (!ok) return false
  }
  return true
}

/** The first free loopback port from `from` (the bench's range starts above the e2e suite's). */
export async function freePort(from = 47200) {
  for (let port = from; port < from + 400; port++) if (port !== LIVE_PORT && (await isFree(port))) return port
  throw new Error(`no free port between ${from} and ${from + 399}`)
}

// --- the server ---

/**
 * An HTTP request with node:http over a kept-alive connection. Not fetch: on Windows undici adds about
 * 15 ms to every request on a reused loopback connection, which would hide the server's own time.
 */
function send(agent, url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Starts the board from the target checkout (migrations load from its drizzle/), in test mode with
 * `human` as the browser's caller, on its own data folder: `build` runs `<buildDir>/server/index.mjs`,
 * `dev` runs `vite dev` as the live board does. Resolves once /api/health answers, with what the
 * harness needs to talk to it. Under `vite dev` the server code runs in Nitro's worker thread, out of
 * the preload's reach, so SQL statements and child processes are not counted there.
 */
export async function startServer({ mode = 'build', target, buildDir, dataDir, port, human, log }) {
  if (port === LIVE_PORT) throw new Error(`${LIVE_PORT} is the live board's port`)
  const baseURL = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    BOARD_ENV: 'test',
    TEST_HUMAN: human,
    AUTH: '',
    HOST: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    PORT: String(port),
    NITRO_PORT: String(port),
    BOARD_URL: baseURL,
    DATA_DIR: dataDir,
    STORAGE: 'local',
    // Like every copy of the board's data: never delete what a shared store holds.
    BOARD_DATA_COPY: '1',
  }
  const out = fs.openSync(log, 'a')
  const started = Date.now()
  const args =
    mode === 'dev'
      ? [
          path.join(target, 'node_modules', 'vite', 'bin', 'vite.js'),
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ]
      : [path.join(buildDir, 'server', 'index.mjs')]
  const proc = track(
    spawn(process.execPath, ['--import', PRELOAD, ...args], {
      cwd: target,
      env,
      detached: !WIN,
      windowsHide: true,
      stdio: ['ignore', out, out, 'ipc'],
    }),
  )
  fs.closeSync(out)

  const waiting = new Map()
  let instrumentation = null
  proc.on('message', (msg) => {
    if (msg?.type === 'instrumentation')
      instrumentation =
        mode === 'dev'
          ? {
              ...msg,
              db: false,
              spawn: false,
              reason: ['not counted under vite dev: the server code runs in a Nitro worker thread'],
            }
          : msg
    const key = msg?.type === 'request' ? msg.id : `${msg?.type}:${msg?.seq}`
    const resolve = waiting.get(key)
    if (resolve) {
      waiting.delete(key)
      resolve(msg)
    }
  })
  const reply = (key, ms = 3000) =>
    new Promise((resolve) => {
      waiting.set(key, resolve)
      setTimeout(() => {
        if (waiting.delete(key)) resolve(null)
      }, ms).unref()
    })

  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 })
  let exited = null
  proc.once('exit', (code) => (exited = code ?? 'signal'))
  for (;;) {
    if (exited !== null) throw new Error(`the bench server exited (${exited}) before it answered; see ${log}`)
    if (Date.now() - started > 120_000) {
      killTree(proc)
      throw new Error(`the bench server did not answer within 2 minutes; see ${log}`)
    }
    try {
      const res = await send(agent, `${baseURL}/api/health`)
      if (res.status === 200) break
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  const startupMs = Date.now() - started

  let seq = 0
  return {
    proc,
    port,
    baseURL,
    startupMs,
    pid: proc.pid,
    get instrumentation() {
      return instrumentation
    },
    /**
     * One request, timed from before it is sent until its body is read, with the SQL statements and
     * child processes it caused (null when the preload could not count them).
     */
    async request(urlPath, { actor, method = 'GET', body, headers = {} } = {}) {
      const id = crypto.randomUUID()
      const counted = reply(id)
      const t0 = performance.now()
      let status = 0
      let bytes = 0
      let text = ''
      try {
        const res = await send(agent, baseURL + urlPath, {
          method,
          body,
          headers: { 'x-bench-req': id, ...(actor && { 'x-test-actor': actor }), ...headers },
        })
        status = res.status
        bytes = res.body.length
        text = res.body.toString('utf8')
      } catch (err) {
        status = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const ms = performance.now() - t0
      const counts = await counted
      return {
        status,
        ms,
        bytes,
        text,
        db: instrumentation?.db && counts ? counts.db : null,
        spawns: instrumentation?.spawn && counts ? counts.spawns : null,
      }
    },
    async memory() {
      const n = ++seq
      proc.send({ type: 'memory', seq: n })
      return reply(`memory:${n}`)
    },
    async background() {
      const n = ++seq
      proc.send({ type: 'background', seq: n })
      return reply(`background:${n}`)
    },
    async stop() {
      agent.destroy()
      killTree(proc)
      if (proc.exitCode === null && proc.signalCode === null)
        await new Promise((resolve) => {
          proc.once('exit', resolve)
          setTimeout(resolve, 5000).unref()
        })
    },
  }
}
