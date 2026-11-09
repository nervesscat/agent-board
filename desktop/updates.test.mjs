import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { configureRequestOptions, configureRequestUrl, HttpExecutor } from 'builder-util-runtime'
import electronUpdater from 'electron-updater'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  BRIDGE,
  CHECK_EVERY_MS,
  createUpdates,
  DEFAULT_UPDATE_SETTINGS,
  findCommand,
  handleBridgeMessage,
  isPrerelease,
  manualCommand,
  notesText,
  packageManager,
  packageType,
  readUpdateSettings,
  shellQuote,
  UPDATES_FILE,
  updateError,
  writeUpdateSettings,
} from './app/updates.mjs'

// The updater runs for real here: electron-updater's own updaters (NSIS, AppImage, deb, rpm, pacman)
// against a feed served from 127.0.0.1 in the test (never github.com), its downloads checked against the
// feed's sha512 by electron-updater. What stands in: the app (electron-updater's AppAdapter), its HTTP
// (Node's http in place of Electron's net), pkexec (the spawnSync handed in), and the app's own server
// stop/start, quit and relaunch.

/**
 * Electron's executor (electron-updater's electronHttpExecutor.js) over Node's http: its download is
 * builder-util-runtime's doDownload, which checks the sha512 as the file comes in, as in the app.
 * @extends {HttpExecutor<http.ClientRequest>}
 */
class NodeHttp extends HttpExecutor {
  /** @param {URL} url @param {string} destination @param {any} options */
  download(url, destination, options) {
    return options.cancellationToken.createPromise(
      (/** @type {any} */ resolve, /** @type {any} */ reject, /** @type {any} */ onCancel) => {
        const requestOptions = { headers: options.headers || undefined, redirect: 'manual' }
        configureRequestUrl(url, requestOptions)
        configureRequestOptions(requestOptions)
        const internals = /** @type {any} */ (this)
        internals.doDownload(
          requestOptions,
          {
            destination,
            options,
            onCancel,
            callback: (/** @type {Error | null} */ error) =>
              error == null ? resolve(destination) : reject(error),
            responseHandler: null,
          },
          0,
        )
      },
    )
  }

  /** @param {any} options @param {(res: any) => void} callback */
  createRequest(options, callback) {
    // A connection per request, as each download is: no shared socket to pile timeout listeners on.
    return http.request({ ...options, agent: false }, callback)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-updates-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** The files the feed serves, by name. @type {Map<string, Buffer>} */
const served = new Map()
const requested = /** @type {string[]} */ ([])
const feedServer = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(1))
  requested.push(name)
  const body = served.get(name)
  if (!body) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-length': body.length }).end(body)
})
let feedUrl = ''
beforeAll(async () => {
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (feedServer.address())
  feedUrl = `http://127.0.0.1:${address.port}/`
})
afterAll(() => new Promise((resolve) => feedServer.close(() => resolve(undefined))))
afterEach(() => {
  served.clear()
  requested.length = 0
})

const sha512 = (/** @type {Buffer} */ b) => crypto.createHash('sha512').update(b).digest('base64')
/** A program that writes how it was run into `marker`: an installer or an AppImage that does nothing. */
const program = (/** @type {string} */ marker) =>
  Buffer.from(`#!/bin/sh\necho "$@" "silent=$APPIMAGE_SILENT_INSTALL" > ${shellQuote(marker)}\n`)

/**
 * Serves a release: latest.yml and latest-linux.yml (the same, so any platform reads it) naming
 * `files`, each with its sha512, unless `badSha` says which one gets another file's.
 * @param {{ version: string, files: Record<string, Buffer>, notes?: string, badSha?: string }} o
 */
function release({ version, files, notes = '<p>Fixes &amp; <b>more</b></p>', badSha }) {
  const entries = Object.entries(files).map(([url, body]) => {
    served.set(url, body)
    const sha = url === badSha ? sha512(Buffer.from('not this file')) : sha512(body)
    return `  - url: ${url}\n    sha512: ${sha}\n    size: ${body.length}\n`
  })
  const yml =
    `version: ${version}\nfiles:\n${entries.join('')}path: ${Object.keys(files)[0]}\n` +
    `releaseDate: '2026-11-01T10:00:00.000Z'\nreleaseNotes: '${notes}'\n`
  served.set('latest.yml', Buffer.from(yml))
  served.set('latest-linux.yml', Buffer.from(yml))
}

const linuxFiles = (/** @type {string} */ v) => ({
  [`agent-board-${v}-x86_64.AppImage`]: Buffer.from(`appimage ${v}`),
  [`agent-board_${v}_amd64.deb`]: Buffer.from(`deb ${v}`),
  [`agent-board-${v}.x86_64.rpm`]: Buffer.from(`rpm ${v}`),
  [`agent-board-${v}.pacman`]: Buffer.from(`pacman ${v}`),
})

