import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` and make the path absolute (relative to the process cwd). */
export function expandPath(p: string): string {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(p)
}

const env = (key: string, fallback: string) => process.env[key] || fallback

/**
 * CLAUDE_ARGS: arguments put before claude's own when the board runs `CLAUDE_BIN`, as a JSON array of
 * strings (e.g. `["path/to/script.mjs"]` with `CLAUDE_BIN=node`, how the tests stand in for claude).
 */
export function readClaudeArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    value = null
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(`CLAUDE_ARGS must be a JSON array of strings, got ${raw}`)
  return value
}

/**
 * CLAUDE_TIMEOUT_MS: how long one run of claude may take before it is stopped, in milliseconds (two
 * minutes by default).
 */
export function readClaudeTimeout(raw: string | undefined): number {
  if (!raw?.trim()) return 120_000
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms <= 0)
    throw new Error(`CLAUDE_TIMEOUT_MS must be a whole number of milliseconds above 0, got ${raw}`)
  return ms
}

type Env = Record<string, string | undefined>

/** PORT: where the board listens (47100 by default). Its loopback origins are on this port. */
export const readPort = (e: Env) => Number(e.PORT || '47100')

export const config = {
  port: readPort(process.env),
  boardUrl: env('BOARD_URL', 'http://localhost:47100').replace(/\/$/, ''),
  gateUrl: env('GATE_URL', 'http://localhost:47110').replace(/\/$/, ''),
  dataDir: expandPath(env('DATA_DIR', './data')),
  // The Claude Code CLI that writes generated reports, and arguments to put before its own.
  claudeBin: env('CLAUDE_BIN', 'claude'),
  claudeArgs: readClaudeArgs(process.env.CLAUDE_ARGS),
  claudeTimeoutMs: readClaudeTimeout(process.env.CLAUDE_TIMEOUT_MS),
  // The user-wide .claude folder on this machine the review skills are checked in, and installed into by
  // its line on the Agents pages.
  claudeHome: expandPath(env('CLAUDE_HOME', '~/.claude')),
  // Where attachment files live: 'local' (data/uploads) or 's3' (MinIO or any S3-compatible store).
  storage: env('STORAGE', 'local') === 's3' ? ('s3' as const) : ('local' as const),
  s3: {
    endpoint: env('S3_ENDPOINT', ''),
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', ''),
    accessKey: env('S3_ACCESS_KEY', ''),
    secretKey: env('S3_SECRET_KEY', ''),
  },
}

export const uploadsDir = path.join(config.dataDir, 'uploads')
// With STORAGE=s3, the local copies agents open (written as files come in, fetched again when gone).
export const cacheDir = path.join(config.dataDir, 'cache')
export const logsDir = path.join(config.dataDir, 'logs')

// --- who answers for a request: the gate, or (outside production only) nobody. README: "Test mode" ---

export const BOARD_ENVS = ['production', 'development', 'test'] as const
export type BoardEnv = (typeof BOARD_ENVS)[number]

/** The live board's port. A board without the gate never listens on it, whatever BOARD_ENV says. */
export const LIVE_PORT = 47100
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export interface AuthMode {
  boardEnv: BoardEnv
  /** No request asks the gate: always in test, in development with AUTH=off. Never in production. */
  off: boolean
  /** Who a request is while the gate is off (in test, unless X-Test-Actor says otherwise). Null in
   *  development without DEV_HUMAN: the human the board last saw sign in, else `human`. */
  human: string | null
}

export class StartupError extends Error {}

/**
 * BOARD_ENV: production (the default, so forgetting it fails safe), development or test. AUTH=off
 * turns the gate off in development; test never asks it. Throws on anything it cannot honour safely.
 */
export function readAuthMode(e: Record<string, string | undefined>): AuthMode {
  const boardEnv = (e.BOARD_ENV?.trim() || 'production') as BoardEnv
  if (!BOARD_ENVS.includes(boardEnv))
    throw new StartupError(`BOARD_ENV must be one of ${BOARD_ENVS.join(', ')}, got "${e.BOARD_ENV}"`)
  const auth = e.AUTH?.trim().toLowerCase() || 'on'
  if (auth !== 'on' && auth !== 'off') throw new StartupError(`AUTH must be on or off, got "${e.AUTH}"`)
  if (boardEnv === 'production' && auth === 'off')
    throw new StartupError(
      'AUTH=off is refused with BOARD_ENV=production: the live board always asks the gate',
    )
  if (boardEnv === 'test') return { boardEnv, off: true, human: e.TEST_HUMAN?.trim() || 'human' }
  if (boardEnv === 'development' && auth === 'off')
    return { boardEnv, off: true, human: e.DEV_HUMAN?.trim() || null }
  return { boardEnv, off: false, human: null }
}

let mode: AuthMode | undefined
/** The mode this process runs in, read once; the startup check has already refused a bad one. */
export const authMode = () => (mode ??= readAuthMode(process.env))

/**
 * With the gate off, refuse to listen anywhere but loopback, or on the live board's port. A `host`
 * of undefined means every interface (the built server's default when HOST is unset).
 */
export function checkBind(auth: AuthMode, bind: { host: string | undefined; port: number }) {
  if (!auth.off) return
  const host = bind.host?.trim().replace(/^\[(.*)\]$/, '$1')
  if (!host || !LOOPBACK.has(host.toLowerCase()))
    throw new StartupError(
      `the gate is off (BOARD_ENV=${auth.boardEnv}), so the board only listens on loopback ` +
        `(127.0.0.1, ::1 or localhost), not ${host || 'every interface'}; set HOST`,
    )
  if (bind.port === LIVE_PORT)
    throw new StartupError(
      `the gate is off (BOARD_ENV=${auth.boardEnv}) and ${LIVE_PORT} is the live board's port; pick another port`,
    )
}

