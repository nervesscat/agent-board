#!/usr/bin/env node
// Smoke test of the packaged desktop app (after `pnpm desktop:package`), locally and in CI:
//
//   pnpm desktop:smoke [--app desktop/dist/win-unpacked] [--port 8240]
//                      [--screenshot window.png] [--busy-screenshot dialog.png]
//                      [--data-dir-screenshot dialog.png]
//
// It copies the unpacked app to a temporary folder outside the repo and runs it there with its own
// AGENT_BOARD_HOME and DATA_DIR, so no pnpm, node, source or live data is involved, then checks that:
//   - the board answers /api/health and the window shows it (signed in through a stand-in gate);
//   - a project made through the API survives a restart (migrations, the Electron-ABI driver);
//   - a second launch exits and brings the first window back;
//   - Quit stops the server and frees the port;
//   - the config file's PORT and DATA_DIR are used when the environment sets none;
//   - a busy port, on loopback or on every interface, is reported (in a dialog, and on stderr, where
//     this reads it), and so is a DATA_DIR that cannot be used.
//
// The passkey-gate the board asks is the one thing stood in for: a loopback server that signs in
// any browser through /login and answers /auth for its cookie and a fixed token, as the gate does.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from '@playwright/test'

import { isPortFree } from './app/settings.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** @param {string} name @param {string} fallback */
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const appSrc = path.resolve(arg('--app', path.join(root, 'desktop', 'dist', 'win-unpacked')))
const port = Number(arg('--port', '8240'))
const screenshot = arg('--screenshot', '')
const busyScreenshot = arg('--busy-screenshot', '')
const dataDirScreenshot = arg('--data-dir-screenshot', '')
const TOKEN = 'gate_smoke'
const SESSION = 'gate_session=smoke'

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed = true
  return ok
}

if (!fs.existsSync(appSrc)) {
  console.error(`no unpacked app at ${appSrc}; run pnpm desktop:package first`)
  process.exit(1)
}
for (const p of [port, port + 1])
  if (!(await isPortFree(p))) {
    console.error(`port ${p} is in use; pick another with --port`)
    process.exit(1)
  }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-smoke-'))
const appDir = path.join(tmp, 'app')
const home = path.join(tmp, 'home')
const dataDir = path.join(tmp, 'data')
console.log(`copying the app to ${appDir}`)
fs.cpSync(appSrc, appDir, { recursive: true })
const exe = path.join(appDir, process.platform === 'win32' ? 'agent-board.exe' : 'agent-board')

// --- the stand-in gate, on both loopbacks so `localhost` reaches it whichever one it tries ---
const gate = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/login') {
    res.writeHead(302, {
      'set-cookie': `${SESSION}; Path=/; HttpOnly`,
      location: url.searchParams.get('rd') ?? '/',
    })
    return res.end()
  }
  if (url.pathname === '/auth') {
    const who =
      req.headers.authorization === `Bearer ${TOKEN}`
        ? 'smoke-agent'
        : (req.headers.cookie ?? '').includes(SESSION)
          ? 'smoke-human'
          : null
    res.writeHead(who ? 200 : 401, who ? { 'x-gate-device': who } : {})
    return res.end()
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => gate.listen(0, '127.0.0.1', () => resolve(null)))
const gatePort = /** @type {net.AddressInfo} */ (gate.address()).port
const gate6 = http.createServer((req, res) => gate.emit('request', req, res))
await new Promise((resolve) => {
  gate6.once('error', resolve) // no IPv6 here: 127.0.0.1 is enough
  gate6.listen(gatePort, '::1', () => resolve(null))
})

/** The environment of a run: everything but what the app decides itself, and `extra`. */
/** @param {Record<string, string>} extra */
function appEnv(extra) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGENT_BOARD_HOME: home, GATE_URL: `http://localhost:${gatePort}`, ...extra }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PORT', 'DATA_DIR', 'BOARD_ENV', 'AUTH', 'BOARD_URL'])
    if (!(key in extra)) delete env[key]
  return env
}

