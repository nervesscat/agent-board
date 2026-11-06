// What the desktop app runs the board with: its folder, its config file, the port and the data folder,
// and the environment the built server starts in. No Electron here, so the tests run it under Node.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** @typedef {Record<string, string | undefined>} Env */

export const DEFAULT_PORT = 47100
export const CONFIG_FILE = 'config.env'

export class SettingsError extends Error {}

/**
 * The app's own folder: its config file and the window's browser profile.
 * `%LOCALAPPDATA%\agent-board` on Windows, `$XDG_CONFIG_HOME/agent-board` (`~/.config/agent-board`)
 * elsewhere; AGENT_BOARD_HOME moves it, as a second copy of the app beside the installed one does
 * (desktop/smoke.mjs). appFolders has the data folder beside it.
 * @param {Env} env
 */
export function appHome(env, platform = process.platform, home = os.homedir()) {
  return appFolders(env, platform, home).config
}

/**
 * @typedef {object} AppFolders
 * @property {string} config The config file's folder (appHome).
 * @property {string} profile The window's browser profile, and the single-instance lock with it.
 * @property {string} data The folder the board's data folder (`data`) and a relative DATA_DIR are in.
 */

/**
 * Where the app keeps its files. On Windows, all of it in `%LOCALAPPDATA%\agent-board`. Elsewhere as
 * the XDG base directories say: the config file and the profile in `$XDG_CONFIG_HOME/agent-board`,
 * the data in `$XDG_DATA_HOME/agent-board` (`~/.config`, `~/.local/share` when unset, or when not an
 * absolute path, which the spec says to ignore). AGENT_BOARD_HOME puts all of it in one folder, on
 * every platform.
 * @param {Env} env
 * @returns {AppFolders}
 */
export function appFolders(env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_BOARD_HOME?.trim()) {
    const one = path.resolve(env.AGENT_BOARD_HOME.trim())
    return { config: one, profile: path.join(one, 'electron'), data: one }
  }
  if (platform === 'win32') {
    const one = path.join(env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'), 'agent-board')
    return { config: one, profile: path.join(one, 'electron'), data: one }
  }
  const config = path.posix.join(
    xdgHome(env.XDG_CONFIG_HOME, path.posix.join(home, '.config')),
    'agent-board',
  )
  const data = path.posix.join(
    xdgHome(env.XDG_DATA_HOME, path.posix.join(home, '.local', 'share')),
    'agent-board',
  )
  return { config, profile: path.posix.join(config, 'electron'), data }
}

/**
 * An XDG base directory variable's value, or `fallback` when it is unset, blank or relative.
 * @param {string | undefined} value
 * @param {string} fallback
 */
const xdgHome = (value, fallback) => {
  const v = value?.trim()
  return v && path.posix.isAbsolute(v) ? v : fallback
}

/**
 * The config file, read as the board reads `.env`: `KEY=value` lines, `#` comments and blank lines
 * skipped, a value in matching single or double quotes taken without them.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseConfig(text) {
  /** @type {Record<string, string>} */
  const values = {}
  for (const [i, raw] of text.replace(/^﻿/, '').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) throw new SettingsError(`line ${i + 1} is not KEY=value: ${line}`)
    let value = m[2]
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '')
    values[m[1]] = value
  }
  return values
}

/** What a new config file says: every key commented out, so the defaults hold until one is set. */
export const CONFIG_TEMPLATE = `# The board's settings, read each time the app starts (KEY=value, as in the repo's .env).
# A variable set in the environment wins over this file.

# Where the board listens, on 127.0.0.1 only. The window opens http://localhost:<PORT>/.
# PORT=47100

# Where the database, uploads and logs live (default: the data folder next to this file).
# DATA_DIR=

# The Claude Code CLI that writes generated reports (default: claude on PATH).
# CLAUDE_BIN=

# The tailnet entrance for your other devices (README: "Using it from other devices").
# PUBLIC_ORIGIN=
`

/**
 * The template for the platform: on Linux the data folder is not next to the file but under
 * `$XDG_DATA_HOME/agent-board` (appFolders), which is where a relative DATA_DIR goes too, and a PATH
 * in the file goes in front of the environment's (withLoginPath).
 * @param {string} dataHome appFolders' data folder.
 */
