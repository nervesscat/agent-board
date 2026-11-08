// The app's updates (README: "Updating the app"): electron-updater against the repo's GitHub Releases,
// driven from the board's Settings page through the server's update routes (src/server/updates.ts),
// which reach this process over the server child's IPC channel (BRIDGE, handleBridgeMessage).
//
// It checks at start and every CHECK_EVERY_MS while the automatic check is on, and downloads and
// installs only when the human asks (install): electron-updater's own autoDownload and
// autoInstallOnAppQuit are off. The download is checked against the sha512 in the release's
// latest.yml / latest-linux.yml by electron-updater, and a mismatch ends in the error state with
// nothing installed. How the update installs follows the package the app came in (packageType):
//   - nsis (Windows, per user) and appimage: the board's server is stopped, then electron-updater's
//     install runs the installer silently, or moves the new AppImage into the old one's folder, and
//     starts the new version as this one quits;
//   - deb, rpm, pacman: electron-updater's Linux package updaters run the package manager through
//     polkit's pkexec while the board still runs; once it installed, the server is stopped and the
//     app relaunches as the new version. With no pkexec, or polkit declining, the board keeps running
//     and the state carries the command to run instead (manualCommand), with the downloaded file's
//     path. No password goes through the app.
// The data folder and config.env are never touched: only the install location changes.
//
// Everything here takes its edges (the updater, spawnSync, the timers, the server's stop and start,
// the app's quit) as arguments, so desktop/updates.test.mjs runs it without Electron.
import fs from 'node:fs'
import path from 'node:path'

import electronUpdater from 'electron-updater'

/** The messages of the update routes and their answers carry this, to tell them from any other. */
export const BRIDGE = 'agent-board:updates'
/** The update settings, beside config.env in the app's folder. */
export const UPDATES_FILE = 'updates.json'
/** How often the automatic check runs once the board is up (and once as it starts). */
export const CHECK_EVERY_MS = 6 * 60 * 60_000
/** @typedef {{ autoCheck: boolean, prereleases: boolean }} UpdateSettings */
/** @type {UpdateSettings} */
export const DEFAULT_UPDATE_SETTINGS = { autoCheck: true, prereleases: false }
/** The package managers each Linux package type installs with, in electron-updater's order. */
export const LINUX_PACKAGE_MANAGERS = {
  deb: ['dpkg', 'apt'],
  rpm: ['zypper', 'dnf', 'yum', 'rpm'],
  pacman: ['pacman'],
}
// pkexec's own exit codes: the human dismissed or polkit refused the authorization (126), or it found
// no authentication agent or could not authenticate (127).
const PKEXEC_REFUSED = new Set([126, 127])

/**
 * The update settings saved in `dir`, the defaults for a file that is missing or cannot be read, and
 * for each value that is not a boolean.
 * @param {string} dir
 * @returns {UpdateSettings}
 */
export function readUpdateSettings(dir) {
  /** @type {Record<string, unknown>} */
  let saved = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, UPDATES_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object') saved = parsed
  } catch {
    // none saved yet, or not JSON: the defaults
  }
  return {
    autoCheck: typeof saved.autoCheck === 'boolean' ? saved.autoCheck : DEFAULT_UPDATE_SETTINGS.autoCheck,
    prereleases:
      typeof saved.prereleases === 'boolean' ? saved.prereleases : DEFAULT_UPDATE_SETTINGS.prereleases,
  }
}

/**
 * Saves the update settings in `dir`, through a temporary file so a crash never leaves half of one.
 * @param {string} dir
 * @param {UpdateSettings} settings
 */
