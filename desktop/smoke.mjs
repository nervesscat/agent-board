#!/usr/bin/env node
// Smoke test of the packaged desktop app (after `pnpm desktop:package`), locally and in CI:
//
//   pnpm desktop:smoke [--app desktop/dist/win-unpacked | linux-unpacked] [--port 8240]
//                      [--screenshot window.png] [--busy-screenshot dialog.png]
//                      [--data-dir-screenshot dialog.png] [--app-folder-screenshot dialog.png]
//                      [--unwritable-screenshot dialog.png]
//
// It copies the unpacked app to a temporary folder outside the repo and runs it there with its own
// AGENT_BOARD_HOME and DATA_DIR, so no pnpm, node, source or live data is involved, then checks that:
//   - the board answers /api/health, the window opens on /setup on fresh data, setup signs it in with
//     a passkey, and the signed-in window makes an agent token for the API calls below;
//   - a project made through the API survives a restart (migrations, the Electron-ABI driver);
//   - a second launch exits and brings the first window back;
//   - Quit stops the server and frees the port;
//   - the config file's PORT and DATA_DIR are used when the environment sets none;
//   - a busy port, on loopback or on every interface, is reported (in a dialog, and on stderr, where
//     this reads it), and so are a DATA_DIR and an AGENT_BOARD_HOME that cannot be made or
//     written; closing the dialog ends the app with exit 1;
//   - a second launch after a failure, its window closed, raises nothing in the first copy;
//   - on Linux: the server gets the login shell's PATH (from a .bashrc in a stand-in home), Start at
//     login writes and removes the autostart entry, and closing the window with no tray host ends the
//     app and its server (with one, it hides the window). Run it under a display (`xvfb-run -a`).
//
// On Linux the dialogs are checked through stderr and the app is then killed (no window is closed
// through the window system), and the missing-drive case is Windows only.
//
// The platform's passkeys are the one thing stood in for: Chromium's virtual authenticator (CDP
// WebAuthn) in the window, which says yes at once.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from '@playwright/test'

import { isPortFree, trayHostPresent } from './app/settings.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const LINUX = process.platform === 'linux'
const args = process.argv.slice(2)
/** @param {string} name @param {string} fallback */
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const appSrc = path.resolve(
  arg('--app', path.join(root, 'desktop', 'dist', WIN ? 'win-unpacked' : 'linux-unpacked')),
)
const port = Number(arg('--port', '8240'))
const screenshot = arg('--screenshot', '')
const busyScreenshot = arg('--busy-screenshot', '')
const dataDirScreenshot = arg('--data-dir-screenshot', '')
const appFolderScreenshot = arg('--app-folder-screenshot', '')
const unwritableScreenshot = arg('--unwritable-screenshot', '')
/** The agent token the signed-in window makes in step 1, for the API calls after it. */
let token = ''

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
const exe = path.join(appDir, WIN ? 'agent-board.exe' : 'agent-board')
// Linux: the XDG config folder of every run, where Start at login writes, never the user's own.
const xdgConfig = path.join(tmp, 'xdg-config')

