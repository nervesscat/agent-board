// The desktop app: runs the built board (.output/server/index.mjs) under Electron's own Node, shows it
// in a window, and keeps a tray icon to open it again or quit. Closing the window leaves the board
// running for the agents; Quit stops it and frees its port. README: "Install".
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'

import {
  appHome,
  CONFIG_FILE,
  ensureWritableDir,
  isPortFree,
  nearestFolder,
  portBusyMessage,
  readConfigFile,
  resolveSettings,
  SettingsError,
  tail,
} from './settings.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = appHome(process.env)
const configFile = path.join(home, CONFIG_FILE)
// The built board and its migrations: packed beside the app, or staged by desktop/package.mjs.
const boardDir = app.isPackaged
  ? path.join(process.resourcesPath, 'board')
  : path.resolve(here, '..', '.stage', 'board')
const READY_MS = 60_000
const OPEN_SETTINGS = 'Open the settings file'
const OPEN_LOGS = 'Open the logs folder'
const OPEN_HOME = 'Open the app folder'

/** @param {unknown} err */
function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

// The window's profile (its sign-in, the cache) goes with the config, and so does the
// single-instance lock: one app per folder. A folder that cannot be made or written (AGENT_BOARD_HOME on
// a missing drive or naming a file, a deny-write ACL) would fail the lock as if another copy held it:
// it is reported instead, from a throwaway profile.
/** @type {unknown} */
let homeError = null
try {
  ensureWritableDir(path.join(home, 'electron'))
  app.setPath('userData', path.join(home, 'electron'))
} catch (err) {
  homeError = err
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-profile-')))
}

/** @type {import('./settings.mjs').Settings} */
let settings
/** @type {import('node:child_process').ChildProcess | null} */
let server = null
/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
let quitting = false
// A failure is being shown: the first one only.
let failed = false
// The end of the server's error output, for the dialog when it stops.
let serverErr = ''

if (homeError) {
  void app
    .whenReady()
    .then(() =>
      fatal(
        'The board cannot start.',
        `The app's folder ${home} cannot be used: ${errorText(homeError)}\n\n` +
          'Set AGENT_BOARD_HOME to a folder that can be written, or remove it to use the default.',
        nearestFolder(home),
        OPEN_HOME,
      ),
    )
} else if (!app.requestSingleInstanceLock()) {
  // Another copy runs: it shows its window (second-instance, below), and this one goes.
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  // The window closes to the tray; only Quit ends the app.
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => {
    quitting = true
    if (!server) return
    event.preventDefault()
    void stopServer().then(() => app.quit())
  })
  // Whatever start() did not see coming still ends in a dialog, never in a process with no window
  // that holds the single-instance lock.
  void app
    .whenReady()
    .then(start)
    .catch((/** @type {unknown} */ err) =>
      fatal('The board cannot start.', errorText(err), nearestFolder(home), OPEN_HOME),
    )
}

async function start() {
  try {
    settings = resolveSettings({ env: process.env, file: readConfigFile(home), home })
  } catch (err) {
    if (err instanceof SettingsError)
      return fatal('The board’s settings are not valid.', err.message, configFile, OPEN_SETTINGS)
    // The app's folder, or its config.env, cannot be read or written.
    return fatal(
      'The board cannot start.',
      `${errorText(err)}\n\nThe app's folder: ${home}`,
      nearestFolder(home),
      OPEN_HOME,
    )
  }
  if (!(await isPortFree(settings.port)))
    return fatal(
      'The board cannot start.',
      portBusyMessage(settings.port, configFile),
      configFile,
      OPEN_SETTINGS,
    )
  try {
    fs.mkdirSync(path.join(settings.dataDir, 'logs'), { recursive: true })
  } catch (err) {
    return fatal(
      'The board cannot start.',
      `Its data folder ${settings.dataDir} cannot be used: ${errorText(err)}\n\n` +
        `Set another DATA_DIR in ${configFile}, or in the environment, and start the app again.`,
      configFile,
      OPEN_SETTINGS,
    )
  }
  startServer()
  if (!(await waitUntilUp())) return
  console.log(`agent-board desktop: the board answers on ${settings.url}`)
  createTray()
  createWindow()
}