export function configTemplate(platform = process.platform, dataHome = '') {
  if (platform === 'win32' || !dataHome) return CONFIG_TEMPLATE
  return CONFIG_TEMPLATE.replace(
    'wins over this file.',
    `wins over this file, but for PATH:\n# the folders of a PATH set here go first in the board's PATH (README: "Linux").`,
  ).replace(
    '(default: the data folder next to this file)',
    `(default: ${path.posix.join(dataHome, 'data')}; a relative path is under ${dataHome})`,
  )
}

/**
 * Makes `dir` if it is missing and checks that a file can be written in it, throwing why not. A
 * folder that exists but refuses writes (a deny-write ACL, a read-only share) is as unusable as one
 * that cannot be made.
 * @param {string} dir
 */
export function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  fs.writeFileSync(probe, '')
  fs.rmSync(probe, { force: true })
}

/**
 * The nearest folder at or above `p` that exists: `p` itself when it is a folder, else the closest
 * parent that is one. Never a file. Null when nothing on the way exists (a missing drive).
 * @param {string} p
 * @param {(p: string) => fs.Stats | undefined} stat Stands in for the file system in tests.
 * @returns {string | null}
 */
export function nearestFolder(p, stat = (q) => fs.statSync(q, { throwIfNoEntry: false })) {
  for (let dir = path.resolve(p); ; ) {
    let found
    try {
      found = stat(dir)
    } catch {
      found = undefined // unreadable: look further up
    }
    if (found?.isDirectory()) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The config file's values, written from the template the first time so there is one to edit.
 * @param {string} home
 * @param {string} template What a new file says (configTemplate).
 */
export function readConfigFile(home, template = CONFIG_TEMPLATE) {
  const file = path.join(home, CONFIG_FILE)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(file, template)
  }
  try {
    return parseConfig(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err instanceof SettingsError) throw new SettingsError(`${file}: ${err.message}`)
    throw err
  }
}

/**
 * @typedef {object} Settings
 * @property {number} port
 * @property {string} dataDir
 * @property {string} url The board as the window opens it.
 * @property {Env} serverEnv The environment the built server starts in.
 * @property {string} configPath The config file's PATH ('' when it sets none): on Linux its folders go
 *   first in the server's PATH, whatever the environment's is (withLoginPath).
 */

/**
 * The port, the data folder and the server's environment: the environment wins over the config file,
 * which wins over the defaults (port 47100, `<dataHome>/data`). The board always runs as production on
 * 127.0.0.1, whatever either says: it always signs in with a passkey, and AUTH=off is refused as it starts.
 * @param {{ env: Env, file: Record<string, string>, home: string, dataHome?: string }} input `dataHome`
 *   is appFolders' data folder, where the data folder and a relative DATA_DIR are (`home` when left out).
 * @returns {Settings}
 */
export function resolveSettings({ env, file, home, dataHome = home }) {
  /** @param {string} key */
  const pick = (key) => env[key]?.trim() || file[key]?.trim() || ''
  const rawPort = pick('PORT')
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SettingsError(`PORT must be a whole number from 1 to 65535, got "${rawPort}"`)
  const rawData = pick('DATA_DIR')
  const dataDir = rawData ? expandPath(rawData, dataHome) : path.join(dataHome, 'data')
  const url = `http://localhost:${port}`
  /** @type {Env} */
  const serverEnv = {
    ...file,
    ...env,
    BOARD_ENV: 'production',
    HOST: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    PORT: String(port),
    NITRO_PORT: String(port),
    DATA_DIR: dataDir,
    // The board's address in what it hands agents (Connect an agent): the window's own origin.
    BOARD_URL: pick('BOARD_URL') || url,
  }
  for (const key of ['DEV_HUMAN', 'TEST_HUMAN', 'BOARD_DATA_COPY']) delete serverEnv[key]
  return { port, dataDir, url, serverEnv, configPath: file.PATH?.trim() ?? '' }
}

/**
 * A path from the config file: `~` is the user's home, and a relative one is under the app's folder.
 * @param {string} p
 * @param {string} home
 */
export function expandPath(p, home) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(home, p)
}

const LOOPBACKS = ['127.0.0.1', '::1']

/**
 * Whether nothing listens on `port` on either loopback. The window opens `localhost`, which may reach
 * [::1] first, so a server there and not on 127.0.0.1 would take the window's requests. A program on
 * every interface (`[::]` or `0.0.0.0`) answers on loopback too, yet Windows still lets 127.0.0.1 be
 * bound beside it: so each loopback is both bound and connected to, and either one taken is busy.
 * Nothing is bound off loopback, which would ask the firewall.
 * @param {number} port
 */