export function writeUpdateSettings(dir, settings) {
  const file = path.join(dir, UPDATES_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** @typedef {'nsis' | 'appimage' | 'deb' | 'rpm' | 'pacman'} PackageType */

/**
 * The package this copy of the app was installed from, as electron-updater picks its updater: on
 * Windows the NSIS installer; on Linux an AppImage when it runs as one (APPIMAGE, set by the AppImage
 * runtime), else the `package-type` file electron-builder writes into the resources of the deb, rpm and
 * pacman packages. Null for a copy that cannot update itself: one not packaged, or unpacked
 * (linux-unpacked, win-unpacked run as they are).
 * @param {{ platform: string, env: NodeJS.ProcessEnv, resourcesPath: string, isPackaged: boolean,
 *   readFile?: (file: string) => string }} o
 * @returns {PackageType | null}
 */
export function packageType({ platform, env, resourcesPath, isPackaged, readFile = readText }) {
  if (!isPackaged) return null
  if (platform === 'win32') {
    // The installer leaves its uninstaller beside the app (named after productName, CrossBoard); an
    // unpacked folder (win-unpacked) has none.
    return isFile(path.join(path.dirname(resourcesPath), 'Uninstall CrossBoard.exe')) ? 'nsis' : null
  }
  if (platform !== 'linux') return null
  if (env.APPIMAGE) return 'appimage'
  let type = ''
  try {
    type = readFile(path.join(resourcesPath, 'package-type')).trim()
  } catch {
    return null
  }
  return type === 'deb' || type === 'rpm' || type === 'pacman' ? type : null
}

/** @param {string} file */
const readText = (file) => fs.readFileSync(file, 'utf8')
/** @param {string} file */
const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false

/**
 * The absolute path of `cmd` in one of PATH's absolute folders, or null. A relative entry is skipped,
 * as electron-updater skips it: a folder the working directory decides could shadow a package manager.
 * @param {string} cmd
 * @param {string | undefined} envPath
 * @param {(file: string) => boolean} [isExecutable]
 */
export function findCommand(cmd, envPath, isExecutable = executable) {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, cmd)
    if (isExecutable(file)) return file
  }
  return null
}

/** @param {string} file */
function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return isFile(file)
  } catch {
    return false
  }
}

/**
 * The package manager a Linux package installs with: the first one there in electron-updater's order,
 * else the first of the list (whose missing command then fails the install, and the manual command
 * names it).
 * @param {'deb' | 'rpm' | 'pacman'} type
 * @param {(cmd: string) => boolean} has
 */
export function packageManager(type, has) {
  const list = LINUX_PACKAGE_MANAGERS[type]
  return list.find(has) ?? list[0]
}

/** A word for a POSIX shell: as it is when it needs no quoting, else in single quotes. @param {string} s */
export function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The command the human runs in a terminal to install a downloaded Linux package themselves, when
 * polkit is not there or declined: by the package manager this system has.
 * @param {'deb' | 'rpm' | 'pacman'} type
 * @param {string} file The downloaded package, an absolute path.
 * @param {(cmd: string) => boolean} has
 */
export function manualCommand(type, file, has) {
  const f = shellQuote(file)
  if (type === 'pacman') return `sudo pacman -U ${f}`
  if (type === 'deb') return has('apt') ? `sudo apt install ${f}` : `sudo dpkg -i ${f}`
  if (has('dnf')) return `sudo dnf install ${f}`
  if (has('zypper')) return `sudo zypper install ${f}`
  if (has('yum')) return `sudo yum install ${f}`
  return `sudo rpm -U ${f}`
}

/** Whether a version is a pre-release (`0.3.0-beta.1`): a suffix after its x.y.z. @param {string} v */
export const isPrerelease = (v) => /^v?\d+\.\d+\.\d+-/.test(v)

/**
 * Release notes as plain text: GitHub's are HTML, a feed's may be a list per version. Tags go, the
 * common entities are decoded, and paragraphs, line breaks and list items become lines; the page shows
 * the text as text, never as markup.
 * @param {unknown} notes
 * @returns {string}
 */