let dirs = 0
/**
 * One of electron-updater's updaters, as the app has it, on the test's feed.
 * @param {'NsisUpdater' | 'AppImageUpdater' | 'DebUpdater' | 'RpmUpdater' | 'PacmanUpdater'} kind
 * @param {string} [version] The installed version.
 */
function realUpdater(kind, version = '0.2.0') {
  const dir = path.join(tmp, `app-${++dirs}`)
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(dir, 'app-update.yml')
  fs.writeFileSync(config, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: agent-board-updater\n`)
  const app = {
    version,
    name: 'agent-board',
    isPackaged: true,
    appUpdateConfigPath: config,
    userDataPath: dir,
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch: vi.fn(),
    quit: vi.fn(),
    onQuit: () => {},
  }
  const updater = new electronUpdater[kind](null, app)
  // Electron's net is not there: Node's http, to the same feed (the provider takes it as it is made).
  const internals = /** @type {any} */ (updater)
  internals.httpExecutor = new NodeHttp()
  updater.setFeedURL({ provider: 'generic', url: feedUrl })
  updater.disableWebInstaller = true
  return { updater, app, dir }
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

/** A log that keeps its lines by level: the app's log file keeps the error ones (main.mjs). */
function recordingLog() {
  const lines = /** @type {Record<'info' | 'warn' | 'error', string[]>} */ ({ info: [], warn: [], error: [] })
  return {
    lines,
    log: {
      info: (/** @type {unknown} */ m) => void lines.info.push(String(m)),
      warn: (/** @type {unknown} */ m) => void lines.warn.push(String(m)),
      error: (/** @type {unknown} */ m) => void lines.error.push(String(m)),
    },
  }
}

/**
 * The updates over `updater` with the app's edges as spies: `commands` are the ones on PATH (name to
 * path), `pkexec` answers each run of pkexec.
 * @param {{ updater: any, type: import('./app/updates.mjs').PackageType | null, installed?: string,
 *   settings?: import('./app/updates.mjs').UpdateSettings, commands?: Record<string, string>,
 *   pkexec?: (args: string[]) => { status: number | null, error?: Error, stderr?: string },
 *   log?: import('./app/updates.mjs').Logger }} o
 */
function setup({
  updater,
  type,
  installed = '0.2.0',
  settings = DEFAULT_UPDATE_SETTINGS,
  commands = {},
  pkexec,
  log = quiet,
}) {
  const order = /** @type {string[]} */ ([])
  const edges = {
    saveSettings: vi.fn(),
    spawnSync: vi.fn((/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      order.push(`spawn ${cmd} ${args.join(' ')}`)
      const r = pkexec ? pkexec(args) : { status: 0 }
      return { stderr: '', ...r }
    }),
    stopServer: vi.fn(async () => void order.push('stopServer')),
    startServer: vi.fn(async () => void order.push('startServer')),
    releaseLock: vi.fn(() => void order.push('releaseLock')),
    takeLock: vi.fn(() => void order.push('takeLock')),
    relaunch: vi.fn(() => void order.push('relaunch')),
    quit: vi.fn(() => void order.push('quit')),
  }
  const timers = { setInterval: vi.fn(() => 'timer'), clearInterval: vi.fn() }
  const updates = createUpdates({
    updater,
    installed,
    type,
    settings,
    has: (cmd) => commands[cmd] ?? null,
    timers,
    log,
    ...edges,
  })
  return { updates, edges, timers, order }
}

describe('the update settings', () => {
  it('are the defaults until saved: automatic check on, pre-releases off', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'settings-'))
    expect(readUpdateSettings(dir)).toEqual({ autoCheck: true, prereleases: false })
    expect(DEFAULT_UPDATE_SETTINGS).toEqual({ autoCheck: true, prereleases: false })
  })

  it('are saved in updates.json and read back', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'settings-'))
    writeUpdateSettings(dir, { autoCheck: false, prereleases: true })
    expect(JSON.parse(fs.readFileSync(path.join(dir, UPDATES_FILE), 'utf8'))).toEqual({
      autoCheck: false,
      prereleases: true,
    })
    expect(readUpdateSettings(dir)).toEqual({ autoCheck: false, prereleases: true })
    expect(fs.readdirSync(dir)).toEqual([UPDATES_FILE])
  })

  it('fall back to the defaults for a broken file or a value that is not a boolean', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'settings-'))
    fs.writeFileSync(path.join(dir, UPDATES_FILE), '{ not json')
    expect(readUpdateSettings(dir)).toEqual(DEFAULT_UPDATE_SETTINGS)
    fs.writeFileSync(path.join(dir, UPDATES_FILE), JSON.stringify({ autoCheck: 'no', prereleases: true }))
    expect(readUpdateSettings(dir)).toEqual({ autoCheck: true, prereleases: true })
  })
})

describe('packageType', () => {
  const resources = path.join(tmp, 'resources')
  const linux = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {string | null} */ file) =>
    packageType({
      platform: 'linux',
      env,
      resourcesPath: resources,
      isPackaged: true,
      readFile: (f) => {
        expect(f).toBe(path.join(resources, 'package-type'))
        if (file === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return file
      },
    })

  it('reads the package-type file electron-builder writes into deb, rpm and pacman packages', () => {
    expect(linux({}, 'deb\n')).toBe('deb')
    expect(linux({}, 'rpm')).toBe('rpm')
    expect(linux({}, 'pacman')).toBe('pacman')
    expect(linux({}, 'snap')).toBeNull()
  })

  it('is an AppImage when the AppImage runtime set APPIMAGE, and nothing for an unpacked copy', () => {
    expect(linux({ APPIMAGE: '/home/me/agent-board-0.2.0-x86_64.AppImage' }, null)).toBe('appimage')
    expect(linux({}, null)).toBeNull()
  })

  it("is NSIS on Windows when the installer's uninstaller is beside the app, else nothing", () => {
    const installedDir = fs.mkdtempSync(path.join(tmp, 'win-'))
    fs.mkdirSync(path.join(installedDir, 'resources'))
    const win = () =>
      packageType({
        platform: 'win32',
        env: {},
        resourcesPath: path.join(installedDir, 'resources'),
        isPackaged: true,
      })
    expect(win()).toBeNull()
    fs.writeFileSync(path.join(installedDir, 'Uninstall CrossBoard.exe'), '')
    expect(win()).toBe('nsis')
  })

  it('is nothing when the app is not packaged, or on another platform', () => {
    expect(
      packageType({
        platform: 'linux',
        env: { APPIMAGE: '/a' },
        resourcesPath: resources,
        isPackaged: false,
      }),
    ).toBeNull()
    expect(
      packageType({ platform: 'darwin', env: {}, resourcesPath: resources, isPackaged: true }),
    ).toBeNull()
  })
})

describe('the manual command', () => {
  const file = '/home/me/.cache/agent-board-updater/pending/agent-board_0.3.0_amd64.deb'
  const only =
    (/** @type {string[]} */ ...cmds) =>
    (/** @type {string} */ c) =>
      cmds.includes(c)

  it('names the package manager this system has, with the downloaded file', () => {
    expect(manualCommand('pacman', '/c/agent-board-0.3.0.pacman', only('pacman'))).toBe(
      'sudo pacman -U /c/agent-board-0.3.0.pacman',
    )
    expect(manualCommand('deb', file, only('apt', 'dpkg'))).toBe(`sudo apt install ${file}`)
    expect(manualCommand('deb', file, only('dpkg'))).toBe(`sudo dpkg -i ${file}`)
    expect(manualCommand('rpm', '/c/a.rpm', only('dnf', 'rpm'))).toBe('sudo dnf install /c/a.rpm')
    expect(manualCommand('rpm', '/c/a.rpm', only('zypper', 'rpm'))).toBe('sudo zypper install /c/a.rpm')
    expect(manualCommand('rpm', '/c/a.rpm', only('rpm'))).toBe('sudo rpm -U /c/a.rpm')
  })

  it('quotes a path the shell would split or expand', () => {
    expect(manualCommand('pacman', "/home/o'neil/my cache/a.pacman", only())).toBe(
      `sudo pacman -U '/home/o'\\''neil/my cache/a.pacman'`,
    )
  })

  it("picks the package manager in electron-updater's order", () => {
    expect(packageManager('deb', only('apt', 'dpkg'))).toBe('dpkg')
    expect(packageManager('deb', only('apt'))).toBe('apt')
    expect(packageManager('rpm', only('rpm', 'dnf'))).toBe('dnf')
    expect(packageManager('rpm', only())).toBe('zypper')
  })
})