export async function isPortFree(port) {
  // The connections first: the bind probes listen for a moment, and must not answer them.
  if (!(await Promise.all(LOOPBACKS.map((host) => refuses(port, host)))).every(Boolean)) return false
  for (const host of LOOPBACKS) if (!(await canBind(port, host))) return false
  return true
}

/**
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
const canBind = (port, host) =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (/** @type {NodeJS.ErrnoException} */ e) =>
      // No IPv6 on this machine: nothing can hold [::1] either.
      resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'),
    )
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })

/**
 * Whether a connection to `host:port` is refused (or cannot be made), rather than taken by a listener.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
const refuses = (port, host) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.setTimeout(2000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    // Nothing answered in time: no listener accepts there.
    socket.once('timeout', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(true))
  })

/**
 * What the busy-port dialog says.
 * @param {number} port
 * @param {string} configFile
 */
export const portBusyMessage = (port, configFile) =>
  `Port ${port} is already in use: another copy of the board, or another program, listens on it. ` +
  `Stop it, or set another PORT in ${configFile}, and start the app again.`

/**
 * The last `max` characters of a log, from a line start where it can: what a dialog shows of it.
 * @param {string} text
 */
export function tail(text, max = 1500) {
  if (text.length <= max) return text.trim()
  const cut = text.slice(-max)
  const nl = cut.indexOf('\n')
  return (nl >= 0 ? cut.slice(nl + 1) : cut).trim()
}

// Linux: what a launch from the desktop does not get on its own (README: "The desktop app").

const PATH_START = '__AGENT_BOARD_PATH_START__'
const PATH_END = '__AGENT_BOARD_PATH_END__'
export const LOGIN_SHELL_MS = 5000

/**
 * @typedef {object} RunResult
 * @property {number | null} code Null when it did not end on its own (timed out, or not started).
 * @property {string} stdout
 */
/** @typedef {(command: string, args: string[], opts: { timeoutMs: number, env: Env }) => Promise<RunResult>} Runner */

/** How long the output of a command that has exited may take to arrive once it has. */
const OUTPUT_GRACE_MS = 250

/**
 * Runs a command to its end, or until `timeoutMs` passes: it gets no input, its stdout is kept (a
 * megabyte at most), its stderr dropped. The answer comes when the command itself exits, with its
 * code and what it printed (waiting at most a moment for the rest of its output), even while
 * something it started in the background (a `.bashrc`'s `sleep 30 &`) still holds its output open;
 * that is left running, and what it prints later is read and dropped (a closed pipe would kill it on
 * its next write), without keeping this process alive. On the timeout, the command still running,
 * its whole process group is killed and the answer given at once.
 * @type {Runner}
 */
export const runCapture = (command, args, { timeoutMs, env }) =>
  new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let proc
    let stdout = ''
    let done = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let grace
    /** @param {Buffer | string} chunk */
    const collect = (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk
    }
    /**
     * @param {number | null} code
     * @param {boolean} [drain] The command has exited: keep draining the pipe for whatever it left in
     *   the background, else close it.
     */
    const finish = (code, drain = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      const out = proc?.stdout
      if (out && drain) {
        // A background child may hold the pipe open for ever and print to it later: it is left alone,
        // so its writes go on being read (and dropped) rather than failing on a closed pipe, and the
        // pipe no longer keeps this process alive.
        out.off('data', collect)
        out.on('error', () => {})
        out.resume()
        // A child's piped stdout is a socket.
        if ('unref' in out && typeof out.unref === 'function') out.unref()
      } else out?.destroy()
      resolve({ code, stdout })
    }
    const timer = setTimeout(() => {
      try {
        if (proc?.pid) process.kill(process.platform === 'win32' ? proc.pid : -proc.pid, 'SIGKILL')
      } catch {
        // already gone
      }
      finish(null)
    }, timeoutMs)
    try {
      proc = spawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch {
      return finish(null)
    }
    proc.stdout?.on('data', collect)
    proc.once('error', () => finish(null))
    proc.once('exit', (code) => {
      // It has exited: the timer no longer kills anything, and the answer waits only for its output.
      clearTimeout(timer)
      if (proc?.stdout?.readableEnded) return finish(code, true)
      grace = setTimeout(() => finish(code, true), OUTPUT_GRACE_MS)
      proc?.stdout?.once('end', () => finish(code, true))
    })
    proc.once('close', (code) => finish(code, true))
  })