export function notesText(notes) {
  if (Array.isArray(notes))
    return notes
      .map((n) => (n && typeof n === 'object' ? `${n.version ?? ''}\n${notesText(n.note)}`.trim() : ''))
      .filter(Boolean)
      .join('\n\n')
  if (typeof notes !== 'string') return ''
  return notes
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * An error as the Updates section shows it, on one line. A download that did not match the release's sha512 says
 * so in words, with electron-updater's own message after.
 * @param {unknown} err
 */
export function updateError(err) {
  // Its first line: electron-updater's messages go on with the response's headers and a stack.
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
  if (code === 'ERR_CHECKSUM_MISMATCH')
    return `The download did not match the sha512 checksum in the release's metadata, so nothing was installed. ${message}`
  return message
}

/**
 * @typedef {'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing'
 *   | 'manual' | 'error'} UpdateStatus
 * @typedef {{ version: string, notes: string, date: string | null }} Offer
 * @typedef {{ percent: number, transferred: number, total: number }} Progress
 * @typedef {{ mode: 'desktop', installed: string, packageType: PackageType | null, status: UpdateStatus,
 *   newest: Offer | null, progress: Progress | null, error: string | null,
 *   manual: { command: string, file: string } | null, checkedAt: string | null,
 *   settings: UpdateSettings }} UpdatesState
 * @typedef {{ info(message?: unknown): void, warn(message?: unknown): void, error(message?: unknown): void }}
 *   Logger
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding)
 *   => { status: number | null, error?: Error, stderr: string }} SpawnSync
 */

/**
 * The app's updates over an electron-updater updater.
 * @param {{
 *   updater: import('electron-updater').AppUpdater & Pick<import('electron-updater').BaseUpdater, 'install'>,
 *   installed: string,
 *   type: PackageType | null,
 *   settings: UpdateSettings,
 *   saveSettings: (settings: UpdateSettings) => void,
 *   has?: (cmd: string) => string | null,
 *   spawnSync: SpawnSync,
 *   stopServer: () => Promise<void>,
 *   startServer: () => Promise<void>,
 *   releaseLock: () => void,
 *   takeLock: () => void,
 *   relaunch: () => void,
 *   quit: () => void,
 *   timers?: { setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (t: any) => void },
 *   now?: () => Date,
 *   log?: Logger,
 * }} o
 */
export function createUpdates({
  updater,
  installed,
  type,
  settings: initial,
  saveSettings,
  has = (cmd) => findCommand(cmd, process.env.PATH),
  spawnSync,
  stopServer,
  startServer,
  releaseLock,
  takeLock,
  relaunch,
  quit,
  timers = { setInterval, clearInterval },
  now = () => new Date(),
  log = console,
}) {
  let settings = { ...initial }
  /** @type {UpdatesState} */
  let state = {
    mode: 'desktop',
    installed,
    packageType: type,
    status: type ? 'idle' : 'unsupported',
    newest: null,
    progress: null,
    error: null,
    manual: null,
    checkedAt: null,
    settings,
  }
  /** @type {Promise<void> | null} */
  let checking = null
  /** @type {unknown} */
  let timer = null

  // Nothing downloads or installs unless install() asks; never anything older, never a pre-release
  // unless the setting says so (even when the installed version is one: electron-updater would allow
  // them then).
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  updater.allowPrerelease = settings.prereleases
  // A full download every time: the releases publish no blockmaps.
  updater.disableDifferentialDownload = true
  updater.logger = log
  updater.on('download-progress', (/** @type {import('electron-updater').ProgressInfo} */ p) => {
    if (state.status === 'downloading')
      set({ progress: { percent: Math.round(p.percent), transferred: p.transferred, total: p.total } })
  })

  /** @param {Partial<UpdatesState>} change */
  const set = (change) => {
    state = { ...state, ...change }
  }
  const busy = () =>
    state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'
  /** @param {string} cmd */
  const hasCommand = (cmd) => has(cmd) !== null

  /** Asks the feed for a newer release; resolves once the state says what it found. */
  function check() {
    if (checking) return checking
    if (!type || state.status === 'downloading' || state.status === 'installing') return Promise.resolve()
    set({ status: 'checking', error: null })
    checking = (async () => {
      try {
        updater.allowPrerelease = settings.prereleases
        const result = await updater.checkForUpdates()
        const info = result?.updateInfo
        if (!result || !info) {
          // electron-updater is not active for this copy (not packaged, or no AppImage around it).
          set({ status: 'unsupported', newest: null, checkedAt: now().toISOString() })
          return
        }
        const offered = result.isUpdateAvailable && (settings.prereleases || !isPrerelease(info.version))
        log.info(
          `updates: ${info.version} is the newest release${offered ? '' : ' (not offered)'}, ${installed} installed`,
        )
        set({
          status: offered ? 'available' : 'none',
          newest: offered
            ? { version: info.version, notes: notesText(info.releaseNotes), date: info.releaseDate ?? null }
            : null,
          manual: null,
          progress: null,
          checkedAt: now().toISOString(),
        })
      } catch (err) {
        set({ status: 'error', error: updateError(err), checkedAt: now().toISOString() })
      } finally {
        checking = null
      }
    })()
    return checking
  }

  /**
   * Downloads the offered update and installs it (the human's Download and install). Throws at once
   * when there is nothing to install, or it is already under way; else resolves once it is done, or
   * has stopped in the error or the manual state.
   */
  function install() {
    if (!type) throw new UpdateRefused('this copy of the app cannot update itself')
    if (busy()) throw new UpdateRefused(`an update is already ${state.status}`)
    const offer = state.newest
    if (!offer || !['available', 'error', 'manual'].includes(state.status))
      throw new UpdateRefused('there is no update to install: check for updates first')
    set({
      status: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0 },
      error: null,
      manual: null,
    })
    return runInstall(type, offer)
  }

  /**
   * @param {PackageType} type
   * @param {Offer} offer
   */
  async function runInstall(type, offer) {
    /** @type {string} */
    let file
    try {
      const files = await updater.downloadUpdate()
      if (!files[0]) throw new Error('the download gave no file')
      file = files[0]
    } catch (err) {
      set({ status: 'error', error: updateError(err), progress: null })
      return
    }
    log.info(`updates: ${offer.version} downloaded to ${file}; installing (${type})`)
    set({ status: 'installing', progress: null })
    if (type === 'nsis' || type === 'appimage') {
      // The installer, or the new AppImage, starts the new version: the board's server has to be gone
      // first (its port, its database), and the new copy must be able to take the single-instance lock.
      await stopServer()
      let installed = false
      try {
        releaseLock()
        installed = updater.install(true, true)
      } catch (err) {
        log.error(`updates: the install failed: ${updateError(err)}`)
      }
      if (installed) return quit()
      takeLock()
      await startServer()
      set({
        status: 'error',
        error: `The ${offer.version} update could not be installed; see the app's log.`,
      })
      return
    }
    const result = installPackage(type, file)
    if (!result.ok) {
      set({
        status: 'manual',
        error: result.error,
        manual: { command: manualCommand(type, file, hasCommand), file },
      })
      return
    }
    await stopServer()
    relaunch()
    quit()
  }

  /**
   * deb, rpm and pacman: electron-updater's own install for the package type, each command it runs
   * through pkexec (no shell). After polkit declined once nothing more is asked for: electron-updater
   * tries a second command when the first failed (apt-get install -f, pacman -Sy).
   * @param {'deb' | 'rpm' | 'pacman'} type
   * @param {string} file
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  function installPackage(type, file) {
    const pkexec = has('pkexec')
    if (!pkexec)
      return {
        ok: false,
        error: 'pkexec (polkit) is not installed, so the app cannot install the package itself.',
      }
    /** @type {string | null} */
    let declined = null
    /** @param {string[]} argv */
    const run = ([cmd, ...args]) => {
      if (declined) throw new Error(declined)
      if (!cmd) throw new Error('no command to run')
      log.info(`updates: pkexec ${cmd} ${args.join(' ')}`)
      const res = spawnSync(pkexec, ['--disable-internal-agent', has(cmd) ?? cmd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (res.error) {
        declined = `pkexec could not be run: ${res.error.message}`
        throw res.error
      }
      if (res.status !== null && PKEXEC_REFUSED.has(res.status)) {
        declined = `polkit did not authorize the install (pkexec exit ${res.status}).`
        throw new Error(declined)
      }
      if (res.status !== 0) {
        const why = res.stderr.trim().split('\n').slice(-3).join(' ')
        throw new Error(
          `${cmd} ${args.join(' ')} exited with ${res.status ?? 'a signal'}${why ? `: ${why}` : ''}`,
        )
      }
    }
    try {
      const { DebUpdater, RpmUpdater, PacmanUpdater } = electronUpdater
      if (type === 'pacman') PacmanUpdater.installWithCommandRunner(file, run, log)
      else if (type === 'deb')
        DebUpdater.installWithCommandRunner(
          /** @type {'dpkg' | 'apt'} */ (packageManager(type, hasCommand)),
          file,
          run,
          log,
        )
      else
        RpmUpdater.installWithCommandRunner(
          /** @type {'zypper' | 'dnf' | 'yum' | 'rpm'} */ (packageManager(type, hasCommand)),
          file,
          run,
          log,
        )
      return { ok: true }
    } catch (err) {
      const error = declined ?? `The package manager failed: ${updateError(err)}`
      log.warn(`updates: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * Changes the settings and saves them. A change to the pre-releases one checks again: what is offered
   * depends on it.
   * @param {Partial<UpdateSettings>} change
   */
  function setSettings(change) {
    const next = { ...settings }
    if (typeof change.autoCheck === 'boolean') next.autoCheck = change.autoCheck
    if (typeof change.prereleases === 'boolean') next.prereleases = change.prereleases
    saveSettings(next)
    const recheck = next.prereleases !== settings.prereleases
    settings = next
    updater.allowPrerelease = settings.prereleases
    set({ settings })
    if (recheck && type && !busy()) void check()
  }

  return {
    state: () => state,
    check,
    install,
    setSettings,
    /** The check as the board comes up, then every CHECK_EVERY_MS, each while the setting is on. */
    start() {
      if (!type || timer) return
      if (settings.autoCheck) void check()
      timer = timers.setInterval(() => {
        if (settings.autoCheck && !busy()) void check()
      }, CHECK_EVERY_MS)
    },
    stop() {
      if (timer) timers.clearInterval(timer)
      timer = null
    },
  }
}

/** A request the updates refuse as they are (nothing to install, one under way): the route's 409. */
export class UpdateRefused extends Error {}

/** @typedef {ReturnType<typeof createUpdates>} Updates */

/**
 * The answer to one message from the server's update routes, or null for a message that is not one.
 * `state` reads the state; `check` and `install` start (the page follows them by reading the state
 * again), and answer with the state as it is once started; `settings` changes the settings.
 * @param {Updates} updates
 * @param {unknown} msg
 */
export function handleBridgeMessage(updates, msg) {
  if (!msg || typeof msg !== 'object') return null
  const { channel, id, op, body } = /** @type {Record<string, unknown>} */ (msg)
  if (channel !== BRIDGE || typeof id !== 'string') return null
  const reply = (/** @type {Record<string, unknown>} */ r) => ({ channel: BRIDGE, id, ...r })
  try {
    if (op === 'check') void updates.check()
    else if (op === 'install')
      void updates
        .install()
        .catch((err) => console.error(`agent-board desktop: updates: ${updateError(err)}`))
    else if (op === 'settings')
      updates.setSettings(
        body && typeof body === 'object' ? /** @type {Partial<UpdateSettings>} */ (body) : {},
      )
    else if (op !== 'state')
      return reply({ ok: false, status: 400, error: `unknown update request ${String(op)}` })
    return reply({ ok: true, state: updates.state() })
  } catch (err) {
    if (err instanceof UpdateRefused) return reply({ ok: false, status: 409, error: err.message })
    return reply({ ok: false, status: 500, error: updateError(err) })
  }
}
