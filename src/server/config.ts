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

export const config = {
  port: Number(env('PORT', '47100')),
  boardUrl: env('BOARD_URL', 'http://localhost:47100').replace(/\/$/, ''),
  gateUrl: env('GATE_URL', 'http://localhost:47110').replace(/\/$/, ''),
  dataDir: expandPath(env('DATA_DIR', './data')),
  // The Claude Code CLI that writes generated reports, and arguments to put before its own.
  claudeBin: env('CLAUDE_BIN', 'claude'),
  claudeArgs: readClaudeArgs(process.env.CLAUDE_ARGS),
  claudeTimeoutMs: readClaudeTimeout(process.env.CLAUDE_TIMEOUT_MS),
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
