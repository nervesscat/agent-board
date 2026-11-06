// The desktop app: runs the built board (.output/server/index.mjs) under Electron's own Node, shows it
// in a window, and keeps a tray icon to open it again or quit. Closing the window leaves the board
// running for the agents (on Linux, while a tray host shows the icon: closeWindow); Quit stops it and
// frees its port. A server that dies on its own once the board has answered is started again, with
// waits between tries and a cap (onServerExit). README: "The desktop app".
//
// On Linux it runs natively on Wayland in a Wayland session and on X11 otherwise: Electron's default
// since 38 (--ozone-platform=auto), so no switch is set here. Its Wayland app_id and X11 WM_CLASS come
// from desktopName in package.json, which the packages' desktop entry names too (desktop/package.mjs).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron'

import {
  appFolders,
  autostartExec,
  autostartFile,
  closeAction,
  CONFIG_FILE,
  configTemplate,
  ensureWritableDir,
  exitReason,
  isPortFree,
  nearestFolder,
  portBusyMessage,
  readConfigFile,
  resolveSettings,
  restartPlan,
  setAutostart,
  SettingsError,
  tail,
  trayHostPresent,
  withLoginPath,
} from './settings.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const LINUX = process.platform === 'linux'
const folders = appFolders(process.env)
// The config file's folder, the profile's parent: what the messages below call the app's folder.
const home = folders.config
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
  ensureWritableDir(folders.profile)
  app.setPath('userData', folders.profile)
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
// Linux: whether a tray host was there to show the icon when it was made (closeWindow).
let trayShown = !LINUX
let quitting = false
// A failure is being shown: the first one only.
let failed = false
// The end of the server's error output since it last started, for the dialog when it stops.
let serverErr = ''
// The board has answered once: from then on a server that exits on its own is restarted.
let ready = false
// The exits counted towards the cap, and since when the server has answered (restartPlan).
let restarts = { exits: 0, healthySince: /** @type {number | null} */ (null) }
/** @type {ReturnType<typeof setTimeout> | null} */
let restartTimer = null
// The window's page failed to load while the board was down: it is loaded again once it answers.
let pageFailed = false

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
  // The window closes to the tray (closeWindow); only Quit ends the app.
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => {
    quitting = true
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
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
    settings = resolveSettings({
      env: process.env,
      file: readConfigFile(home, configTemplate(process.platform, folders.data)),
      home,
      dataHome: folders.data,
    })
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
  // Linux: the login shell's PATH for the server, looked up while the port is checked.
  const [free, serverEnv] = await Promise.all([
    isPortFree(settings.port),
    withLoginPath(settings.serverEnv, { configPath: settings.configPath }),
  ])
  settings.serverEnv = serverEnv
  if (!free)
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
  if (!(await waitUntilUp(server))) return
  ready = true
  restarts.healthySince = Date.now()
  console.log(`agent-board desktop: the board answers on ${settings.url}`)
  if (LINUX) trayShown = await trayHostPresent()
  createTray()
  if (LINUX) Menu.setApplicationMenu(linuxMenu())
  createWindow()
}

function startServer() {
  const logs = path.join(settings.dataDir, 'logs')
  serverErr = ''
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
    // Elsewhere than Windows, a process group of its own: stopServer ends it with what it started.
    detached: process.platform !== 'win32',
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
  proc.on('exit', (code, signal) => {
    if (server === proc) server = null
    if (!quitting) onServerExit(code, signal)
  })
  // Its output has all arrived: the log files of this start are closed.
  proc.once('close', () => {
    out.end()
    err.end()
  })
}

/**
 * The server exited on its own. Before the board has ever answered, that is a failure to start,
 * shown at once; after, it is started again (restartServer) after a wait that grows with each exit,
 * until restartPlan gives up: then the board stopped, with the end of its last error output.
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
function onServerExit(code, signal) {
  const logs = path.join(settings.dataDir, 'logs')
  const reason = exitReason(code, signal)
  const plan = ready ? restartPlan(restarts, Date.now()) : { exits: 0, delay: null }
  restarts = { exits: plan.exits, healthySince: null }
  if (plan.delay === null) {
    const tried = plan.exits > 1 ? ` It was started again ${plan.exits - 1} times.` : ''
    const exited = code === null && !signal ? 'It exited.' : `It exited with ${reason}.`
    const detail = `${exited}${tried}\n\n${tail(serverErr) || '(no output)'}`
    void fatal('The board stopped.', `${detail}\n\nLogs: ${logs}`, logs, OPEN_LOGS)
    return
  }
  const note = `the board's server exited (${reason}); starting it again in ${plan.delay / 1000} s`
  console.error(`agent-board desktop: ${note}`)
  appendLog(logs, note)
  tray?.setToolTip(`${app.getName()}: restarting the board (${reason})`)
  restartTimer = setTimeout(() => void restartServer(reason), plan.delay)
}

/**
 * Starts the server again after it exited with `reason` and, once it answers, says so without
 * blocking anyone (the tray's tooltip, a notification) and loads the window again if its page failed
 * while the board was down; an open page catches up by itself. Its exit, if it dies again, is
 * onServerExit's.
 * @param {string} reason
 */
