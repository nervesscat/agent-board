import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { config } from './config'

/**
 * The tools on this machine the board runs: `git` (ticket branch and commit status, merged checks,
 * cleanup), `gh` signed in (the PR queue, CI, PR tickets), `claude` (`CLAUDE_BIN` with `CLAUDE_ARGS`:
 * the board's own report generation, Reports → Generate) and `node` with `pnpm` (managed previews).
 * Each is looked up on the PATH the server was started with (with PATHEXT on Windows), never through a
 * login shell, so the answer is the same whether the board was started from a checkout or by another
 * program with its own PATH. Checked once as the server starts (`plugins/hostTools.ts`) and again on
 * demand; the last result is kept, and the features that need a tool say what is missing from it
 * (`toolProblem`).
 */

export const TOOL_NAMES = ['git', 'gh', 'claude', 'node', 'pnpm'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export interface HostTool {
  name: ToolName
  /** Whether the binary resolves: on PATH, or at `CLAUDE_BIN` for claude. */
  found: boolean
  /** Where it resolved; null when not found. */
  path: string | null
  /** The version it printed, when it printed one in time; null otherwise. */
  version: string | null
  /**
   * gh only: whether `gh auth status` succeeded for the active github.com account (`GH_AUTH_STATUS`);
   * null when not found, when it did not answer in time, when it could not reach GitHub to tell
   * (`ghSignedIn`), and when the check says nothing about the account at all (gh too old for its
   * `--active`, or a gh the environment gives no config to read: `ghAuthState`).
   */
  signedIn?: boolean | null
  /** Neither missing nor (gh) signed out. */
  ok: boolean
  /**
   * Whether the board can do without it: claude only writes the board's own reports, which the human
   * may never ask for, so the missing-tools banner leaves its absence to the feature that needs it
   * (the Reports page's Generate action) instead of saying something they are looking at is broken.
   */
  optional: boolean
  /** What does not work without it. */
  breaks: string
  /** What is wrong, when not ok. */
  problem: string | null
  /** How to fix it, when not ok. */
  fix: string | null
}

export interface HostTools {
  checkedAt: string
  tools: HostTool[]
}

/** How long one probe (`--version`, `gh auth status`) may take before the board stops waiting. */
export const PROBE_TIMEOUT_MS = 8_000

const BREAKS: Record<ToolName, string> = {
  git: 'ticket branch and commit status, merged checks and cleanup',
  gh: 'the PR queue, CI status and PR tickets',
  claude: "the board's own report generation (Reports → Generate)",
  node: 'managed previews',
  pnpm: 'managed previews',
}

const THEN = 'then Check again (restart the board if its folder was not on its PATH yet)'
const INSTALL: Record<ToolName, string> = {
  git: `install git (https://git-scm.com/downloads), ${THEN}`,
  gh: `install the GitHub CLI (https://cli.github.com) and run gh auth login, ${THEN}`,
  claude:
    'install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), or set CLAUDE_BIN in .env ' +
    '(config.env for the desktop app) to its full path, then restart the board',
  node: `install Node.js (https://nodejs.org), ${THEN}`,
  pnpm: `run corepack enable pnpm (or install it: https://pnpm.io/installation), ${THEN}`,
}

/** The upgrade, when gh is too old for the sign-in check it is given. */
const GH_UPGRADE =
  'upgrade the GitHub CLI (https://cli.github.com; on Debian or Ubuntu: sudo apt install ' +
  '--only-upgrade gh, on macOS: brew upgrade gh)'

/**
 * What a gh too old for `--active` breaks: the sign-in check alone. The PR queue, CI status and PR
 * tickets call `gh api` and `gh pr view`, which gh 2.45 has; `BREAKS.gh` would be a false alarm.
 */
const GH_TOO_OLD_BREAKS = "the board's check that gh is signed in"

/** What a probe found of one tool, before it is judged. */
export interface Probe {
  path: string | null
  version?: string | null
  signedIn?: boolean | null
  /** gh only: what `gh auth status` printed (both streams), for telling its failures apart. */
  authOutput?: string
}

/** What `toolEntry` needs beyond the probe: the server's env and platform, and where claude should be. */
export interface EntryOptions extends Lookup {
  claudeBin?: string
}

/** The entry of a tool from what its probe found: what it breaks, and what is wrong and the fix. */
export function toolEntry(
  name: ToolName,
  probe: Probe,
  { claudeBin = config.claudeBin, env = process.env, platform = process.platform }: EntryOptions = {},
): HostTool {
  const found = probe.path !== null
  const auth = name === 'gh' ? ghAuthState(probe, { env, platform }) : null
  // A gh too old for the check, or one with no config to read, is not gh signed out: unknown, not false.
  const signedIn =
    name === 'gh'
      ? !found
        ? null
        : auth === 'signed-in'
          ? true
          : auth === 'signed-out'
            ? false
            : null
      : undefined
  let problem: string | null = null
  let fix: string | null = null
  if (!found) {
    problem =
      name === 'claude'
        ? `claude was not found: CLAUDE_BIN is ${claudeBin}`
        : `${name} was not found on the board's PATH`
    fix = INSTALL[name]
  } else if (auth === 'too-old') {
    problem = `${probe.version ? `gh ${probe.version}` : 'gh'} is too old for this check: it does not know --active`
    fix = `${GH_UPGRADE}, then Check again`
  } else if (auth === 'no-config') {
    const where = ghConfigMissing(env, platform)
    problem = where
      ? `gh cannot find its config: no ${where.needs}, so it looked for ${where.file}`
      : 'gh cannot find its config: no HOME or GH_CONFIG_DIR'
    fix =
      'start the board with HOME set to the home gh was signed in from (or GH_CONFIG_DIR to the ' +
      'folder holding hosts.yml), then Check again'
  } else if (auth === 'signed-out') {
    problem = 'gh is not signed in'
    fix = 'run gh auth login on this machine, then Check again'
  }
  return {
    name,
    found,
    path: probe.path,
    version: found ? (probe.version ?? null) : null,
    ...(name === 'gh' && { signedIn }),
    ok: problem === null,
    optional: name === 'claude',
    breaks: auth === 'too-old' ? GH_TOO_OLD_BREAKS : BREAKS[name],
    problem,
    fix,
  }
}

// --- finding a binary the way the OS would from the server's PATH ---

export interface Lookup {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** The env value of `key`, whatever its case (Windows keeps `Path`). */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key]
  const found = Object.keys(env).find((k) => k.toUpperCase() === key)
  return found === undefined ? undefined : env[found]
}