/**
 * The PATH a login shell printed between the markers, as its entries; null when the output has no
 * such PATH (the shell failed before it, or is not one that takes `-ilc`). Whatever a profile prints
 * around it (a banner, a greeting) is left out, and so is any entry that is not an absolute path.
 * @param {string} stdout
 * @returns {string[] | null}
 */
export function parseShellPath(stdout) {
  const start = stdout.lastIndexOf(PATH_START)
  if (start < 0) return null
  const end = stdout.indexOf(PATH_END, start)
  if (end < 0) return null
  const entries = stdout
    .slice(start + PATH_START.length, end)
    .split(':')
    .filter((e) => path.posix.isAbsolute(e) && !/[\r\n\0]/.test(e))
  return entries.length ? entries : null
}

/**
 * PATH lists joined in order, each folder once (where it first appears).
 * @param {(string | undefined)[]} lists Each one a `:`-separated PATH.
 */
export function mergePath(...lists) {
  /** @type {string[]} */
  const out = []
  for (const list of lists)
    for (const entry of (list ?? '').split(':')) if (entry && !out.includes(entry)) out.push(entry)
  return out.join(':')
}

/** Where tools a user installs for themselves go, under their home, whatever their profile says. */
export const USER_BINS = ['.local/bin', 'bin', '.local/share/pnpm', '.local/share/mise/shims', '.volta/bin']

/**
 * The PATH the board's server starts with on Linux: what the user's login shell (`$SHELL`, else
 * /bin/sh), run interactive and login, puts on PATH (so `.profile`, `.bashrc`, `.zshrc`, mise or nvm
 * apply, as in a terminal), then `inherited` (what the app was started with), then the user bin folders
 * that exist. A launch from the desktop gets no shell's PATH, and the board runs git, gh, claude, node
 * and pnpm from it. A shell that fails, hangs past `timeoutMs` or prints no PATH leaves `inherited` and
 * those folders.
 * @param {{ env: Env, inherited?: string, home?: string, run?: Runner, timeoutMs?: number,
 *   exists?: (p: string) => boolean }} input
 */
export async function loginShellPath({
  env,
  inherited = env.PATH,
  home = os.homedir(),
  run = runCapture,
  timeoutMs = LOGIN_SHELL_MS,
  exists = fs.existsSync,
}) {
  const given = env.SHELL?.trim()
  const shell = given && path.posix.isAbsolute(given) ? given : '/bin/sh'
  const script = `printf '\\n%s%s%s\\n' '${PATH_START}' "$PATH" '${PATH_END}'`
  /** @type {string[] | null} */
  let login = null
  try {
    const res = await run(shell, ['-ilc', script], { timeoutMs, env })
    if (res.code === 0) login = parseShellPath(res.stdout)
  } catch {
    // no shell to run: the inherited PATH
  }
  const userBins = USER_BINS.map((b) => path.posix.join(home, b)).filter((b) => exists(b))
  return mergePath((login ?? []).join(':'), inherited, userBins.join(':'))
}

/**
 * The folders of a PATH from the config file: `~` is the home folder, and anything that is not then an
 * absolute path (a `$PATH`, which the file does not expand, or a relative folder) is left out.
 * @param {string} list
 * @param {string} home
 */
export function configPathEntries(list, home) {
  return list
    .split(':')
    .map((e) => e.trim())
    .map((e) => (e === '~' ? home : e.startsWith('~/') ? path.posix.join(home, e.slice(2)) : e))
    .filter((e) => path.posix.isAbsolute(e))
}

/**
 * The server's environment with the PATH it runs with: on Linux the config file's PATH folders first
 * (`configPath`, as the README tells a user to set it), then the login shell's, then the one set
 * (loginShellPath); elsewhere as it is.
 * @param {Env} serverEnv
 * @param {{ configPath?: string, home?: string, platform?: NodeJS.Platform,
 *   resolvePath?: (input: { env: Env, inherited?: string }) => Promise<string> }} [opts]
 * @returns {Promise<Env>}
 */
export async function withLoginPath(
  serverEnv,
  { configPath = '', home = os.homedir(), platform = process.platform, resolvePath = loginShellPath } = {},
) {
  if (platform !== 'linux') return serverEnv
  const found = await resolvePath({ env: serverEnv, inherited: serverEnv.PATH })
  return { ...serverEnv, PATH: mergePath(configPathEntries(configPath, home).join(':'), found) }
}