describe('findCommand', () => {
  it('looks in the absolute folders of PATH only', () => {
    const seen = /** @type {string[]} */ ([])
    const exe = (/** @type {string} */ f) => (seen.push(f), f === path.join('/usr/bin', 'pkexec'))
    expect(findCommand('pkexec', ['bin', '/opt/x', '/usr/bin'].join(path.delimiter), exe)).toBe(
      path.join('/usr/bin', 'pkexec'),
    )
    expect(seen).toEqual([path.join('/opt/x', 'pkexec'), path.join('/usr/bin', 'pkexec')])
    expect(findCommand('pkexec', undefined, exe)).toBeNull()
  })
})

describe('notes and versions', () => {
  it('turns release notes into plain text', () => {
    expect(notesText('<h2>What&#39;s new</h2><ul><li>a &lt;b&gt;</li><li>c</li></ul>')).toBe(
      "What's new\n\n- a <b>\n- c",
    )
    expect(notesText([{ version: '0.3.0', note: '<p>x</p>' }])).toBe('0.3.0\nx')
    expect(notesText(null)).toBe('')
  })

  it('tells a pre-release by its suffix', () => {
    expect(isPrerelease('0.3.0-beta.1')).toBe(true)
    expect(isPrerelease('0.3.0')).toBe(false)
  })
})

