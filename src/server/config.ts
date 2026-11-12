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
  dataDir: expandPath(env('DATA_DIR', './data')),
  // The Claude Code CLI that writes generated reports, and arguments to put before its own.
  claudeBin: env('CLAUDE_BIN', 'claude'),
  claudeArgs: readClaudeArgs(process.env.CLAUDE_ARGS),
  claudeTimeoutMs: readClaudeTimeout(process.env.CLAUDE_TIMEOUT_MS),
  // The user-wide .claude folder on this machine the review skills are checked in, and installed into by
  // its line and the Connect an agent page's button.
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

// --- who signs a request in: the board's own sign-in, or (outside production only) nobody. README: "Test mode" ---

export const BOARD_ENVS = ['production', 'development', 'test'] as const
export type BoardEnv = (typeof BOARD_ENVS)[number]

/** The live board's port. A board without sign-in never listens on it, whatever BOARD_ENV says. */
export const LIVE_PORT = 47100
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export interface AuthMode {
  boardEnv: BoardEnv
  /** No request signs in: always in test, in development with AUTH=off. Never in production. */
  off: boolean
  /** Who a request is while sign-in is off (in test, unless X-Test-Actor says otherwise). Null in
   *  development without DEV_HUMAN: the human the board last saw sign in, else `human`. */
  human: string | null
}

export class StartupError extends Error {}

/**
 * BOARD_ENV: production (the default, so forgetting it fails safe), development or test. AUTH=off
 * turns sign-in off in development; test never signs anyone in. Throws on anything it cannot honour
 * safely.
 */