async function restartServer(reason) {
  restartTimer = null
  if (quitting) return
  startServer()
  if (!(await waitUntilUp(server))) return
  restarts.healthySince = Date.now()
  const at = new Date().toLocaleTimeString()
  console.log(`agent-board desktop: the board answers again on ${settings.url} (it had exited: ${reason})`)
  appendLog(path.join(settings.dataDir, 'logs'), `the board answers again on ${settings.url}`)
  tray?.setToolTip(`${app.getName()}: ${settings.url} (restarted at ${at} after ${reason})`)
  if (Notification.isSupported())
    new Notification({
      title: app.getName(),
      body: `The board restarted (${reason}).`,
      icon: icon(),
      silent: true,
    }).show()
  if (pageFailed && win && !win.isDestroyed()) {
    pageFailed = false
    win.webContents.reload()
  }
}

/**
 * A line from the app itself in the server's error log, for whoever reads it later. A log that refuses
 * the write is no reason to fail.
 * @param {string} logs
 * @param {string} text
 */
function appendLog(logs, text) {
  try {
    fs.appendFileSync(
      path.join(logs, 'board.err.log'),
      `[agent-board desktop ${new Date().toISOString()}] ${text}\n`,
    )
  } catch {
    // not written
  }
}

/**
 * Polls /api/health until the board answers, `proc` (the server just started) exits, or a minute
 * passes.
 * @param {import('node:child_process').ChildProcess | null} proc
 */
async function waitUntilUp(proc) {
  const health = `http://127.0.0.1:${settings.port}/api/health`
  for (const until = Date.now() + READY_MS; Date.now() < until; ) {
    if (!proc || server !== proc) return false
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
  const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)))
  /** @param {number} ms */
  const within = (ms) => Promise.race([exited, new Promise((r) => setTimeout(() => r(false), ms))])
  if (process.platform === 'win32') {
    if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
    else proc.kill()
    await within(10_000)
    return
  }
  // Its process group: the server and whatever it started that stayed in it. Asked first, then made to.
  signalGroup(proc, 'SIGTERM')
  if (!(await within(10_000))) {
    signalGroup(proc, 'SIGKILL')
    await within(2000)
  }
}

/**
 * @param {import('node:child_process').ChildProcess} proc
 * @param {NodeJS.Signals} signal
 */
function signalGroup(proc, signal) {
  try {
    if (proc.pid) return process.kill(-proc.pid, signal)
  } catch {
    // no group (already gone): the process alone
  }
  proc.kill(signal)
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
    if (process.platform === 'win32') win?.hide()
    else void closeWindow()
  })
  // A page that could not load (the board down for a restart) is loaded again by restartServer; an
  // aborted load (a navigation that replaced it) is no failure.
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) pageFailed = true
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

/**
 * Closing the window on Linux: to the tray while a tray host shows the icon, as on Windows; with none
 * (no waybar tray module, GNOME without its AppIndicator extension), nothing would bring it back, so
 * the app quits and stops the board. The host is asked again each time: it may have gone since.
 */
async function closeWindow() {
  const action = closeAction(trayShown && (await trayHostPresent()))
  if (quitting) return
  if (action === 'hide') win?.hide()
  else app.quit()
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const openInBrowser = () => void shell.openExternal(`${settings.url}/`)

function createTray() {
  // A tray host scales the icon itself on Linux; Windows' notification area wants 16 px.
  tray = new Tray(LINUX ? icon().resize({ width: 32, height: 32 }) : icon().resize({ width: 16, height: 16 }))
  tray.setToolTip(`${app.getName()}: ${settings.url}`)
  tray.setContextMenu(trayMenu())
  tray.on('click', showWindow)
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { label: 'Open in browser', click: openInBrowser },
    ...(LINUX ? [startAtLoginItem()] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
}

/**
 * Linux: the window's own menu (Alt shows it) has what the tray has, for a desktop with no tray host,
 * beside the usual Edit, View and Window menus.
 */
function linuxMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.getName(),
      submenu: [
        { label: 'Open in browser', click: openInBrowser },
        startAtLoginItem(),
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ])
}

const autostart = () => ({
  file: autostartFile(process.env),
  exec: autostartExec(process.env, process.execPath),
  name: app.getName(),
})

/**
 * Linux: Start at login, off until turned on: an entry in ~/.config/autostart that runs what started
 * this app (settings.mjs: autostartExec). Its tick is whether the entry is there.
 * @returns {Electron.MenuItemConstructorOptions}
 */
function startAtLoginItem() {
  return {
    id: 'start-at-login',
    label: 'Start at login',
    type: 'checkbox',
    checked: fs.existsSync(autostart().file),
    click: () => {
      const entry = autostart()
      try {
        setAutostart(!fs.existsSync(entry.file), entry)
      } catch (err) {
        void dialog.showMessageBox({
          type: 'error',
          title: app.getName(),
          message: 'Start at login could not be changed.',
          detail: `${errorText(err)}\n\n${entry.file}`,
        })
      }
      // Both menus show the entry as it now is.
      tray?.setContextMenu(trayMenu())
      Menu.setApplicationMenu(linuxMenu())
    },
  }
}