/** The environment of a run: everything but what the app decides itself, and `extra`. */
/** @param {Record<string, string>} extra */
function appEnv(extra) {
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    AGENT_BOARD_HOME: home,
    ...(WIN ? {} : { XDG_CONFIG_HOME: xdgConfig }),
    ...extra,
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'PORT',
    'DATA_DIR',
    'BOARD_ENV',
    'AUTH',
    'BOARD_URL',
    'APPIMAGE',
  ])
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
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
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
  const before = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { accept: 'application/json' },
  })
  check(before.status === 409, `with no account yet the API answers 409 setup required (${before.status})`)
  const win = await app.firstWindow()
  // The window's passkeys: a virtual platform authenticator that says yes at once.
  const cdp = await app.context().newCDPSession(win)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await win.waitForURL(`http://localhost:${port}/setup`, { timeout: 30_000 })
  check(true, `the window opens on the board's own setup page (${win.url()})`)
  await win.getByLabel('Your name on the board').fill('Smoke')
  await win.getByLabel('This device').fill('Smoke window')
  await win.getByRole('button', { name: 'Create passkey' }).click()
  await win.waitForURL(`http://localhost:${port}/`, { timeout: 30_000 })
  await win.waitForLoadState('networkidle')
  check(
    (await win.title()) === 'CrossBoard',
    `setup signs the window in and it shows the board (${win.url()}, "${await win.title()}")`,
  )
  const made = await win.evaluate(async () => {
    const res = await fetch('/api/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke-agent' }),
    })
    return { status: res.status, body: res.ok ? await res.json() : null }
  })
  token = made.body?.token ?? ''
  check(made.status === 201 && token !== '', `the signed-in window makes an agent token (${made.status})`)
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
  if (LINUX) check(appProcesses().length === 0, `nothing of the app runs after Quit (${appProcesses()})`)

  // 2. Restart on the same data: the project is still there.
  console.log('\n2. restart on the same data')
  app = await launch(appEnv({ PORT: String(port), DATA_DIR: dataDir }))
  check(await waitHealthy(port), `/api/health answers 200 again`)
  const win2 = await app.firstWindow()
  await win2.waitForURL(`http://localhost:${port}/`, { timeout: 30_000 })
  check(true, `the window is still signed in after the restart (${win2.url()})`)
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

  // 7, 8. An app folder that cannot be made: reported, not taken for another copy holding the lock.
  const missingDrive = [...'QRSTUVWXYZ'].map((l) => `${l}:\\`).find((d) => !fs.existsSync(d))
  for (const [name, appHome, shot] of [
    ['7. AGENT_BOARD_HOME names a file', notAFolder, appFolderScreenshot],
    ...(process.platform === 'win32' && missingDrive
      ? [['8. AGENT_BOARD_HOME on a missing drive', path.join(missingDrive, 'agent-board-home'), '']]
      : []),
  ]) {
    console.log(`\n${name}`)
    await expectDialog(
      { PORT: String(port), DATA_DIR: dataDir, AGENT_BOARD_HOME: appHome },
      `The app's folder ${appHome} cannot be used`,
      'the unusable app folder is reported',
      shot,
    )
  }

  // 8b. An app folder that exists, its electron folder too, but that refuses writes (a deny-write ACL).
  if (process.platform === 'win32') {
    console.log('\n8b. the app folder refuses writes')
    const lockedHome = path.join(tmp, 'locked-home')
    const lockedProfile = path.join(lockedHome, 'electron')
    fs.mkdirSync(lockedProfile, { recursive: true })
    const who = `${os.userInfo().username}`
    const denied = spawnSync('icacls', [lockedProfile, '/deny', `${who}:(OI)(CI)(W)`], { encoding: 'utf8' })
    check(
      denied.status === 0,
      `writes to ${lockedProfile} are denied (${denied.stdout.trim().split(/\r?\n/)[0]})`,
    )
    try {
      await expectDialog(
        { PORT: String(port), DATA_DIR: dataDir, AGENT_BOARD_HOME: lockedHome },
        `The app's folder ${lockedHome} cannot be used`,
        'the app folder that refuses writes is reported',
        unwritableScreenshot,
      )
    } finally {
      spawnSync('icacls', [lockedProfile, '/remove:d', who], { stdio: 'ignore' })
    }
  } else if (process.getuid?.() !== 0) {
    // The same with the folder's write bits off (root writes through them, so not as root).
    console.log('\n8b. the app folder refuses writes (chmod 555)')
    const lockedHome = path.join(tmp, 'locked-home')
    const lockedProfile = path.join(lockedHome, 'electron')
    fs.mkdirSync(lockedProfile, { recursive: true })
    fs.chmodSync(lockedProfile, 0o555)
    try {
      await expectDialog(
        { PORT: String(port), DATA_DIR: dataDir, AGENT_BOARD_HOME: lockedHome },
        `The app's folder ${lockedHome} cannot be used`,
        'the app folder that refuses writes is reported',
        '',
      )
    } finally {
      fs.chmodSync(lockedProfile, 0o755)
    }
  }

  // 9. A failure shown, its window closed, then a second launch: nothing more goes wrong.
  if (LINUX) {
    console.log('\n9. the board stops, its window is closed, and the app is launched again')
    app = await launch(appEnv({ PORT: String(port), DATA_DIR: dataDir }))
    let said = ''
    app.process().stderr?.on('data', (d) => (said += d))
    check(await waitHealthy(port), '/api/health answers 200')
    await app.firstWindow()
    const serverPid = boardServer()
    check(serverPid > 0, `the board's server is found (${serverPid})`)
    if (serverPid) process.kill(serverPid, 'SIGKILL')
    for (const until = Date.now() + 20_000; Date.now() < until && !said.includes('The board stopped.'); )
      await sleep(200)
    check(said.includes('The board stopped.'), 'the stopped board is reported')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {})
    await sleep(1000)
    const again = spawn(exe, [], { env: appEnv({ PORT: String(port), DATA_DIR: dataDir }), stdio: 'ignore' })
    const code = await Promise.race([
      new Promise((r) => again.once('exit', r)),
      sleep(30_000).then(() => 'running'),
    ])
    if (code === 'running') again.kill()
    check(code === 0, `the second launch exits (${code})`)
    await sleep(1500)
    check(!/Object has been destroyed|Uncaught Exception/.test(said), 'the first copy raises no error')
    check(app.process().exitCode === null, 'the first copy still waits on its dialog')
    await endApp(app.process())
  }
  if (WIN) {
    console.log('\n9. the board stops, its window is closed, and the app is launched again')
    app = await launch(appEnv({ PORT: String(port), DATA_DIR: dataDir }))
    let said = ''
    app.process().stderr?.on('data', (d) => (said += d))
    check(await waitHealthy(port), '/api/health answers 200')
    await app.firstWindow()
    // The main process itself, which owns the windows (what Playwright started may be another).
    const pid = await app.evaluate(() => process.pid)
    const serverPid = boardServer()
    check(serverPid > 0, `the board's server is found (${serverPid})`)
    if (serverPid) spawnSync('taskkill', ['/PID', String(serverPid), '/F'], { stdio: 'ignore' })
    for (const until = Date.now() + 20_000; Date.now() < until && !said.includes('The board stopped.'); )
      await sleep(200)
    check(said.includes('The board stopped.'), 'the stopped board is reported')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await sleep(1000)
    const again = spawn(exe, [], { env: appEnv({ PORT: String(port), DATA_DIR: dataDir }), stdio: 'ignore' })
    const code = await Promise.race([
      new Promise((r) => again.once('exit', r)),
      sleep(30_000).then(() => 'running'),
    ])
    if (code === 'running') again.kill()
    check(code === 0, `the second launch exits (${code})`)
    await sleep(1500)
    check(!/Object has been destroyed|Uncaught Exception/.test(said), 'the first copy raises no error')
    const windows = win32(pid, 'count').trim()
    check(windows === '1', `the first copy shows its dialog and nothing else (${windows} windows)`)
    check(await closesWithCode(app.process(), pid, 1), 'closing the dialog ends the app (exit 1)')
  }

  // 10. Linux: the login shell's PATH for the server, Start at login, and closing the window.
  if (LINUX) await linuxDesktop()
} catch (err) {
  console.error(err)
  failed = true
} finally {
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
 * reads it), waiting on that dialog rather than ending or running without a window; then closes the
 * dialog, which ends the app with exit 1.
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
  check(proc.exitCode === null, `the app waits on its dialog instead of ending (${proc.exitCode})`)
  if (!WIN || !proc.pid) {
    await endApp(proc)
    return
  }
  await sleep(1500)
  if (shot) {
    const out = path.resolve(shot)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    win32(proc.pid, `capture ${out}`)
    console.log(`     dialog screenshot: ${out}`)
  }
  check(await closesWithCode(proc, proc.pid, 1), 'closing the dialog ends the app (exit 1)')
}