/** @param {number} p */
async function health(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.status
  } catch {
    return 0
  }
}

/** @param {number} p */
async function waitHealthy(p, ms = 90_000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(250))
    if ((await health(p)) === 200) return true
  return false
}

/** @param {number} p @param {string} route @param {RequestInit} init */
const api = (p, route, init = {}) =>
  fetch(`http://127.0.0.1:${p}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
  })

/** @param {Record<string, string | undefined>} env */
async function launch(env) {
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined))
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: /** @type {Record<string, string>} */ (defined),
    timeout: 90_000,
  })
  app.process().stdout?.on('data', (d) => process.stdout.write(`  [app] ${d}`))
  app.process().stderr?.on('data', (d) => process.stderr.write(`  [app] ${d}`))
  return app
}

/** Quits through app.quit(), as the tray's Quit does, and waits for the app to end. */
/** @param {import('@playwright/test').ElectronApplication} app */
async function quit(app) {
  const proc = app.process()
  const exited = new Promise((resolve) =>
    proc.exitCode !== null ? resolve(null) : proc.once('exit', resolve),
  )
  await app.evaluate(({ app: a }) => a.quit()).catch(() => {})
  await Promise.race([exited, sleep(20_000)])
  return proc.exitCode !== null
}

const projectName = `Smoke ${new Date().toISOString()}`
try {
  // 1. First start: health, the window on the board, a project, a second launch, Quit.
  console.log(`\n1. start on :${port} with DATA_DIR=${dataDir}`)
  let app = await launch(appEnv({ PORT: String(port), DATA_DIR: dataDir }))
  check(await waitHealthy(port), `/api/health answers 200 on :${port}`)
  const win = await app.firstWindow()
  await win.waitForURL(`http://localhost:${port}/**`, { timeout: 30_000 })
  await win.waitForLoadState('networkidle')
  check(
    (await win.title()) === 'CrossBoard',
    `the window shows the board (${win.url()}, "${await win.title()}")`,
  )
  const created = await api(port, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: projectName }),
  })
  check(created.status === 201, `a project is created through the API (${created.status})`)
  if (screenshot) {
    // The window again, with the project in its picker.
    await win.reload()
    await win.waitForLoadState('networkidle')
    fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true })
    await win.screenshot({ path: screenshot })
    console.log(`     window screenshot: ${path.resolve(screenshot)}`)
  }
  check(fs.existsSync(path.join(dataDir, 'board.db')), `the database is in DATA_DIR (${dataDir})`)
  check(!fs.existsSync(path.join(home, 'data')), 'nothing is written to the default data folder')
  check(fs.existsSync(path.join(home, 'config.env')), `a config file is written to ${home}`)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
  const second = spawn(exe, [], { env: appEnv({ PORT: String(port), DATA_DIR: dataDir }), stdio: 'ignore' })
  const secondCode = await Promise.race([
    new Promise((r) => second.once('exit', r)),
    sleep(30_000).then(() => 'running'),
  ])
  if (secondCode === 'running') second.kill()
  check(secondCode === 0, `a second launch exits (${secondCode})`)
  await sleep(500)
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
  check(visible === true, 'the second launch shows the first window again')
  check((await health(port)) === 200, 'the first copy still answers')

  check(await quit(app), 'Quit ends the app')
  check(await isPortFree(port), `the port :${port} is free after Quit`)

  // 2. Restart on the same data: the project is still there.
  console.log('\n2. restart on the same data')
  app = await launch(appEnv({ PORT: String(port), DATA_DIR: dataDir }))
  check(await waitHealthy(port), `/api/health answers 200 again`)
  const projects = await (await api(port, '/api/projects')).json()
  check(
    Array.isArray(projects) && projects.some((p) => p.name === projectName),
    `the project survived the restart (${Array.isArray(projects) ? projects.length : 'no list'})`,
  )
  check(await quit(app), 'Quit ends the app')
  check(await isPortFree(port), `the port :${port} is free after Quit`)

  // 3. The config file's port and data folder, with neither in the environment.
  const port2 = port + 1
  const dataDir2 = path.join(tmp, 'data-from-config')
  console.log(`\n3. PORT=${port2} and DATA_DIR from ${path.join(home, 'config.env')}`)
  fs.appendFileSync(path.join(home, 'config.env'), `\nPORT=${port2}\nDATA_DIR=${dataDir2}\n`)
  app = await launch(appEnv({}))
  check(await waitHealthy(port2), `the board answers on the config file's port :${port2}`)
  check(fs.existsSync(path.join(dataDir2, 'board.db')), `the database is in the config file's DATA_DIR`)
  check(await quit(app), 'Quit ends the app')
  check(await isPortFree(port2), `the port :${port2} is free after Quit`)

  // 4. A busy port: reported, not a silent crash; on loopback, or on every interface, which also
  // answers the window's localhost.
  for (const [name, host] of /** @type {const} */ ([
    ['4. busy on 127.0.0.1', '127.0.0.1'],
    ['5. busy on every interface, as listen(port) does', undefined],
  ])) {
    console.log(`\n${name}, :${port}`)
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen({ port, host }, () => resolve(null)))
    await expectDialog(
      { PORT: String(port), DATA_DIR: dataDir },
      `Port ${port} is already in use`,
      'the busy port is reported',
      host ? busyScreenshot : '',
    )
    await new Promise((resolve) => blocker.close(() => resolve(null)))
  }

  // 6. A data folder that cannot be used (a file in its place): reported, not a process with no window.
  console.log('\n6. DATA_DIR names a file')
  const notAFolder = path.join(tmp, 'not-a-folder')
  fs.writeFileSync(notAFolder, '')
  await expectDialog(
    { PORT: String(port), DATA_DIR: notAFolder },
    `Its data folder ${notAFolder} cannot be used`,
    'the unusable data folder is reported',
    dataDirScreenshot,
  )
} catch (err) {
  console.error(err)
  failed = true
} finally {
  gate.close()
  gate6.close()
  // The app's processes are gone; their files may take a moment to let go on Windows.
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
      break
    } catch {
      await sleep(500)
    }
  }
}

