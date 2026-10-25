/**
 * Runs: the long-running processes the board starts from a ticket's worktree, as the human configures
 * them per repo in the project's settings. A preview answers on a port (the board checks its health
 * path) and has a link to open; a job is a background worker with no link (a queue worker, a watcher).
 * Shared by the server, which checks every write with `runConfigProblem`, and the settings form, which
 * shows the same message before it saves.
 */

export const RUN_TYPES = ['preview', 'job'] as const
export type RunType = (typeof RUN_TYPES)[number]

/** The ports the board gives its runs: never 47100, the live board's own. */
export const RUN_PORTS = { from: 47101, to: 47199 } as const

export const MAX_RUN_NAME = 60
export const MAX_RUN_COMMAND = 2000
export const MAX_RUN_ENV = 50

/** A run as the human configures it. `port` null is "auto": the first free port from 47101. */
export interface RunConfigInput {
  name: string
  type: RunType
  install: string
  build: string
  start: string
  env: Record<string, string>
  port: number | null
  healthPath: string
  /** Wipe and fill `<worktree>/data/preview` with a copy of the live board's data before it starts. */
  copyData: boolean
}

/**
 * The preview the board ran of its own repo before runs were configurable, as the run every checkout
 * of the board is given once: install only when the lockfile changed, build, a fresh copy of the live
 * data, then the built server with sign-in off, on loopback, on a free port.
 */
export const DEFAULT_RUN: RunConfigInput = {
  name: 'Preview',
  type: 'preview',
  install: 'pnpm install --frozen-lockfile --prefer-offline',
  build: 'pnpm build',
  start: 'node .output/server/index.mjs',
  env: {
    BOARD_ENV: 'development',
    AUTH: 'off',
    STORAGE: 'local',
    BOARD_URL: 'http://127.0.0.1:{port}',
  },
  port: null,
  healthPath: '/',
  copyData: true,
}

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The variables the board sets itself on a run's start: a run's own env may not name them. */
export function boardEnvKeys(copyData: boolean) {
  return ['PORT', 'HOST', 'PREVIEW_PARENT_PID', ...(copyData ? ['DATA_DIR'] : [])]
}

/** The folder name of a run's logs: its name, lower case, in letters, digits, `.`, `_` and `-`. */
export const runSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '') || 'run'

/**
 * What is wrong with a run config, as `<field>: <why>`, or null when it is fine. `others` are the
 * repo's other runs, for the names.
 */
export function runConfigProblem(
  run: RunConfigInput,
  others: Pick<RunConfigInput, 'name'>[] = [],
): string | null {
  const name = run.name.trim()
  if (!name) return 'name: give the run a name'
  if (name.length > MAX_RUN_NAME) return `name: at most ${MAX_RUN_NAME} characters`
  const same = others.find(
    (o) => o.name.trim().toLowerCase() === name.toLowerCase() || runSlug(o.name) === runSlug(name),
  )
  if (same) return `name: the repo already has a run named ${same.name}`
  if (!(RUN_TYPES as readonly string[]).includes(run.type)) return 'type: preview or job'
  for (const field of ['install', 'build', 'start'] as const)
    if (run[field].length > MAX_RUN_COMMAND) return `${field}: at most ${MAX_RUN_COMMAND} characters`
  if (!run.start.trim()) return 'start: give the command that starts it'
  const keys = Object.keys(run.env)
  if (keys.length > MAX_RUN_ENV) return `env: at most ${MAX_RUN_ENV} variables`
  const own = boardEnvKeys(run.copyData)
  for (const key of keys) {
    if (!ENV_KEY.test(key)) return `env: ${key || '(empty)'} is not a variable name (letters, digits, _)`
    if (own.includes(key.toUpperCase())) return `env: ${key} is set by the board itself`
    if (typeof run.env[key] !== 'string') return `env: ${key} must be text`
    if (run.env[key]!.length > MAX_RUN_COMMAND) return `env: ${key} is longer than ${MAX_RUN_COMMAND}`
  }
  if (run.type === 'job') {
    if (run.port !== null) return 'port: a job has no port'
    if (run.healthPath) return 'healthPath: a job has no health path'
    return null
  }
  if (
    run.port !== null &&
    (!Number.isInteger(run.port) || run.port < RUN_PORTS.from || run.port > RUN_PORTS.to)
  )
    return `port: auto, or a port from ${RUN_PORTS.from} to ${RUN_PORTS.to}`
  if (!run.healthPath.startsWith('/')) return 'healthPath: a path starting with /'
  if (run.healthPath.length > 500 || /\s/.test(run.healthPath))
    return 'healthPath: a path without spaces, at most 500 characters'
  return null
}