/**
 * Closes the windows `pid` shows (a dialog closed is its Quit) and says whether the process then ends
 * with `code`; it is killed if it does not.
 * @param {import('node:child_process').ChildProcess} proc
 * @param {number} pid
 * @param {number} code
 */
async function closesWithCode(proc, pid, code) {
  const exited = new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)))
  win32(pid, 'close')
  await Promise.race([exited, sleep(15_000)])
  const ended = proc.exitCode
  if (ended === null) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  return ended === code
}

/**
 * Linux: a launch with a stand-in home whose .bashrc (read through .bash_profile, as the distributions'
 * own skeletons do) alone puts a tools folder on PATH, from a bare PATH, as a launch from the desktop
 * has: the server's PATH has that folder first. Then Start at login on and off, through the window's
 * menu, and the window closed: with no tray host the app ends with its server, with one it hides.
 */
async function linuxDesktop() {
  console.log('\n10. Linux: the login shell PATH, Start at login, closing the window')
  const loginHome = path.join(tmp, 'login-home')
  const tools = path.join(loginHome, 'tools')
  fs.mkdirSync(tools, { recursive: true })
  fs.writeFileSync(path.join(tools, 'gh'), '#!/bin/sh\necho stand-in gh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(loginHome, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n')
  fs.writeFileSync(path.join(loginHome, '.bashrc'), 'echo "a greeting"\nexport PATH="$HOME/tools:$PATH"\n')
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : ''
  const app = await launch(
    appEnv({ PORT: String(port), DATA_DIR: dataDir, HOME: loginHome, SHELL: shell, PATH: '/usr/bin:/bin' }),
  )
  check(await waitHealthy(port), '/api/health answers 200')
  await app.firstWindow()
  const serverPid = boardServer()
  const environ = serverPid ? fs.readFileSync(`/proc/${serverPid}/environ`, 'utf8').split('\0') : []
  const serverPath = (environ.find((e) => e.startsWith('PATH=')) ?? '').slice('PATH='.length)
  if (shell)
    check(
      serverPath.split(':')[0] === tools && serverPath.split(':').includes('/usr/bin'),
      `the server runs with the login shell's PATH, ${tools} first (${serverPath})`,
    )
  else console.log(`     no /bin/bash: the server's PATH is ${serverPath}`)

  const entry = path.join(xdgConfig, 'autostart', 'agent-board.desktop')
  const toggle = () =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('start-at-login')?.click())
  check(!fs.existsSync(entry), 'Start at login is off at first')
  await toggle()
  const text = fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : ''
  // An unpacked AppImage (install-test.sh) starts through its AppRun, which adds --no-sandbox where needed.
  const appRun = path.join(appDir, 'AppRun')
  const starts = fs.existsSync(appRun) ? appRun : exe
  check(text.includes(`Exec=${starts}\n`), `Start at login writes ${entry}, starting ${starts}`)
  await toggle()
  check(!fs.existsSync(entry), 'turned off, the entry is gone')

  const trayHost = await trayHostPresent()
  const proc = app.process()
  const exited = new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {})
  if (trayHost) {
    await sleep(2000)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
    check(visible === false && (await health(port)) === 200, 'with a tray host, closing the window hides it')
    check(await quit(app), 'Quit ends the app')
  } else {
    await Promise.race([exited, sleep(20_000)])
    check(proc.exitCode !== null, `with no tray host, closing the window ends the app (${proc.exitCode})`)
  }
  check(await isPortFree(port), `the port :${port} is free`)
  check(appProcesses().length === 0, `nothing of the app runs, its server neither (${appProcesses()})`)
}