export function readAuthMode(e: Record<string, string | undefined>): AuthMode {
  const boardEnv = (e.BOARD_ENV?.trim() || 'production') as BoardEnv
  if (!BOARD_ENVS.includes(boardEnv))
    throw new StartupError(`BOARD_ENV must be one of ${BOARD_ENVS.join(', ')}, got "${e.BOARD_ENV}"`)
  const auth = e.AUTH?.trim().toLowerCase() || 'on'
  if (auth !== 'on' && auth !== 'off') throw new StartupError(`AUTH must be on or off, got "${e.AUTH}"`)
  if (boardEnv === 'production' && auth === 'off')
    throw new StartupError(
      'AUTH=off is refused with BOARD_ENV=production: the live board always requires sign-in',
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
 * With sign-in off, refuse to listen anywhere but loopback, or on the live board's port. A `host`
 * of undefined means every interface (the built server's default when HOST is unset).
 */
export function checkBind(auth: AuthMode, bind: { host: string | undefined; port: number }) {
  if (!auth.off) return
  const host = bind.host?.trim().replace(/^\[(.*)\]$/, '$1')
  if (!host || !LOOPBACK.has(host.toLowerCase()))
    throw new StartupError(
      `sign-in is off (BOARD_ENV=${auth.boardEnv}), so the board only listens on loopback ` +
        `(127.0.0.1, ::1 or localhost), not ${host || 'every interface'}; set HOST`,
    )
  if (bind.port === LIVE_PORT)
    throw new StartupError(
      `sign-in is off (BOARD_ENV=${auth.boardEnv}) and ${LIVE_PORT} is the live board's port; pick another port`,
    )
}

/** Where the built server will listen, read the way Nitro's node server reads it. */
export function builtServerBind(e: Record<string, string | undefined>) {
  const port = Number.parseInt(e.NITRO_PORT ?? e.PORT ?? '')
  return { host: e.NITRO_HOST || e.HOST || undefined, port: Number.isNaN(port) ? 3000 : port }
}

export const authOffBanner = (auth: AuthMode, name: string) =>
  `AUTH OFF: ${auth.boardEnv}, signed in as ${name}, do not expose this` +
  (auth.boardEnv === 'test'
    ? ' (X-Test-Actor: human:<name>, agent:<name> or orchestrator:<name> picks another caller)'
    : '')

// --- the tailnet entrance: the board on this machine's tailnet name, through `tailscale serve`. ---
// README: "Using it from other devices". Set by PUBLIC_ORIGIN (the environment, .env or config.env, which
// wins) or in Settings (saved in the database under TAILNET_SETTING), and never served with sign-in off.
// Under `vite dev` PUBLIC_ORIGIN, BOARD_ENV and AUTH reach process.env as Vite's loadEnv reads .env, not
// as Nitro's loader does (devEnv.ts); every other key here is Nitro's. The built server reads no .env.

export interface PublicEntrance {
  /** The board as other devices open it, `https://<machine>.<tailnet>.ts.net`. */
  origin: string
  /** Its host name, lower case: the one Host besides loopback the board answers for, and the RP ID of
   *  the passkeys made through it. */
  host: string
}

/** The settings key the Settings page saves the entrance under, as `{ "origin": ... }`; absent when none. */
export const TAILNET_SETTING = 'tailnetEntrance'

// A host name of two labels or more, the last one starting with a letter: no wildcard, no IP literal.
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const parseUrl = (raw: string) => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}
/** `raw` is exactly an origin (scheme, host, port), a trailing slash and case aside: no path, no user. */
const isOrigin = (raw: string, url: URL) => raw.replace(/\/$/, '').toLowerCase() === url.origin

/**
 * Why `raw` is not an origin the board takes as its tailnet entrance (the rule the environment and the
 * Settings page both meet), or null when it is one. The message starts with PUBLIC_ORIGIN either way.
 */
export function publicOriginProblem(raw: string): string | null {
  const board = parseUrl(raw)
  if (board?.protocol === 'https:' && !board.port && isOrigin(raw, board) && HOST_NAME.test(board.hostname))
    return null
  return (
    'PUBLIC_ORIGIN must be https://<machine>.<tailnet>.ts.net: https, a host name (no IP, no wildcard), ' +
    `no port and no path; got "${raw}"`
  )
}

/** The entrance a valid origin names (publicOriginProblem said so already). */
export function entranceOf(origin: string): PublicEntrance {
  const board = new URL(origin)
  return { origin: board.origin, host: board.hostname }
}

/**
 * PUBLIC_ORIGIN: the board on this machine's tailnet name, where other devices sign in with passkeys of
 * their own. Null when it is not set: the board then answers on loopback only. Throws on anything it
 * cannot trust: http, a wildcard, an IP, a port or a path.
 */
export function readPublicEntrance(e: Env): PublicEntrance | null {
  const origin = e.PUBLIC_ORIGIN?.trim() ?? ''
  if (!origin) return null
  const problem = publicOriginProblem(origin)
  if (problem) throw new StartupError(problem)
  return entranceOf(origin)
}

let warnedRow: string | undefined
/**
 * The entrance a settings row holds: null when there is none, or when it is not one the board takes (logged
 * once per value, never a crash: the board then answers on loopback only).
 */
export function entranceOfRow(value: unknown): PublicEntrance | null {
  if (value === undefined || value === null) return null
  const origin =
    typeof value === 'object' && 'origin' in value && typeof value.origin === 'string' ? value.origin : null
  const problem = origin === null ? 'the value is not { "origin": ... }' : publicOriginProblem(origin)
  if (origin !== null && problem === null) return entranceOf(origin)
  const shown = JSON.stringify(value)
  if (shown !== warnedRow) {
    warnedRow = shown
    console.error(`agent-board: the tailnet entrance saved in the database is ignored: ${problem} (${shown})`)
  }
  return null
}

/**
 * The entrance a board with these settings serves. PUBLIC_ORIGIN in the environment wins; else the one
 * saved in Settings (`stored`), which only the production board serves: a development copy or a preview
 * never answers through it. Nothing is served while sign-in is off, whatever is set.
 */
export function readServedEntrance(e: Env, stored: PublicEntrance | null = null): PublicEntrance | null {
  const fromEnv = readPublicEntrance(e)
  const mode = readAuthMode(e)
  if (mode.off) return null
  if (fromEnv) return fromEnv
  return mode.boardEnv === 'production' ? stored : null
}

let served: PublicEntrance | null | undefined
let saved: () => PublicEntrance | null = () => null
/** Where the board reads the entrance saved in Settings from (tailnetEntrance.ts, the database). */
export function setStoredEntrance(read: () => PublicEntrance | null) {
  saved = read
  served = undefined
}
/** The entrance this process serves: read once, and again after a change (resetServedEntrance). */
export const servedEntrance = (): PublicEntrance | null =>
  served === undefined ? (served = readServedEntrance(process.env, saved())) : served
/** Forgets the entrance read: the next request reads it again, so a save or a clear applies without a restart. */
export const resetServedEntrance = () => {
  served = undefined
}

/** Said as a board without sign-in starts with PUBLIC_ORIGIN set: it never answers through it. */
export const entranceIgnored = (auth: AuthMode) =>
  `sign-in is off (${auth.boardEnv}), so PUBLIC_ORIGIN is ignored: this board answers on loopback only, ` +
  'never through the tailnet'