function startServer() {
  const logs = path.join(settings.dataDir, 'logs')
  const out = fs.createWriteStream(path.join(logs, 'board.out.log'), { flags: 'a' })
  const err = fs.createWriteStream(path.join(logs, 'board.err.log'), { flags: 'a' })
  // The server's output goes on to the app's own too, for whoever started it from a terminal. Nobody
  // may be reading that (started from the Start menu, or its reader gone), and a log file may refuse a
  // write: neither is a reason to fail, and the server's stderr still reaches the dialog.
  for (const stream of /** @type {import('node:stream').Writable[]} */ ([
    process.stdout,
    process.stderr,
    out,
    err,
  ]))
    stream.on('error', () => {})
  // Electron's own executable as Node: the staged better-sqlite3 is built for its ABI.
  server = spawn(process.execPath, [path.join(boardDir, '.output', 'server', 'index.mjs')], {
    // The migrations are read from ./drizzle (src/db/index.ts).
    cwd: boardDir,
    env: { ...settings.serverEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server.stdout?.on('data', (chunk) => {
    out.write(chunk)
    process.stdout.write(chunk)
  })
  server.stderr?.on('data', (chunk) => {
    err.write(chunk)
    process.stderr.write(chunk)
    serverErr = tail(serverErr + String(chunk), 4000)
  })
  const proc = server
  // It could not be started at all (its folder gone, say): no 'exit' follows.
  proc.on('error', (e) => {
    if (server === proc) server = null
    if (!quitting) void fatal('The board cannot start.', `${errorText(e)}\n\nLogs: ${logs}`, logs, OPEN_LOGS)
  })
  proc.on('exit', (code) => {
    if (server === proc) server = null
    if (quitting) return
    const detail = `It exited${code === null ? '' : ` with code ${code}`}.\n\n${tail(serverErr) || '(no output)'}`
    void fatal('The board stopped.', `${detail}\n\nLogs: ${logs}`, logs, OPEN_LOGS)
  })
}

/** Polls /api/health until the board answers, the server exits, or a minute passes. */
async function waitUntilUp() {
  const health = `http://127.0.0.1:${settings.port}/api/health`
  for (const until = Date.now() + READY_MS; Date.now() < until; ) {
    if (!server) return false
    try {
      const res = await fetch(health, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const logs = path.join(settings.dataDir, 'logs')
  await fatal(
    'The board did not start.',
    `It did not answer on ${health} within a minute.\n\nLogs: ${logs}`,
    logs,
    OPEN_LOGS,
  )
  return false
}

/** Stops the server and everything it started, and waits until it is gone so its port is free. */
async function stopServer() {
  const proc = server
  if (!proc || proc.exitCode !== null) return
  const exited = new Promise((resolve) => proc.once('exit', resolve))
  if (process.platform === 'win32' && proc.pid)
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
  else proc.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
}

/**
 * Says what went wrong in a dialog (and on stderr), offers to open the file or folder to fix it, and
 * ends the app, stopping the board first if it runs. Only the first failure is shown.
 * @param {string} message
 * @param {string} detail
 * @param {string | null} target Null when there is nothing to open: the dialog offers Quit alone.
 * @param {string} open The button that opens `target`.
 */
async function fatal(message, detail, target, open) {
  if (failed) return
  failed = true
  quitting = true
  console.error(`agent-board desktop: ${message} ${detail}`)
  try {
    await stopServer()
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: app.getName(),
      message,
      detail,
      buttons: target ? [open, 'Quit'] : ['Quit'],
      defaultId: target ? 1 : 0,
      cancelId: target ? 1 : 0,
      noLink: true,
    })
    if (target && response === 0) await shell.openPath(target)
  } finally {
    app.exit(1)
  }
}

const icon = () => nativeImage.createFromPath(path.join(here, 'icon.png'))

/**
 * Whether the window navigates to a URL itself: the board's own pages, its sign-in (`/setup`, `/login`)
 * among them. Anything else opens in the browser.
 */
function ownOrigin(/** @type {string} */ url) {
  try {
    return new URL(url).origin === new URL(settings.url).origin
  } catch {
    return false
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    title: app.getName(),
    icon: icon(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  win.once('ready-to-show', () => win?.show())
  // Closed for good (once the app is failing or quitting): nothing may show it again.
  win.on('closed', () => {
    win = null
  })
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win?.hide()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (ownOrigin(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  void win.loadURL(`${settings.url}/`)
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray() {
  tray = new Tray(icon().resize({ width: 16, height: 16 }))
  tray.setToolTip(`${app.getName()}: ${settings.url}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: showWindow },
      { label: 'Open in browser', click: () => void shell.openExternal(`${settings.url}/`) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', showWindow)
}