describe('checking against a feed', () => {
  it('Check now finds the feed’s newer version and its notes, and downloads nothing', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('DebUpdater')
    const download = vi.spyOn(updater, 'downloadUpdate')
    const { updates, edges } = setup({ updater, type: 'deb' })
    expect(updates.state().status).toBe('idle')
    const done = updates.check()
    expect(updates.state().status).toBe('checking')
    await done
    expect(updates.state()).toMatchObject({
      mode: 'desktop',
      installed: '0.2.0',
      status: 'available',
      newest: { version: '0.3.0', notes: 'Fixes & more', date: '2026-11-01T10:00:00.000Z' },
      error: null,
    })
    expect(updates.state().checkedAt).not.toBeNull()
    // Found, not fetched: the feed was asked for its metadata only, and nothing ran.
    expect(requested).toEqual(['latest-linux.yml'])
    expect(download).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, 'cache', 'agent-board-updater', 'pending'))).toBe(false)
    expect(edges.spawnSync).not.toHaveBeenCalled()
    expect(edges.stopServer).not.toHaveBeenCalled()
    // electron-updater's own downloads and installs are off.
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
  })

  it('offers nothing when the feed has the installed version, or an older one', async () => {
    release({ version: '0.2.0', files: linuxFiles('0.2.0') })
    const { updates } = setup({ updater: realUpdater('DebUpdater').updater, type: 'deb' })
    await updates.check()
    expect(updates.state()).toMatchObject({ status: 'none', newest: null })
    release({ version: '0.1.0', files: linuxFiles('0.1.0') })
    await updates.check()
    expect(updates.state()).toMatchObject({ status: 'none', newest: null })
  })

  it('offers no pre-release by default, even to a pre-release install; the setting opts in', async () => {
    release({ version: '0.3.0-beta.1', files: linuxFiles('0.3.0-beta.1') })
    for (const installed of ['0.2.0', '0.2.0-beta.1']) {
      const { updater } = realUpdater('DebUpdater', installed)
      const { updates } = setup({ updater, type: 'deb', installed })
      expect(updater.allowPrerelease).toBe(false)
      await updates.check()
      expect(updates.state(), installed).toMatchObject({ status: 'none', newest: null })
      expect(() => updates.install()).toThrow(/no update to install/)
    }
    const { updater } = realUpdater('DebUpdater')
    const { updates, edges } = setup({ updater, type: 'deb' })
    await updates.check()
    updates.setSettings({ prereleases: true })
    expect(edges.saveSettings).toHaveBeenCalledWith({ autoCheck: true, prereleases: true })
    expect(updater.allowPrerelease).toBe(true)
    // Changing it checks again.
    expect(updates.state().status).toBe('checking')
    await updates.check()
    expect(updates.state()).toMatchObject({ status: 'available', newest: { version: '0.3.0-beta.1' } })
  })

  it('a change of the pre-releases setting during a check checks again once that check ends', async () => {
    // As the GitHub provider does: which release is the newest depends on allowPrerelease as the check
    // asks. A check that is held until the test lets it answer.
    /** @type {(() => void)[]} */
    const answer = []
    const asked = /** @type {boolean[]} */ ([])
    const updater = Object.assign(new EventEmitter(), {
      allowPrerelease: false,
      checkForUpdates: vi.fn(async () => {
        const pre = updater.allowPrerelease
        asked.push(pre)
        await new Promise((resolve) => answer.push(() => resolve(undefined)))
        return { isUpdateAvailable: true, updateInfo: { version: pre ? '0.3.0-beta.1' : '0.2.5' } }
      }),
    })
    const { updates } = setup({ updater, type: 'deb' })
    const first = updates.check()
    await vi.waitFor(() => expect(answer).toHaveLength(1))
    updates.setSettings({ prereleases: true })
    // Not two checks at once: the one under way goes on, asking with the old setting.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    answer[0]?.()
    await vi.waitFor(() => expect(answer).toHaveLength(2))
    expect(updates.state().status).toBe('checking')
    answer[1]?.()
    await first
    expect(asked).toEqual([false, true])
    expect(updates.state()).toMatchObject({ status: 'available', newest: { version: '0.3.0-beta.1' } })
  })

  it('ends a check the feed cannot answer in the error state', async () => {
    const { updates } = setup({ updater: realUpdater('DebUpdater').updater, type: 'deb' })
    await updates.check()
    expect(updates.state().status).toBe('error')
    expect(updates.state().error).toMatch(/latest-linux\.yml|404/)
  })

  it('does nothing for a copy that cannot update itself', async () => {
    const updater = { ...new EventEmitter(), on: vi.fn(), checkForUpdates: vi.fn() }
    const { updates, timers } = setup({ updater, type: null })
    expect(updates.state().status).toBe('unsupported')
    await updates.check()
    updates.start()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(timers.setInterval).not.toHaveBeenCalled()
    expect(() => updates.install()).toThrow(/cannot update itself/)
  })
})

