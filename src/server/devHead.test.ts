import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'

/**
 * The head of a page as `vite dev` renders it, with vite.config.ts as the board runs it (`pnpm start`,
 * `pnpm dev`): the inline script that keys the history's entries (KEY_ENTRIES, src/lib/reveal.ts) comes
 * before every stylesheet. A script in the head does not run until a stylesheet before it has loaded, so
 * a #link followed in that time would make an entry before the first one was keyed. Builds are covered
 * by the e2e suite; this is the dev server's own head, which TanStack Start adds a stylesheet to unless
 * told not to.
 */

const root = process.cwd()
// vite dev's route generator rewrites it: put back as it was found.
const routeTree = path.join(root, 'src', 'routeTree.gen.ts')
const routeTreeWas = fs.readFileSync(routeTree)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-dev-head-'))
let server: ChildProcess | undefined
let base = ''
let log = ''

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })

async function waitForPage(url: string, until: number): Promise<string> {
  for (;;) {
    if (server?.exitCode !== null) throw new Error(`vite dev stopped:\n${log}`)
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error(`vite dev did not answer ${url}:\n${log}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

let html = ''
beforeAll(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        // Test mode: no sign-in, on loopback, with throwaway data. Never the board's .env values.
        BOARD_ENV: 'test',
        TEST_HUMAN: 'human',
        PORT: String(port),
        BOARD_URL: base,
        DATA_DIR: path.join(tmp, 'data'),
        CLAUDE_HOME: path.join(tmp, 'home', '.claude'),
        STORAGE: 'local',
        PUBLIC_ORIGIN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const keep = (d: Buffer) => (log = (log + d.toString()).slice(-8_000))
  server.stdout!.on('data', keep)
  server.stderr!.on('data', keep)
  html = await waitForPage(`${base}/`, Date.now() + 150_000)
}, 180_000)

afterAll(async () => {
  if (server?.pid && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once('exit', resolve))
    // Whatever vite dev started goes with it.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'])
    else server.kill('SIGKILL')
    // Its database is open until it is gone.
    await exited
  }
  if (!fs.readFileSync(routeTree).equals(routeTreeWas)) fs.writeFileSync(routeTree, routeTreeWas)
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}, 30_000)

it('runs KEY_ENTRIES before any stylesheet in the dev head, and still links the app stylesheet', async () => {
  const head = html.slice(0, html.indexOf('</head>'))
  const keying = head.indexOf('stopKeyingEntries')
  expect(keying).toBeGreaterThan(-1)
  const sheets = [...head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
  expect(sheets.map((m) => /href="([^"]*)"/.exec(m[0])?.[1])).toEqual(['/src/styles.css'])
  for (const sheet of sheets) expect(sheet.index).toBeGreaterThan(keying)
  // The stylesheet the page links is the app's CSS, as Vite serves it (and hot-reloads it).
  const css = await fetch(`${base}/src/styles.css`, { headers: { Accept: 'text/css' } })
  expect(css.headers.get('content-type')).toMatch(/text\/css/)
  expect(await css.text()).toMatch(/\.bg-background\b/)
})