function isRunnable(file: string, win: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (!win) fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Whether a folder is there: gh reads its config from one the environment names. */
function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where `name` runs from: a name is looked up in each folder of PATH in order, on Windows with each of
 * PATHEXT's extensions (so `pnpm.cmd` and `gh.exe` are found as `pnpm` and `gh`); a path (absolute, or
 * with a folder in it) is checked where it says. Null when it is nowhere.
 */
export function resolveTool(name: string, { env = process.env, platform = process.platform }: Lookup = {}) {
  const win = platform === 'win32'
  const exts = win
    ? (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : []
  const candidates = (base: string) => {
    if (!win) return [base]
    const ext = path.extname(base).toLowerCase()
    // A name that already has a runnable extension is taken as it is; otherwise only with one.
    return exts.includes(ext) ? [base] : exts.map((e) => base + e)
  }
  const hasDir = name.includes('/') || (win && name.includes('\\')) || path.isAbsolute(name)
  if (hasDir) return candidates(path.resolve(name)).find((f) => isRunnable(f, win)) ?? null
  const dirs = (envValue(env, 'PATH') ?? '').split(win ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    const hit = candidates(path.join(dir.replace(/^"(.*)"$/, '$1'), name)).find((f) => isRunnable(f, win))
    if (hit) return hit
  }
  return null
}

// --- running a probe ---

/** A Windows batch file runs only through cmd.exe: Node refuses to run one directly. */
const needsShell = (file: string, platform: NodeJS.Platform) =>
  platform === 'win32' && /\.(cmd|bat)$/i.test(file)

/** One argument quoted for cmd.exe. */
const cmdQuote = (arg: string) => (/^[\w.:\\/=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`)

interface ProbeRun {
  /** null when it could not start or did not end in time. */
  code: number | null
  stdout: string
  stderr: string
}

/** What a probe keeps of each stream: a version line or gh's account report fit many times over. */
const KEEP = 64 * 1024

/**
 * Runs `file args` with stdin closed and collects what it prints, for at most `timeoutMs`: then it is
 * killed with what it started, and the run counts as unanswered. Never rejects.
 */
function runProbe(
  file: string,
  args: string[],
  { env, platform, timeoutMs }: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; timeoutMs: number },
): Promise<ProbeRun> {
  return new Promise((resolve) => {
    const shell = needsShell(file, platform)
    let child
    try {
      child = shell
        ? spawn([file, ...args].map(cmdQuote).join(' '), {
            shell: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      return resolve({ code: null, stdout: '', stderr: '' })
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(null)
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < KEEP) stdout += chunk
    })
    // Read to the end past what is kept: a full stderr pipe would stall the probe.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < KEEP) stderr += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** The first version number in what a tool printed: `git version 2.45.1` gives 2.45.1. */
export function parseVersion(out: string): string | null {
  return /\d+\.\d+(?:\.\d+)*/.exec(out)?.[0] ?? null
}

/** gh's own words, or Go's, for a request that never reached GitHub. */
const UNREACHABLE =
  /error connecting to|dial tcp|proxyconnect|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|TLS handshake timeout|timed out/i

/**
 * Whether gh is signed in, from how `gh auth status` (`GH_AUTH_STATUS`) ended and what it printed (both
 * streams) with `GH_DEBUG=api`, which logs each request it makes and each answer it gets. Exit 0 is
 * signed in. A non-zero exit is signed out when gh has no account ("You are not logged into any
 * accounts on github.com", or of older gh "... any GitHub hosts") or when GitHub answered its check
 * (a token it rejects gets an HTTP 401). When GitHub could not be reached (offline, a proxy or DNS
 * failure) gh says the same "Failed to log in ... The token is invalid" as for a rejected token, but
 * nothing is known of the token: null, as for no answer in time. A gh too old to know `--active`, or
 * one the environment gives no config to read, fails too: `ghAuthState` tells those apart by what it
 * printed and the env.
 */
export function ghSignedIn(code: number | null, output: string): boolean | null {
  if (code === null) return null
  if (code === 0) return true
  if (/not logged in(to)? any (github hosts|accounts on)/i.test(output)) return false
  if (/^< HTTP\/\S+ \d{3}/m.test(output)) return false
  // Asked GitHub and got nothing back; older gh without the request log names the network error.
  return /^\* Request to /m.test(output) || UNREACHABLE.test(output) ? null : false
}

/**
 * The sign-in check: only the active account on github.com. A bare `gh auth status` checks every
 * account on every host and fails when any does, so an expired token of an account not in use, or
 * another host that cannot be reached, would read as signed out though the board's gh works.
 */
export const GH_AUTH_STATUS = ['auth', 'status', '--active', '--hostname', 'github.com']

/** Why a failed `gh auth status` failed: a real sign-out, a gh too old for the flag, or no config. */
export type GhAuthState = 'signed-in' | 'signed-out' | 'too-old' | 'no-config' | 'unknown'

/** The config file gh went looking for, and the variable that would have told it where. */
interface GhConfig {
  file: string
  needs: string
}

/**
 * The config gh could not find, when the environment gives it no folder to read: `GH_CONFIG_DIR`,
 * `XDG_CONFIG_HOME/gh` (Windows `%AppData%\GitHub CLI`) or `HOME/.config/gh`, each a folder that must
 * be there. Null when it has one. gh says "not logged into any GitHub hosts" in both cases, so only
 * the environment tells them apart.
 */
function ghConfigMissing(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): GhConfig | null {
  const value = (key: string) => envValue(env, key)?.trim() || undefined
  if (value('GH_CONFIG_DIR')) return null
  if (platform === 'win32') {
    const appData = value('APPDATA')
    if (appData && isDir(appData)) return null
    return {
      file: path.win32.join(appData ?? '%AppData%', 'GitHub CLI', 'hosts.yml'),
      needs: 'APPDATA',
    }
  }
  const xdg = value('XDG_CONFIG_HOME')
  if (xdg)
    return isDir(xdg) ? null : { file: path.posix.join(xdg, 'gh', 'hosts.yml'), needs: 'XDG_CONFIG_HOME' }
  const home = value('HOME')
  if (!home) return { file: '$HOME/.config/gh/hosts.yml', needs: 'HOME' }
  return isDir(home) ? null : { file: path.posix.join(home, '.config', 'gh', 'hosts.yml'), needs: 'HOME' }
}

/**
 * What `gh auth status` (`GH_AUTH_STATUS`) says about the active github.com account, beyond signed in
 * or out: gh too old to know `--active`, or an environment that gives it no config to read. A check
 * that failed with neither sign, or one that never reached GitHub, is unknown (null), as for no
 * answer in time.
 */
export function ghAuthState(
  probe: Probe,
  { env = process.env, platform = process.platform }: Lookup = {},
): GhAuthState {
  if (probe.signedIn === true) return 'signed-in'
  if (probe.signedIn !== false) return 'unknown'
  if (/unknown flag/i.test(probe.authOutput ?? '')) return 'too-old'
  return ghConfigMissing(env, platform) ? 'no-config' : 'signed-out'
}

export interface CheckOptions extends Lookup {
  claudeBin?: string
  claudeArgs?: string[]
  timeoutMs?: number
}

/** Checks every tool, side by side, with the PATH and `CLAUDE_BIN` given (the server's by default). */
export async function probeHostTools(opts: CheckOptions = {}): Promise<HostTools> {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const claudeBin = opts.claudeBin ?? config.claudeBin
  const claudeArgs = opts.claudeArgs ?? config.claudeArgs
  const run = { env, platform, timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS }
  const tools = await Promise.all(
    TOOL_NAMES.map(async (name): Promise<HostTool> => {
      const file = resolveTool(name === 'claude' ? claudeBin : name, { env, platform })
      if (!file) return toolEntry(name, { path: null }, { claudeBin, env, platform })
      const args = name === 'claude' ? [...claudeArgs, '--version'] : ['--version']
      const [version, auth] = await Promise.all([
        runProbe(file, args, run),
        name === 'gh' ? runProbe(file, GH_AUTH_STATUS, { ...run, env: { ...env, GH_DEBUG: 'api' } }) : null,
      ])
      const authOutput = auth ? auth.stdout + auth.stderr : undefined
      return toolEntry(
        name,
        {
          path: file,
          version: version.code === 0 ? parseVersion(version.stdout) : null,
          signedIn: auth ? ghSignedIn(auth.code, auth.stdout + auth.stderr) : undefined,
          authOutput,
        },
        { claudeBin, env, platform },
      )
    }),
  )
  return { checkedAt: new Date().toISOString(), tools }
}

// --- the last result ---

/**
 * Kept outside the module, like the managed previews: a hot reload of the server code evaluates this
 * module again, and must not forget the startup check.
 */
interface Kept {
  last: HostTools | null
  running: Promise<HostTools> | null
}
const KEPT = Symbol.for('agent-board.hostTools')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= { last: null, running: null })

/** The last check, or null before the first one finished. */
export const hostTools = (): HostTools | null => kept.last

/** Checks every tool again and keeps the result; a call while one runs shares it. */
export function checkHostTools(): Promise<HostTools> {
  if (kept.running) return kept.running
  const running = probeHostTools().then(
    (r) => {
      kept.last = r
      return r
    },
    // A probe never rejects; this is for what cannot happen, so the last result stays.
    (err: unknown) => {
      console.error('checking the host tools failed:', err)
      return kept.last ?? Promise.reject(err)
    },
  )
  kept.running = running
  void running
    .finally(() => {
      if (kept.running === running) kept.running = null
    })
    .catch(() => {})
  return running
}

/** The last check, or the one running (starting one when none ran yet). */
export const readyHostTools = (): Promise<HostTools> =>
  kept.running ?? (kept.last ? Promise.resolve(kept.last) : checkHostTools())

/** Tests: set the kept result (null forgets it). */
export function setHostTools(r: HostTools | null) {
  kept.last = r
}

/** Tests: a result where every tool is fine but for the ones given. */
export function hostToolsWith(probes: Partial<Record<ToolName, Probe>>): HostTools {
  return {
    checkedAt: new Date().toISOString(),
    tools: TOOL_NAMES.map((name) =>
      toolEntry(name, probes[name] ?? { path: `/usr/bin/${name}`, version: '1.0.0', signedIn: true }),
    ),
  }
}

/** Whether an error is a spawn that found no binary to run. */
const notFound = (err: unknown) => {
  const e = err as { code?: unknown; syscall?: unknown } | null
  return !!e && e.code === 'ENOENT' && typeof e.syscall === 'string' && e.syscall.startsWith('spawn')
}

/**
 * What is wrong with a tool and the fix, in one line, for a feature that needs it: from the last check,
 * or from `err` when it is a spawn that found no binary (the check may be older than the change). Null
 * when neither says anything is wrong. A spawn's ENOENT does not blame a tool the last check found
 * where it still is: Node says the same of a folder it could not start the binary in.
 */
export function toolProblem(name: ToolName, err?: unknown): string | null {
  const entry = kept.last?.tools.find((t) => t.name === name)
  if (entry && !entry.ok) return `${entry.problem}: ${entry.fix}`
  if (err !== undefined && notFound(err)) {
    if (entry?.path && isRunnable(entry.path, process.platform === 'win32')) return null
    const missing = toolEntry(name, { path: null })
    return `${missing.problem}: ${missing.fix}`
  }
  return null
}

/** The check as agents read it on `get_project`: no paths, the problem and fix only when not ok. */
export function hostToolsForAgents() {
  const r = kept.last
  if (!r) return null
  return {
    checkedAt: r.checkedAt,
    tools: r.tools.map((t) => ({
      name: t.name,
      found: t.found,
      version: t.version,
      ...(t.name === 'gh' && { signedIn: t.signedIn ?? null }),
      ok: t.ok,
      optional: t.optional,
      ...(!t.ok && { breaks: t.breaks, problem: t.problem, fix: t.fix }),
    })),
  }
}