describe('the automatic check', () => {
  /** An updater that answers every check with no update, counting them. */
  const counting = () => {
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } })),
    })
    return updater
  }

  it('checks as the board comes up and then every six hours; quitting clears the timer', async () => {
    const updater = counting()
    const { updates, timers } = setup({ updater, type: 'deb' })
    updates.start()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), CHECK_EVERY_MS)
    expect(CHECK_EVERY_MS).toBe(6 * 60 * 60 * 1000)
    const tick = /** @type {() => void} */ (/** @type {any} */ (timers.setInterval.mock.calls[0])[0])
    await updates.check()
    tick()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    // Started once only.
    updates.start()
    expect(timers.setInterval).toHaveBeenCalledTimes(1)
    updates.stop()
    expect(timers.clearInterval).toHaveBeenCalledWith('timer')
  })

  it('with the setting off checks neither at start nor on the timer; Check now still does', async () => {
    const updater = counting()
    const { updates, timers } = setup({
      updater,
      type: 'deb',
      settings: { autoCheck: false, prereleases: false },
    })
    updates.start()
    const tick = /** @type {() => void} */ (/** @type {any} */ (timers.setInterval.mock.calls[0])[0])
    tick()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await updates.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    // Turned on again, the next tick checks; a change of it alone does not check.
    updates.setSettings({ autoCheck: true })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    tick()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})

