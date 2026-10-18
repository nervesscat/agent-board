// What the desktop app runs the board with: its folder, its config file, the port and the data folder,
// and the environment the built server starts in. No Electron here, so the tests run it under Node.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** @typedef {Record<string, string | undefined>} Env */

export const DEFAULT_PORT = 47100
export const CONFIG_FILE = 'config.env'

export class SettingsError extends Error {}

/**
 * The app's own folder: its config file, the window's browser profile and, by default, the board's data.
 * `%LOCALAPPDATA%\agent-board` on Windows (`~/.local/share/agent-board` elsewhere); AGENT_BOARD_HOME
 * moves all of it, as a second copy of the app beside the installed one does (desktop/smoke.mjs).
 * @param {Env} env
 */
export function appHome(env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_BOARD_HOME?.trim()) return path.resolve(env.AGENT_BOARD_HOME.trim())
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local')
      : env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
  return path.join(base, 'agent-board')
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

# The passkey-gate the board asks who is signed in.
# GATE_URL=http://localhost:47110

# The Claude Code CLI that writes generated reports (default: claude on PATH).
# CLAUDE_BIN=

# The tailnet entrance for your other devices: all three or none (README: "Using it from other devices").
# PUBLIC_ORIGIN=
# PUBLIC_GATE_URL=
# PUBLIC_GATE_AUTH_URL=
`

/**
 * The config file's values, written from the template the first time so there is one to edit.
 * @param {string} home
 */
export function readConfigFile(home) {
  const file = path.join(home, CONFIG_FILE)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(file, CONFIG_TEMPLATE)
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
 */

/**
 * The port, the data folder and the server's environment: the environment wins over the config file,
 * which wins over the defaults (port 47100, `<home>/data`). The board always runs as production on
 * 127.0.0.1, whatever either says: it always asks the gate, and AUTH=off is refused as it starts.
 * @param {{ env: Env, file: Record<string, string>, home: string }} input
 * @returns {Settings}
 */
export function resolveSettings({ env, file, home }) {
  /** @param {string} key */
  const pick = (key) => env[key]?.trim() || file[key]?.trim() || ''
  const rawPort = pick('PORT')
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SettingsError(`PORT must be a whole number from 1 to 65535, got "${rawPort}"`)
  const rawData = pick('DATA_DIR')
  const dataDir = rawData ? expandPath(rawData, home) : path.join(home, 'data')
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
    // Where the gate sends the browser back after sign-in: the window's own origin.
    BOARD_URL: pick('BOARD_URL') || url,
  }
  for (const key of ['DEV_HUMAN', 'TEST_HUMAN', 'BOARD_DATA_COPY']) delete serverEnv[key]
  return { port, dataDir, url, serverEnv }
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

/**
 * Whether nothing listens on `port` on either loopback. The window opens `localhost`, which may reach
 * [::1] first, so a server there and not on 127.0.0.1 would take the window's requests.
 * @param {number} port
 */
export async function isPortFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise((/** @type {(free: boolean) => void} */ resolve) => {
      const probe = net.createServer()
      probe.once('error', (/** @type {NodeJS.ErrnoException} */ e) =>
        // No IPv6 on this machine: nothing can hold [::1] either.
        resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'),
      )
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, host)
    })
    if (!free) return false
  }
  return true
}

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