/** Where the built server will listen, read the way Nitro's node server reads it. */
export function builtServerBind(e: Record<string, string | undefined>) {
  const port = Number.parseInt(e.NITRO_PORT ?? e.PORT ?? '')
  return { host: e.NITRO_HOST || e.HOST || undefined, port: Number.isNaN(port) ? 3000 : port }
}

export const authOffBanner = (auth: AuthMode, name: string) =>
  `AUTH OFF: ${auth.boardEnv}, signed in as ${name}, do not expose this` +
  (auth.boardEnv === 'test' ? ' (X-Test-Actor: human:<name> or agent:<name> picks another caller)' : '')

// --- the tailnet entrance: the board on this machine's tailnet name, through `tailscale serve`. ---
// README: "Using it from other devices". Off unless all three keys are set, and never with the gate off.

/** The settings of the tailnet entrance: all three, or none. */
export const ENTRANCE_KEYS = ['PUBLIC_ORIGIN', 'PUBLIC_GATE_URL', 'PUBLIC_GATE_AUTH_URL'] as const

export interface PublicEntrance {
  /** PUBLIC_ORIGIN: the board as other devices open it, `https://<machine>.<tailnet>.ts.net`. */
  origin: string
  /** Its host name, lower case: the one Host besides loopback the board answers for. */
  host: string
  /** PUBLIC_GATE_URL: the public gate as the browser reaches it, on the same host (`https://<host>:8443`). */
  gateUrl: string
  /** PUBLIC_GATE_AUTH_URL: where the board asks that gate about each request, on this machine. */
  gateAuthUrl: string
}

// A host name of two labels or more, the last one starting with a letter: no wildcard, no IP literal.
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

const parseUrl = (raw: string) => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}
/** `raw` is exactly an origin (scheme, host, port), a trailing slash and case aside: no path, no user. */
const isOrigin = (raw: string, url: URL) => raw.replace(/\/$/, '').toLowerCase() === url.origin
const portOf = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80')