describe('Download and install', () => {
  /**
   * @param {any} updater
   * @param {Omit<Parameters<typeof setup>[0], 'updater'>} over
   */
  async function offered(updater, over) {
    const s = setup({ ...over, updater })
    await s.updates.check()
    expect(s.updates.state().status).toBe('available')
    return s
  }
  const pending = (/** @type {string} */ dir, /** @type {string} */ file) =>
    path.join(dir, 'cache', 'agent-board-updater', 'pending', file)

  it('refuses a download whose sha512 does not match the metadata: nothing installs', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0'), badSha: 'agent-board_0.3.0_amd64.deb' })
    const { updater, dir } = realUpdater('DebUpdater')
    const install = vi.spyOn(updater, 'install')
    const { updates, edges } = await offered(updater, {
      type: 'deb',
      commands: { pkexec: '/usr/bin/pkexec', dpkg: '/usr/bin/dpkg' },
    })
    const done = updates.install()
    expect(updates.state().status).toBe('downloading')
    await done
    expect(requested).toContain('agent-board_0.3.0_amd64.deb')
    expect(updates.state()).toMatchObject({ status: 'error', manual: null, progress: null })
    expect(updates.state().error).toMatch(
      /sha512 checksum in the release's metadata, so nothing was installed/,
    )
    expect(edges.spawnSync).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    for (const edge of ['stopServer', 'releaseLock', 'relaunch', 'quit'])
      expect(/** @type {any} */ (edges)[edge], edge).not.toHaveBeenCalled()
    expect(fs.existsSync(pending(dir, 'agent-board_0.3.0_amd64.deb'))).toBe(false)
  })

  it('refuses a mismatched installer on Windows too, before the installer would run', async () => {
    release({
      version: '0.3.0',
      files: { 'agent-board-setup-0.3.0.exe': Buffer.from('MZ installer 0.3.0') },
      badSha: 'agent-board-setup-0.3.0.exe',
    })
    const { updater } = realUpdater('NsisUpdater')
    const install = vi.spyOn(updater, 'install')
    const spawned = vi.spyOn(/** @type {any} */ (updater), 'spawnLog').mockResolvedValue(true)
    const { updates, edges } = await offered(updater, { type: 'nsis' })
    await updates.install()
    expect(updates.state().status).toBe('error')
    expect(updates.state().error).toMatch(/sha512/)
    expect(install).not.toHaveBeenCalled()
    expect(spawned).not.toHaveBeenCalled()
    expect(edges.stopServer).not.toHaveBeenCalled()
  })

  it('deb: installs the deb (not another package of the release) with dpkg through pkexec, then restarts', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('DebUpdater')
    const { updates, edges, order } = await offered(updater, {
      type: 'deb',
      commands: { pkexec: '/usr/bin/pkexec', dpkg: '/usr/bin/dpkg', apt: '/usr/bin/apt' },
    })
    await updates.install()
    const file = pending(dir, 'agent-board_0.3.0_amd64.deb')
    expect(fs.readFileSync(file, 'utf8')).toBe('deb 0.3.0')
    expect(edges.spawnSync).toHaveBeenCalledWith(
      '/usr/bin/pkexec',
      ['--disable-internal-agent', '/usr/bin/dpkg', '-i', file],
      expect.objectContaining({ encoding: 'utf8' }),
    )
    // The package is in before the board stops: a declined polkit leaves it running.
    expect(order).toEqual([
      `spawn /usr/bin/pkexec --disable-internal-agent /usr/bin/dpkg -i ${file}`,
      'stopServer',
      'relaunch',
      'quit',
    ])
    expect(updates.state().status).toBe('installing')
  })

  it('deb: without pkexec the board keeps running and the section has the command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('DebUpdater')
    const { updates, edges } = await offered(updater, {
      type: 'deb',
      commands: { dpkg: '/usr/bin/dpkg', apt: '/usr/bin/apt' },
    })
    await updates.install()
    const file = pending(dir, 'agent-board_0.3.0_amd64.deb')
    expect(updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo apt install ${file}`, file },
    })
    expect(path.isAbsolute(file)).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    expect(updates.state().error).toMatch(/pkexec \(polkit\) is not installed/)
    expect(edges.spawnSync).not.toHaveBeenCalled()
    expect(edges.stopServer).not.toHaveBeenCalled()
    expect(edges.quit).not.toHaveBeenCalled()
  })

  it('deb: polkit declined (exit 126) asks once, keeps the board, and gives the dpkg command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('DebUpdater')
    const { updates, edges } = await offered(updater, {
      type: 'deb',
      commands: { pkexec: '/usr/bin/pkexec', dpkg: '/usr/bin/dpkg' },
      pkexec: () => ({ status: 126 }),
    })
    await updates.install()
    const file = pending(dir, 'agent-board_0.3.0_amd64.deb')
    expect(updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo dpkg -i ${file}`, file },
    })
    expect(updates.state().error).toMatch(/polkit did not authorize the install \(pkexec exit 126\)/)
    // Nothing more after a refusal (electron-updater would try apt-get install -f).
    expect(edges.spawnSync).toHaveBeenCalledTimes(1)
    expect(edges.stopServer).not.toHaveBeenCalled()
    // Pressed again, it tries again.
    expect(() => updates.install()).not.toThrow()
  })

  it('rpm: installs the rpm with dnf through pkexec; with no authentication agent (127) the dnf command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const commands = { pkexec: '/usr/bin/pkexec', dnf: '/usr/bin/dnf', rpm: '/usr/bin/rpm' }
    const ok = realUpdater('RpmUpdater')
    const a = await offered(ok.updater, { type: 'rpm', commands })
    await a.updates.install()
    const file = pending(ok.dir, 'agent-board-0.3.0.x86_64.rpm')
    expect(fs.readFileSync(file, 'utf8')).toBe('rpm 0.3.0')
    expect(a.order).toEqual([
      `spawn /usr/bin/pkexec --disable-internal-agent /usr/bin/dnf install --nogpgcheck -y ${file}`,
      'stopServer',
      'relaunch',
      'quit',
    ])
    const no = realUpdater('RpmUpdater')
    const b = await offered(no.updater, { type: 'rpm', commands, pkexec: () => ({ status: 127 }) })
    await b.updates.install()
    const file2 = pending(no.dir, 'agent-board-0.3.0.x86_64.rpm')
    expect(b.updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo dnf install ${file2}` },
    })
    expect(b.edges.stopServer).not.toHaveBeenCalled()
  })

  it('rpm: with rpm alone, and no pkexec, the rpm command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('RpmUpdater')
    const { updates } = await offered(updater, { type: 'rpm', commands: { rpm: '/usr/bin/rpm' } })
    await updates.install()
    expect(updates.state().manual?.command).toBe(
      `sudo rpm -U ${pending(dir, 'agent-board-0.3.0.x86_64.rpm')}`,
    )
  })

  it('pacman: installs the pacman package through pkexec; declined, the pacman -U command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const commands = { pkexec: '/usr/bin/pkexec', pacman: '/usr/bin/pacman' }
    const ok = realUpdater('PacmanUpdater')
    const a = await offered(ok.updater, { type: 'pacman', commands })
    await a.updates.install()
    const file = pending(ok.dir, 'agent-board-0.3.0.pacman')
    expect(fs.readFileSync(file, 'utf8')).toBe('pacman 0.3.0')
    expect(a.order).toEqual([
      `spawn /usr/bin/pkexec --disable-internal-agent /usr/bin/pacman -U --noconfirm ${file}`,
      'stopServer',
      'relaunch',
      'quit',
    ])
    const no = realUpdater('PacmanUpdater')
    const b = await offered(no.updater, { type: 'pacman', commands, pkexec: () => ({ status: 126 }) })
    await b.updates.install()
    const file2 = pending(no.dir, 'agent-board-0.3.0.pacman')
    expect(b.updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo pacman -U ${file2}`, file: file2 },
    })
    // Nothing more after a refusal (electron-updater would try pacman -Sy and a second -U).
    expect(b.edges.spawnSync).toHaveBeenCalledTimes(1)
    expect(b.edges.stopServer).not.toHaveBeenCalled()
  })

  it('pacman: a package manager that fails keeps the board and gives the command', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('PacmanUpdater')
    const { lines, log } = recordingLog()
    const { updates, edges } = await offered(updater, {
      type: 'pacman',
      commands: { pkexec: '/usr/bin/pkexec', pacman: '/usr/bin/pacman' },
      pkexec: () => ({ status: 1, stderr: 'error: failed to commit transaction' }),
      log,
    })
    await updates.install()
    const file = pending(dir, 'agent-board-0.3.0.pacman')
    expect(updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo pacman -U ${file}`, file },
    })
    expect(updates.state().error).toMatch(
      /The package manager failed: pacman -U --noconfirm .* exited with 1: error: failed to commit transaction/,
    )
    // One root action per press: not electron-updater's pacman -Sy (a partial sync) and second -U.
    expect(edges.spawnSync).toHaveBeenCalledTimes(1)
    expect(edges.spawnSync.mock.calls[0]?.[1]).toEqual([
      '--disable-internal-agent',
      '/usr/bin/pacman',
      '-U',
      '--noconfirm',
      file,
    ])
    // The log file names the cause, not electron-updater's retry, which never ran.
    expect(lines.error).toEqual([
      expect.stringMatching(
        /^updates: the install failed: The package manager failed: pacman -U --noconfirm .* exited with 1: error: failed to commit transaction$/,
      ),
    ])
    expect([...lines.warn, ...lines.error].join('\n')).not.toMatch(/retry|-Sy/i)
    expect(edges.stopServer).not.toHaveBeenCalled()
    // Pressed again, it asks once more.
    await updates.install()
    expect(edges.spawnSync).toHaveBeenCalledTimes(2)
  })

  it('deb: a dpkg that fails keeps the board and gives the command, without apt-get install -f', async () => {
    release({ version: '0.3.0', files: linuxFiles('0.3.0') })
    const { updater, dir } = realUpdater('DebUpdater')
    const { lines, log } = recordingLog()
    const { updates, edges } = await offered(updater, {
      type: 'deb',
      commands: { pkexec: '/usr/bin/pkexec', dpkg: '/usr/bin/dpkg', 'apt-get': '/usr/bin/apt-get' },
      pkexec: () => ({ status: 1, stderr: 'dpkg: dependency problems prevent configuration' }),
      log,
    })
    await updates.install()
    const file = pending(dir, 'agent-board_0.3.0_amd64.deb')
    expect(updates.state()).toMatchObject({
      status: 'manual',
      manual: { command: `sudo dpkg -i ${file}`, file },
    })
    expect(updates.state().error).toMatch(
      /The package manager failed: dpkg -i .* exited with 1: dpkg: dependency problems/,
    )
    expect(edges.spawnSync).toHaveBeenCalledTimes(1)
    expect(edges.spawnSync.mock.calls[0]?.[1]).toEqual([
      '--disable-internal-agent',
      '/usr/bin/dpkg',
      '-i',
      file,
    ])
    expect(lines.error).toEqual([
      expect.stringMatching(
        /^updates: the install failed: The package manager failed: dpkg -i .* exited with 1: dpkg: dependency problems/,
      ),
    ])
    expect([...lines.warn, ...lines.error].join('\n')).not.toMatch(/apt-get/)
    expect(edges.stopServer).not.toHaveBeenCalled()
  })

  it('NSIS: stops the board, then runs the downloaded installer silently with --force-run and quits', async () => {
    release({ version: '0.3.0', files: { 'agent-board-setup-0.3.0.exe': Buffer.from('MZ installer 0.3.0') } })
    const { updater, dir } = realUpdater('NsisUpdater')
    // The installer's process is the edge: electron-updater's spawn of it, recorded.
    const internals = /** @type {any} */ (updater)
    const spawned = vi.spyOn(internals, 'spawnLog').mockResolvedValue(true)
    const { updates, order } = await offered(updater, { type: 'nsis' })
    await updates.install()
    expect(order).toEqual(['stopServer', 'releaseLock', 'quit'])
    const file = pending(dir, 'agent-board-setup-0.3.0.exe')
    expect(fs.readFileSync(file, 'utf8')).toBe('MZ installer 0.3.0')
    // quitAndInstall(true, true)'s arguments: silent, and the new version started after it.
    expect(spawned).toHaveBeenCalledWith(file, ['--updated', '/S', '--force-run'])
  })

  describe('AppImage', () => {
    const before = process.env.APPIMAGE
    afterEach(() => {
      if (before === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = before
    })

    it.runIf(process.platform === 'linux')(
      'replaces the AppImage in its folder and starts the new one, the board stopped first',
      async () => {
        const apps = fs.mkdtempSync(path.join(tmp, 'apps-'))
        const old = path.join(apps, 'agent-board-0.2.0-x86_64.AppImage')
        fs.writeFileSync(old, 'old')
        process.env.APPIMAGE = old
        const marker = path.join(tmp, 'appimage-ran')
        release({
          version: '0.3.0',
          files: { ...linuxFiles('0.3.0'), 'agent-board-0.3.0-x86_64.AppImage': program(marker) },
        })
        const { updater } = realUpdater('AppImageUpdater')
        const { updates, order } = await offered(updater, { type: 'appimage' })
        await updates.install()
        expect(order).toEqual(['stopServer', 'releaseLock', 'quit'])
        expect(fs.readdirSync(apps)).toEqual(['agent-board-0.3.0-x86_64.AppImage'])
        await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true))
        await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8')).toMatch(/silent=true/))
      },
    )

    it('an install that fails starts the board again and says so', async () => {
      // electron-updater refuses an APPIMAGE that is not an absolute path, at install.
      process.env.APPIMAGE = 'relative.AppImage'
      release({ version: '0.3.0', files: linuxFiles('0.3.0') })
      const { updater } = realUpdater('AppImageUpdater')
      const { updates, order } = await offered(updater, { type: 'appimage' })
      await updates.install()
      expect(order).toEqual(['stopServer', 'releaseLock', 'takeLock', 'startServer'])
      expect(updates.state()).toMatchObject({ status: 'error' })
      expect(updates.state().error).toMatch(/0\.3\.0 update could not be installed/)
    })

    it.runIf(process.platform === 'linux')(
      'pressed again after a failed install, installs: electron-updater does not ignore the retry',
      async () => {
        // The first install fails at electron-updater's check of APPIMAGE (not an absolute path).
        process.env.APPIMAGE = 'relative.AppImage'
        const marker = path.join(tmp, 'appimage-retried')
        release({
          version: '0.3.0',
          files: { ...linuxFiles('0.3.0'), 'agent-board-0.3.0-x86_64.AppImage': program(marker) },
        })
        const { updater } = realUpdater('AppImageUpdater')
        const install = vi.spyOn(updater, 'install')
        const { updates, order } = await offered(updater, { type: 'appimage' })
        await updates.install()
        expect(updates.state().status).toBe('error')
        expect(install).toHaveLastReturnedWith(false)
        // The cause fixed, Download and install again: the new AppImage replaces the old one and starts.
        const apps = fs.mkdtempSync(path.join(tmp, 'apps-'))
        const old = path.join(apps, 'agent-board-0.2.0-x86_64.AppImage')
        fs.writeFileSync(old, 'old')
        process.env.APPIMAGE = old
        order.length = 0
        await updates.install()
        expect(install).toHaveLastReturnedWith(true)
        expect(order).toEqual(['stopServer', 'releaseLock', 'quit'])
        expect(fs.readdirSync(apps)).toEqual(['agent-board-0.3.0-x86_64.AppImage'])
        await vi.waitFor(() => expect(fs.readFileSync(marker, 'utf8')).toMatch(/silent=true/))
      },
    )
  })
})

describe('handleBridgeMessage', () => {
  const fake = () => {
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } })),
    })
    return setup({ updater, type: 'deb' })
  }

  it('answers the state, and starts a check, answering with the state as it then is', async () => {
    const { updates } = fake()
    expect(handleBridgeMessage(updates, { channel: BRIDGE, id: 'a', op: 'state' })).toEqual({
      channel: BRIDGE,
      id: 'a',
      ok: true,
      state: expect.objectContaining({ mode: 'desktop', status: 'idle', installed: '0.2.0' }),
    })
    expect(handleBridgeMessage(updates, { channel: BRIDGE, id: 'b', op: 'check' })).toMatchObject({
      ok: true,
      state: { status: 'checking' },
    })
    await updates.check()
    expect(updates.state().status).toBe('none')
  })

  it('refuses an install with nothing offered (409), and an unknown request (400)', () => {
    const { updates } = fake()
    expect(handleBridgeMessage(updates, { channel: BRIDGE, id: 'c', op: 'install' })).toEqual({
      channel: BRIDGE,
      id: 'c',
      ok: false,
      status: 409,
      error: 'there is no update to install: check for updates first',
    })
    expect(handleBridgeMessage(updates, { channel: BRIDGE, id: 'd', op: 'delete' })).toMatchObject({
      ok: false,
      status: 400,
    })
  })

  it('changes the settings', () => {
    const { updates, edges } = fake()
    expect(
      handleBridgeMessage(updates, { channel: BRIDGE, id: 'e', op: 'settings', body: { autoCheck: false } }),
    ).toMatchObject({ ok: true, state: { settings: { autoCheck: false, prereleases: false } } })
    expect(edges.saveSettings).toHaveBeenCalledWith({ autoCheck: false, prereleases: false })
  })

  it('leaves alone what is not one of its messages', () => {
    const { updates } = fake()
    expect(handleBridgeMessage(updates, 'hello')).toBeNull()
    expect(handleBridgeMessage(updates, { channel: 'other', id: 'x', op: 'state' })).toBeNull()
    expect(handleBridgeMessage(updates, { channel: BRIDGE, op: 'state' })).toBeNull()
  })
})

describe('updateError', () => {
  it("keeps the first line of electron-updater's message, without its headers and stack", () => {
    const err = new Error(
      'Cannot find channel "latest-linux.yml" update info: HttpError: 404 Not Found\n"method: GET"\n    at x',
    )
    expect(updateError(err)).toBe(
      'Cannot find channel "latest-linux.yml" update info: HttpError: 404 Not Found',
    )
    const mismatch = Object.assign(new Error('sha512 checksum mismatch, expected a, got b'), {
      code: 'ERR_CHECKSUM_MISMATCH',
    })
    expect(updateError(mismatch)).toBe(
      "The download did not match the sha512 checksum in the release's metadata, so nothing was installed. sha512 checksum mismatch, expected a, got b",
    )
  })
})