console.log(failed ? '\nsmoke test FAILED' : '\nsmoke test passed')
process.exit(failed ? 1 : 0)

/**
 * Starts the app with `extra` and expects it to report `text` (in its dialog, and on stderr, where this
 * reads it), waiting on that dialog rather than ending or running without a window; then ends it.
 * @param {Record<string, string>} extra
 * @param {string} text
 * @param {string} what
 * @param {string} shot Where to save the dialog as a PNG, or ''.
 */
async function expectDialog(extra, text, what, shot) {
  const proc = spawn(exe, [], { env: appEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  proc.stderr.on('data', (d) => (said += d))
  const until = Date.now() + 30_000
  while (Date.now() < until && !said.includes(text) && proc.exitCode === null) await sleep(200)
  check(said.includes(text), what)
  if (shot && process.platform === 'win32' && proc.pid && proc.exitCode === null) {
    await sleep(1500)
    captureWindow(proc.pid, shot)
  }
  check(proc.exitCode === null, 'the app waits on its dialog instead of ending')
  if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  await Promise.race([
    new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r))),
    sleep(10_000),
  ])
}

/** Saves the window `pid` shows (the busy-port dialog) as a PNG, through Win32's PrintWindow. */
/** @param {number} pid @param {string} file */
function captureWindow(pid, file) {
  const out = path.resolve(file)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$target = ${pid}
$found = [IntPtr]::Zero
[W]::EnumWindows({ param($h, $l) $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $target -and [W]::IsWindowVisible($h)) { $script:found = $h; return $false }; return $true }, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { Write-Error 'no window'; exit 1 }
$r = New-Object W+RECT; [void][W]::GetWindowRect($found, [ref]$r)
$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[void][W]::PrintWindow($found, $dc, 2); $g.ReleaseHdc($dc)
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  console.log(
    res.status === 0 ? `     dialog screenshot: ${out}` : `     no dialog screenshot: ${res.stderr.trim()}`,
  )
}