const SNI_WATCHER = 'org.kde.StatusNotifierWatcher'
/** @type {[string, string[]][]} */
const SNI_ASKS = [
  [
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.NameHasOwner',
      SNI_WATCHER,
    ],
  ],
  [
    'dbus-send',
    [
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner',
      `string:${SNI_WATCHER}`,
    ],
  ],
]

/**
 * Whether a tray host (a StatusNotifierItem watcher: waybar's tray module, KDE's panel, GNOME's
 * AppIndicator extension) is on the session bus, asked through gdbus (GLib's, there wherever GTK is)
 * or else dbus-send. No session bus, or neither tool answering: no tray host.
 * @param {Runner} run
 * @param {Env} env
 */
export async function trayHostPresent(run = runCapture, env = process.env) {
  for (const [command, args] of SNI_ASKS) {
    const res = await run(command, args, { timeoutMs: 2000, env }).catch(() => null)
    if (res?.code === 0) return /\btrue\b/.test(res.stdout)
  }
  return false
}

/**
 * What closing the window does: hide it, the board running on, where the tray icon brings it back
 * (always on Windows; on Linux while a tray host shows the icon); else quit, so the app never runs on
 * with no way back to it.
 * @param {boolean} trayHost
 * @returns {'hide' | 'quit'}
 */
export const closeAction = (trayHost, platform = process.platform) =>
  platform === 'win32' || trayHost ? 'hide' : 'quit'

/**
 * The autostart entry's file: `$XDG_CONFIG_HOME/autostart/agent-board.desktop` (`~/.config/autostart`).
 * @param {Env} env
 */
export const autostartFile = (env, home = os.homedir()) =>
  path.posix.join(
    xdgHome(env.XDG_CONFIG_HOME, path.posix.join(home, '.config')),
    'autostart',
    'agent-board.desktop',
  )

/**
 * What starting at login runs: the AppImage itself when the app runs from one (the executable is in a
 * mount that goes when it quits), else the `AppRun` beside the executable when there is one (an AppImage
 * unpacked with `--appimage-extract`: `AppRun` adds `--no-sandbox` where the system blocks user
 * namespaces, and the executable alone stops at start there), else the app's executable. It runs from
 * an AppImage when the executable is inside `$APPDIR`, that image's mount: an installed app started
 * from a terminal some other AppImage opened inherits that image's APPIMAGE and APPDIR, and must not
 * start that one at login. An unpacked image's `AppRun` keeps APPIMAGE and APPDIR to itself, so the
 * app sees neither.
 * @param {Env} env
 * @param {string} execPath
 * @param {(p: string) => boolean} isExecutable Stands in for the file system in tests.
 */
export const autostartExec = (env, execPath, isExecutable = executableFile) => {
  const image = env.APPIMAGE?.trim()
  const mount = env.APPDIR?.trim()
  if (image && path.posix.isAbsolute(image) && mount && path.posix.isAbsolute(mount)) {
    const rel = path.posix.relative(path.posix.resolve(mount), path.posix.resolve(execPath))
    if (rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel)) return image
  }
  const appRun = path.posix.join(path.posix.dirname(execPath), 'AppRun')
  return isExecutable(appRun) ? appRun : execPath
}

/**
 * Whether `p` is a file this user may run.
 * @param {string} p
 */
function executableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * One argument of a desktop entry's Exec, quoted as the spec says when it has to be: in double quotes,
 * with `"`, `` ` ``, `$` and `\` escaped, then every `\` doubled again (the string escape the file's
 * values take before the quoting); `%` doubled either way.
 * @param {string} arg
 */
export function desktopExecArg(arg) {
  const value = arg.replace(/%/g, '%%')
  if (!/[\s"'\\><~|&;$*?#()`]/.test(value)) return value
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\')
}

/**
 * The autostart entry: starts `exec` at login.
 * @param {{ exec: string, name: string }} input
 */
export const autostartEntry = ({ exec, name }) =>
  [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name.replace(/[\r\n]/g, ' ')}`,
    'Comment=Starts the board at login',
    `Exec=${desktopExecArg(exec)}`,
    'Icon=agent-board',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')

/**
 * Turns starting at login on (writes the entry) or off (removes it).
 * @param {boolean} on
 * @param {{ file: string, exec: string, name: string }} entry
 */
export function setAutostart(on, { file, exec, name }) {
  if (!on) return fs.rmSync(file, { force: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, autostartEntry({ exec, name }))
}