/**
 * PUBLIC_ORIGIN, PUBLIC_GATE_URL and PUBLIC_GATE_AUTH_URL: the board on this machine's tailnet name and
 * its own passkey-gate there. Null when none is set: the board then answers on loopback only. Throws on
 * a half configuration and on anything it cannot trust: a wildcard, a port or a path on the board's
 * origin, a gate on another host, a /auth off this machine or the localhost gate's.
 */
export function readPublicEntrance(e: Env): PublicEntrance | null {
  const values = ENTRANCE_KEYS.map((key) => e[key]?.trim() ?? '')
  const set = ENTRANCE_KEYS.filter((_, i) => values[i])
  if (!set.length) return null
  const [origin, gate, auth] = values as [string, string, string]
  if (set.length < ENTRANCE_KEYS.length)
    throw new StartupError(
      `the tailnet entrance takes ${ENTRANCE_KEYS.join(', ')} together, or none of them: ` +
        `${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} set, ` +
        `${ENTRANCE_KEYS.filter((key) => !set.includes(key)).join(' and ')} not`,
    )
  const board = parseUrl(origin)
  if (
    board?.protocol !== 'https:' ||
    board.port ||
    !isOrigin(origin, board) ||
    !HOST_NAME.test(board.hostname)
  )
    throw new StartupError(
      'PUBLIC_ORIGIN must be https://<machine>.<tailnet>.ts.net: https, a host name (no IP, no wildcard), ' +
        `no port and no path; got "${origin}"`,
    )
  const host = board.hostname
  const gateUrl = parseUrl(gate)
  if (
    gateUrl?.protocol !== 'https:' ||
    !isOrigin(gate, gateUrl) ||
    gateUrl.hostname !== host ||
    gateUrl.origin === board.origin
  )
    throw new StartupError(
      `PUBLIC_GATE_URL must be https://${host}:<port>: the public gate on the board's host, on a port of ` +
        `its own (8443 with tailscale serve), no path; got "${gate}"`,
    )
  const authUrl = parseUrl(auth)
  if (authUrl?.protocol !== 'http:' || !isOrigin(auth, authUrl) || !LOOPBACK_URL_HOSTS.has(authUrl.hostname))
    throw new StartupError(
      'PUBLIC_GATE_AUTH_URL must be http://127.0.0.1:<port>: the public gate on this machine, on loopback ' +
        `(127.0.0.1, [::1] or localhost), no path; got "${auth}"`,
    )
  const local = parseUrl(e.GATE_URL || 'http://localhost:47110')
  if (local && LOOPBACK_URL_HOSTS.has(local.hostname) && portOf(local) === portOf(authUrl))
    throw new StartupError(
      `PUBLIC_GATE_AUTH_URL (${auth}) is the localhost gate of GATE_URL: the tailnet entrance needs a gate ` +
        'of its own (docker-compose.gate.yml, profile tailnet, on 127.0.0.1:47111)',
    )
  return { origin: board.origin, host, gateUrl: gateUrl.origin, gateAuthUrl: authUrl.origin }
}

/** The entrance a board with these settings serves: none while the gate is off, whatever the keys say. */
export function readServedEntrance(e: Env): PublicEntrance | null {
  const entrance = readPublicEntrance(e)
  return entrance && !readAuthMode(e).off ? entrance : null
}

let served: PublicEntrance | null | undefined
/** The entrance this process serves, read once; the startup check has already refused a bad one. */
export const servedEntrance = () =>
  served === undefined ? (served = readServedEntrance(process.env)) : served

/** Said as a gate-off board starts with the entrance's keys set: it never answers through it. */
export const entranceIgnored = (auth: AuthMode) =>
  `the gate is off (${auth.boardEnv}), so PUBLIC_ORIGIN, PUBLIC_GATE_URL and PUBLIC_GATE_AUTH_URL are ` +
  'ignored: this board answers on loopback only, never through the tailnet'