/**
 * Ends a copy of the app that waits on its dialog (Linux: killed, nothing closes it through the window
 * system), with its children, and waits until it is gone.
 * @param {import('node:child_process').ChildProcess} proc
 */
async function endApp(proc) {
  const exited = new Promise((r) =>
    proc.exitCode !== null || proc.signalCode ? r(null) : proc.once('exit', r),
  )
  proc.kill('SIGKILL')
  await Promise.race([exited, sleep(10_000)])
  for (const pid of appProcesses())
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone already
    }
  for (const until = Date.now() + 10_000; Date.now() < until && appProcesses().length; ) await sleep(200)
}

/**
 * Linux: the processes this run's copy of the app is (its executable, the board's server among them).
 * @returns {number[]}
 */
function appProcesses() {
  if (!LINUX) return []
  const real = fs.realpathSync(exe)
  /** @type {number[]} */
  const pids = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      // A process ends as it is read, or is not this user's.
      if (fs.readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, '') === real) pids.push(Number(name))
    } catch {
      // gone, or not ours
    }
  }
  return pids
}

/**
 * The board's server this run's copy of the app started (its executable running index.mjs), or 0.
 * Playwright's launch does not leave the app as the server's parent process.
 */
function boardServer() {
  if (LINUX) {
    for (const pid of appProcesses()) {
      try {
        if (
          fs
            .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
            .split('\0')
            .some((a) => a.endsWith('index.mjs'))
        )
          return pid
      } catch {
        // gone
      }
    }
    return 0
  }
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' -and $_.CommandLine -like '*index.mjs*' } | Select-Object -First 1).ProcessId`,
    ],
    { encoding: 'utf8' },
  )
  return Number(res.stdout.trim()) || 0
}

/**
 * Acts on the visible top-level windows of `pid` through Win32: `count` prints how many there are,
 * `close` sends each WM_CLOSE, `capture <png>` saves the first through PrintWindow.
 * @param {number} pid
 * @param {string} action
 */
function win32(pid, action) {
  const [verb, ...rest] = action.split(' ')
  const file = rest.join(' ').replace(/'/g, "''")
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
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$target = ${pid}
$found = New-Object System.Collections.ArrayList
[W]::EnumWindows({ param($h, $l) $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $target -and [W]::IsWindowVisible($h)) { [void]$script:found.Add($h) }; return $true }, [IntPtr]::Zero) | Out-Null
switch ('${verb}') {
  'count' { $found.Count }
  'close' { foreach ($h in $found) { [void][W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) } }
  'capture' {
    if ($found.Count -eq 0) { Write-Error 'no window'; exit 1 }
    $r = New-Object W+RECT; [void][W]::GetWindowRect($found[0], [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    [void][W]::PrintWindow($found[0], $dc, 2); $g.ReleaseHdc($dc)
    $bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)
  }
}
`
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  if (res.status !== 0) console.log(`     win32 ${verb} failed: ${res.stderr.trim()}`)
  return res.stdout ?? ''
}
