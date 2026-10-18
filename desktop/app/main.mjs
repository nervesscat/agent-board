// The desktop app: runs the built board (.output/server/index.mjs) under Electron's own Node, shows it
// in a window, and keeps a tray icon to open it again or quit. Closing the window leaves the board
// running for the agents; Quit stops it and frees its port. README: "Install".
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'

import {
  appHome,
  CONFIG_FILE,
  isPortFree,
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

// The window's profile (the gate's cookie, the cache) goes with the config, and so does the
// single-instance lock: one app per folder.
app.setPath('userData', path.join(home, 'electron'))

/** @type {import('./settings.mjs').Settings} */
let settings
/** @type {import('node:child_process').ChildProcess | null} */
let server = null
/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
let quitting = false
// The end of the server's error output, for the dialog when it stops.
let serverErr = ''

if (!app.requestSingleInstanceLock()) {
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
  void app.whenReady().then(start)
}

async function start() {
  try {
    settings = resolveSettings({ env: process.env, file: readConfigFile(home), home })
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err
    return fatal('The board’s settings are not valid.', err.message, configFile)
  }
  if (!(await isPortFree(settings.port)))
    return fatal('The board cannot start.', portBusyMessage(settings.port, configFile), configFile)
  startServer()
  if (!(await waitUntilUp())) return
  console.log(`agent-board desktop: the board answers on ${settings.url}`)
  createTray()
  createWindow()
}

function startServer() {
  const logs = path.join(settings.dataDir, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  const out = fs.createWriteStream(path.join(logs, 'board.out.log'), { flags: 'a' })
  const err = fs.createWriteStream(path.join(logs, 'board.err.log'), { flags: 'a' })
  // Electron's own executable as Node: the staged better-sqlite3 is built for its ABI.
  server = spawn(process.execPath, [path.join(boardDir, '.output', 'server', 'index.mjs')], {
    // The migrations are read from ./drizzle (src/db/index.ts).
    cwd: boardDir,
    env: { ...settings.serverEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // The server's output goes on to the app's own too, for whoever started it from a terminal; nobody
  // may be reading it (started from the Start menu, or its reader gone), which is no reason to fail.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
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
  proc.on('exit', (code) => {
    if (server === proc) server = null
    if (quitting) return
    const detail = `It exited${code === null ? '' : ` with code ${code}`}.\n\n${tail(serverErr) || '(no output)'}`
    void fatal('The board stopped.', `${detail}\n\nLogs: ${logs}`, logs)
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
  quitting = true
  await stopServer()
  await fatal(
    'The board did not start.',
    `It did not answer on ${health} within a minute.\n\nLogs: ${logs}`,
    logs,
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
 * ends the app.
 * @param {string} message
 * @param {string} detail
 * @param {string} target
 */
async function fatal(message, detail, target) {
  console.error(`agent-board desktop: ${message} ${detail}`)
  const isFile = path.extname(target) !== ''
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: app.getName(),
    message,
    detail,
    buttons: [isFile ? 'Open the settings file' : 'Open the logs folder', 'Quit'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) await shell.openPath(target)
  app.exit(1)
}

const icon = () => nativeImage.createFromPath(path.join(here, 'icon.png'))

/** Origins the window navigates to itself: the board and the gate's sign-in. Others open in the browser. */
function ownOrigin(/** @type {string} */ url) {
  const origins = [settings.url, settings.serverEnv.GATE_URL || 'http://localhost:47110'].map(
    (u) => new URL(u).origin,
  )
  try {
    return origins.includes(new URL(url).origin)
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
  if (!win) return
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
