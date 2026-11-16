import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { HostTool, HostTools, Probe } from './hostTools'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// claude is the tests' stand-in (e2e/fake-claude.mjs), run through node, as the e2e board runs it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-host-tools-')))
process.env.DATA_DIR = path.join(tmp, 'data')
const FAKE_CLAUDE = fileURLToPath(new URL('../../e2e/fake-claude.mjs', import.meta.url))
process.env.CLAUDE_BIN = process.execPath
process.env.CLAUDE_ARGS = JSON.stringify([FAKE_CLAUDE])

const WIN = process.platform === 'win32'

let host: typeof import('./hostTools')
beforeAll(async () => {
  host = await import('./hostTools')
})
afterEach(() => host.setHostTools(null))

let dirs = 0
/** A fresh folder of fake tools: each prints `<name> version <v>`; `authFails` has `gh auth status` exit 1. */
function shims(tools: Record<string, string>, opts: { authFails?: boolean; dirName?: string } = {}) {
  const dir = path.join(tmp, opts.dirName ?? `shims-${++dirs}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, version] of Object.entries(tools)) {
    const auth = opts.authFails ? 1 : 0
    if (WIN)
      fs.writeFileSync(
        path.join(dir, `${name}.cmd`),
        `@echo off\r\nif "%1"=="auth" exit /b ${auth}\r\necho ${name} version ${version}\r\n`,
      )
    else {
      const file = path.join(dir, name)
      fs.writeFileSync(
        file,
        `#!/bin/sh\nif [ "$1" = "auth" ]; then exit ${auth}; fi\necho "${name} version ${version}"\n`,
      )
      fs.chmodSync(file, 0o755)
    }
  }
  return dir
}

/** The server's env with only `PATH` as given (whatever case the platform keeps it in), minus `drop`. */
function envWith(PATH: string, drop: string[] = []): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k.toUpperCase() !== 'PATH' && !drop.includes(k.toUpperCase()),
    ),
  )
  return { ...env, PATH }
}

/** One line echoed by a .cmd file: cmd's special characters escaped, an empty line as `echo.`. */
const cmdEcho = (line: string) => (line ? `echo ${line.replace(/[\^&<>|]/g, '^$&')}` : 'echo.')

/**
 * A shell command that prints `lines` (to stderr after `to` = `' >&2'`) with the shell's own printf: a
 * fake runs with only its folder on PATH, so `cat` and `grep` are not there to call.
 */
const shPrint = (lines: string[], to = '') =>
  lines.length ? `printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(' ')}${to}` : ':'

/**
 * A fake gh whose `gh auth status` exits with `exit` and prints `said` to stderr, after the request log
 * `debug` when it runs with GH_DEBUG=api (as gh does); `gh --version` prints `version`.
 */
function fakeGh(auth: { exit: number; said: string[]; debug?: string[]; version?: string }) {
  const dir = path.join(tmp, `gh-${++dirs}`)
  fs.mkdirSync(dir, { recursive: true })
  const debug = auth.debug ?? []
  const version = auth.version ?? '2.98.0'
  if (WIN)
    fs.writeFileSync(
      path.join(dir, 'gh.cmd'),
      [
        '@echo off',
        'if "%1"=="auth" goto auth',
        `echo gh version ${version}`,
        'exit /b 0',
        ':auth',
        'if not "%GH_DEBUG%"=="api" goto said',
        ...debug.map((l) => `${cmdEcho(l)} 1>&2`),
        ':said',
        ...auth.said.map((l) => `${cmdEcho(l)} 1>&2`),
        `exit /b ${auth.exit}`,
        '',
      ].join('\r\n'),
    )
  else {
    const file = path.join(dir, 'gh')
    fs.writeFileSync(
      file,
      [
        '#!/bin/sh',
        `if [ "$1" != "auth" ]; then echo "gh version ${version}"; exit 0; fi`,
        `if [ "$GH_DEBUG" = "api" ]; then ${shPrint(debug, ' >&2')}; fi`,
        shPrint(auth.said, ' >&2'),
        `exit ${auth.exit}`,
        '',
      ].join('\n'),
    )
    fs.chmodSync(file, 0o755)
  }
  return dir
}

// What gh 2.98 prints for an account it cannot confirm, whether GitHub rejected the token or was unreachable.
const FAILED_LOG_IN = [
  'github.com',
  '  X Failed to log in to github.com account octocat (keyring)',
  '  - Active account: true',
  '  - The token in keyring is invalid.',
  '  - To re-authenticate, run: gh auth refresh -h github.com',
]

const byName = (r: HostTools) =>
  Object.fromEntries(r.tools.map((t) => [t.name, t])) as Record<string, HostTool>

describe('the check', () => {
  it('finds the tools on the PATH it is given, with their version, and gh signed out when auth status fails', async () => {
    const dir = shims({ git: '9.9.9', gh: '8.8.8' }, { authFails: true })
    const r = await host.probeHostTools({ env: envWith(dir), claudeBin: 'claude', claudeArgs: [] })
    const t = byName(r)
    expect(Date.parse(r.checkedAt)).not.toBeNaN()
    expect(r.tools.map((x) => x.name)).toEqual(['git', 'gh', 'claude', 'node', 'pnpm'])
    expect(t.git).toMatchObject({ found: true, version: '9.9.9', ok: true, problem: null, fix: null })
    expect(path.dirname(t.git!.path!)).toBe(dir)
    expect(t.gh).toMatchObject({ found: true, version: '8.8.8', signedIn: false, ok: false })
    expect(t.gh!.fix).toMatch(/gh auth login/)
    for (const name of ['claude', 'node', 'pnpm'])
      expect(t[name]).toMatchObject({ found: false, path: null, version: null, ok: false })
    expect(t.git).not.toHaveProperty('signedIn')
  })

  it('has gh signed in when auth status succeeds', async () => {
    const dir = shims({ gh: '2.1.0' })
    const r = await host.probeHostTools({ env: envWith(dir), claudeBin: 'claude', claudeArgs: [] })
    expect(byName(r).gh).toMatchObject({ found: true, version: '2.1.0', signedIn: true, ok: true })
  })

  it('has gh signed in unknown, and fine, when github.com cannot be reached', async () => {
    // HTTPS_PROXY on a host that does not resolve: the request log shows the request and no answer.
    const offline = fakeGh({
      exit: 1,
      debug: [
        '* Request at 2026-10-21 06:26:10.96 -0600 CST',
        '* Request to https://api.github.com/',
        '> GET / HTTP/1.1',
        '> Host: api.github.com',
        '',
        '* proxyconnect tcp: dial tcp: lookup nonexistent.invalid: no such host',
        '* Request took 30.2686ms',
      ],
      said: FAILED_LOG_IN,
    })
    const r = await host.probeHostTools({ env: envWith(offline), claudeBin: 'claude', claudeArgs: [] })
    expect(byName(r).gh).toMatchObject({ found: true, signedIn: null, ok: true, problem: null, fix: null })
  })

  it('has gh signed out when it has no account, or GitHub rejects its token', async () => {
    const none = fakeGh({
      exit: 1,
      said: ['You are not logged into any GitHub hosts. To log in, run: gh auth login'],
    })
    const rejected = fakeGh({
      exit: 1,
      debug: [
        '* Request to https://api.github.com/graphql',
        '> POST /graphql HTTP/1.1',
        '',
        '< HTTP/2.0 401 Unauthorized',
        '< Content-Type: application/json; charset=utf-8',
      ],
      said: FAILED_LOG_IN,
    })
    for (const dir of [none, rejected]) {
      const r = await host.probeHostTools({ env: envWith(dir), claudeBin: 'claude', claudeArgs: [] })
      expect(byName(r).gh).toMatchObject({ signedIn: false, ok: false, problem: 'gh is not signed in' })
    }
  })

  it('says gh is too old for the check when it does not know --active, naming its version', async () => {
    // Ubuntu 24.04 ships gh 2.45, which has no `gh auth status --active`.
    const old = fakeGh({ exit: 1, version: '2.45.0', said: ['unknown flag: --active'] })
    const r = await host.probeHostTools({ env: envWith(old), claudeBin: 'claude', claudeArgs: [] })
    const gh = byName(r).gh!
    expect(gh).toMatchObject({
      found: true,
      version: '2.45.0',
      signedIn: null,
      ok: false,
      optional: false,
      breaks: "the board's check that gh is signed in",
      problem: 'gh 2.45.0 is too old for this check: it does not know --active',
    })
    // The queue, CI and PR tickets use calls this gh has: only the sign-in check fails.
    expect(gh.breaks).not.toMatch(/PR queue/)
    expect(gh.fix).toMatch(/upgrade the GitHub CLI .*sudo apt install --only-upgrade gh/)
  })

  it('says gh cannot find its config when the environment gives it no home, naming the path', async () => {
    // gh prints "not logged into any GitHub hosts" for a missing config too: only the env tells them apart.
    const dir = fakeGh({
      exit: 1,
      said: ['You are not logged into any GitHub hosts. To log in, run: gh auth login'],
    })
    const r = await host.probeHostTools({
      env: envWith(dir, ['HOME', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'APPDATA']),
      claudeBin: 'claude',
      claudeArgs: [],
    })
    const gh = byName(r).gh!
    const needs = WIN ? 'APPDATA' : 'HOME'
    const file = WIN ? '%AppData%\\GitHub CLI\\hosts.yml' : '$HOME/.config/gh/hosts.yml'
    expect(gh).toMatchObject({ found: true, signedIn: null, ok: false, optional: false })
    expect(gh.problem).toBe(`gh cannot find its config: no ${needs}, so it looked for ${file}`)
    expect(gh.fix).toContain('GH_CONFIG_DIR')
    if (!WIN) expect(gh.fix).toContain('HOME')
  })

  it('checks only the active github.com account: a failing second account or host is not signed out', async () => {
    // gh 2.98 with a working active account on github.com, a second github.com account with an expired
    // token and another host: a bare `gh auth status` fails for the others; the active one alone passes.
    const dir = path.join(tmp, `gh-${++dirs}`)
    fs.mkdirSync(dir, { recursive: true })
    const args = path.join(dir, 'args.txt')
    const good = [
      'github.com',
      '  - Logged in to github.com account octocat (keyring)',
      '  - Active account: true',
    ]
    const others = [
      '  X Failed to log in to github.com account old-me (keyring)',
      '  - Active account: false',
      '  - The token in keyring is invalid.',
      'ghe.example.com',
      '  X Timeout trying to log in to ghe.example.com account octo (keyring)',
      '  - Active account: true',
    ]
    if (WIN)
      fs.writeFileSync(
        path.join(dir, 'gh.cmd'),
        [
          '@echo off',
          'if "%1"=="auth" goto auth',
          'echo gh version 2.98.0',
          'exit /b 0',
          ':auth',
          `echo %*> "${args}"`,
          ...good.map(cmdEcho),
          'set "A=%*"',
          'if "%A:--active=%"=="%A%" goto all',
          'if "%A:--hostname github.com=%"=="%A%" goto all',
          'exit /b 0',
          ':all',
          ...others.map((l) => `${cmdEcho(l)} 1>&2`),
          'exit /b 1',
          '',
        ].join('\r\n'),
      )
    else {
      const file = path.join(dir, 'gh')
      fs.writeFileSync(
        file,
        [
          '#!/bin/sh',
          'if [ "$1" != "auth" ]; then echo "gh version 2.98.0"; exit 0; fi',
          `echo "$@" > '${args}'`,
          shPrint(good),
          'case " $* " in *" --active "*) case " $* " in *" --hostname github.com "*) exit 0 ;; esac ;; esac',
          shPrint(others, ' >&2'),
          'exit 1',
          '',
        ].join('\n'),
      )
      fs.chmodSync(file, 0o755)
    }
    const r = await host.probeHostTools({ env: envWith(dir), claudeBin: 'claude', claudeArgs: [] })
    const said = fs.readFileSync(args, 'utf8').trim().split(/\s+/)
    expect(said).toEqual(['auth', 'status', '--active', '--hostname', 'github.com'])
    expect(byName(r).gh).toMatchObject({ found: true, signedIn: true, ok: true, problem: null })
  })

  it('has gh signed out when github.com has no account, though another host has one', () => {
    // What gh 2.98 prints for `gh auth status --hostname github.com` with only another host signed in.
    expect(host.ghSignedIn(1, 'You are not logged into any accounts on github.com\n')).toBe(false)
  })

  it('reads whether gh is signed in from its exit and what it printed', () => {
    expect(host.ghSignedIn(0, '')).toBe(true)
    expect(host.ghSignedIn(null, '')).toBeNull()
    expect(host.ghSignedIn(1, '')).toBe(false)
    expect(host.ghSignedIn(1, FAILED_LOG_IN.join('\n'))).toBe(false)
    // Without the request log (a gh that ignores GH_DEBUG), by the network error it names.
    expect(
      host.ghSignedIn(1, 'error connecting to api.github.com\ncheck your internet connection'),
    ).toBeNull()
    // Windows line ends.
    expect(
      host.ghSignedIn(1, '* Request to https://api.github.com/\r\n< HTTP/2.0 401 Unauthorized\r\n'),
    ).toBe(false)
    expect(host.ghSignedIn(1, '* Request to https://api.github.com/\r\n* i/o timeout\r\n')).toBeNull()
  })

  it('names why the gh check failed: too old, no config, signed out, or unknown', () => {
    const home = path.join(tmp, 'a-home')
    fs.mkdirSync(home, { recursive: true })
    const said = 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
    const state = (probe: Pick<Probe, 'signedIn' | 'authOutput'>, env: NodeJS.ProcessEnv = { HOME: home }) =>
      host.ghAuthState({ path: '/usr/bin/gh', ...probe }, { env, platform: 'linux' })
    expect(state({ signedIn: true })).toBe('signed-in')
    expect(state({ signedIn: false, authOutput: said })).toBe('signed-out')
    // gh has the config it needs from GH_CONFIG_DIR, wherever HOME points.
    expect(state({ signedIn: false, authOutput: said }, { GH_CONFIG_DIR: tmp })).toBe('signed-out')
    expect(state({ signedIn: false, authOutput: 'unknown flag: --active' })).toBe('too-old')
    // HOME that is not there, and no GH_CONFIG_DIR or XDG_CONFIG_HOME: no config to read.
    expect(state({ signedIn: false, authOutput: said }, {})).toBe('no-config')
    expect(state({ signedIn: null, authOutput: said })).toBe('unknown')
  })

  it('finds a Windows tool by its PATHEXT extension: pnpm.cmd is pnpm', () => {
    const dir = path.join(tmp, 'pathext')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), '@echo 9.1.0\r\n')
    fs.writeFileSync(path.join(dir, 'git'), '')
    const lookup = {
      env: { PATH: `${tmp};${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32' as const,
    }
    expect(host.resolveTool('pnpm', lookup)).toBe(path.join(dir, 'pnpm.cmd'))
    // Without a runnable extension, Windows would not run it: not found.
    expect(host.resolveTool('git', lookup)).toBeNull()
    expect(host.resolveTool('pnpm.cmd', lookup)).toBe(path.join(dir, 'pnpm.cmd'))
  })

  it.runIf(WIN)(
    'runs a .cmd shim through the shell and reads its version, from a folder with a space',
    async () => {
      const dir = shims({ pnpm: '9.12.3' }, { dirName: 'only pnpm' })
      const r = await host.probeHostTools({ env: envWith(dir), claudeBin: 'claude', claudeArgs: [] })
      expect(byName(r).pnpm).toMatchObject({ found: true, version: '9.12.3', ok: true })
      expect(byName(r).pnpm!.path).toBe(path.join(dir, 'pnpm.cmd'))
    },
  )

  it('looks claude up from CLAUDE_BIN: a missing path is not found and the fix names CLAUDE_BIN', async () => {
    const missing = path.join(tmp, 'nope', WIN ? 'claude.exe' : 'claude')
    const r = await host.probeHostTools({ env: envWith(''), claudeBin: missing, claudeArgs: [] })
    const claude = byName(r).claude!
    expect(claude).toMatchObject({
      found: false,
      ok: false,
      problem: `claude was not found: CLAUDE_BIN is ${missing}`,
    })
    expect(claude.fix).toMatch(/CLAUDE_BIN in \.env \(config\.env for the desktop app\)/)
  })

  it('runs claude as CLAUDE_BIN with CLAUDE_ARGS first: a name on PATH, found even when it prints no version', async () => {
    const started = Date.now()
    const r = await host.probeHostTools({
      env: envWith(path.dirname(process.execPath)),
      claudeBin: 'node',
      claudeArgs: [FAKE_CLAUDE],
    })
    expect(byName(r).claude).toMatchObject({ found: true, version: null, ok: true })
    expect(byName(r).node).toMatchObject({ found: true, version: process.versions.node, ok: true })
    expect(Date.now() - started).toBeLessThan(host.PROBE_TIMEOUT_MS)
  })

  it('stops waiting for a probe that hangs: the tool is still found, without a version', async () => {
    const started = Date.now()
    const r = await host.probeHostTools({
      env: envWith(''),
      claudeBin: process.execPath,
      claudeArgs: ['-e', 'setInterval(() => {}, 1000)', '--'],
      timeoutMs: 500,
    })
    expect(byName(r).claude).toMatchObject({ found: true, version: null, ok: true })
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('what each tool breaks and how to fix it', () => {
  it('says it for a missing tool of each kind, and for gh signed out', () => {
    const missing = (name: Parameters<typeof host.toolEntry>[0]) =>
      host.toolEntry(name, { path: null }, { claudeBin: '/opt/claude' })
    expect(host.TOOL_NAMES).toEqual(['git', 'gh', 'claude', 'node', 'pnpm'])
    expect(missing('git')).toMatchObject({
      breaks: 'ticket branch and commit status, merged checks and cleanup',
      optional: false,
      problem: "git was not found on the board's PATH",
      fix: expect.stringContaining('install git (https://git-scm.com/downloads)'),
    })
    expect(missing('gh')).toMatchObject({
      breaks: 'the PR queue, CI status and PR tickets',
      optional: false,
      signedIn: null,
      fix: expect.stringMatching(
        /install the GitHub CLI \(https:\/\/cli\.github\.com\) and run gh auth login/,
      ),
    })
    const claude = missing('claude')
    expect(claude).toMatchObject({
      breaks: "the board's own report generation (Reports → Generate)",
      optional: true,
      problem: 'claude was not found: CLAUDE_BIN is /opt/claude',
      fix: expect.stringMatching(/install Claude Code \(https:.*\), or set CLAUDE_BIN/),
    })
    // claude writes only the board's reports: ticket and project agents never need it.
    expect(claude.breaks).not.toMatch(/agents/)
    expect(missing('node')).toMatchObject({
      breaks: 'managed previews',
      optional: false,
      fix: expect.stringContaining('install Node.js (https://nodejs.org)'),
    })
    expect(missing('pnpm')).toMatchObject({
      breaks: 'managed previews',
      optional: false,
      fix: expect.stringContaining('corepack enable pnpm'),
    })
    expect(host.toolEntry('gh', { path: '/usr/bin/gh', version: '2.0.0', signedIn: false })).toMatchObject({
      found: true,
      ok: false,
      problem: 'gh is not signed in',
      fix: 'run gh auth login on this machine, then Check again',
    })
    expect(host.toolEntry('gh', { path: '/usr/bin/gh', version: '2.0.0', signedIn: true })).toMatchObject({
      ok: true,
      problem: null,
      fix: null,
    })
  })

  it('tells a gh too old for the check and one with no config apart from a real sign-out', () => {
    const tooOld = host.toolEntry('gh', {
      path: '/usr/bin/gh',
      version: '2.45.0',
      signedIn: false,
      authOutput: 'unknown flag: --active',
    })
    expect(tooOld).toMatchObject({
      found: true,
      signedIn: null,
      ok: false,
      optional: false,
      breaks: "the board's check that gh is signed in",
      problem: 'gh 2.45.0 is too old for this check: it does not know --active',
    })
    expect(tooOld.breaks).not.toMatch(/PR queue/)
    expect(tooOld.fix).toMatch(/upgrade the GitHub CLI .*sudo apt install --only-upgrade gh/)

    const home = path.join(tmp, 'no-such-home')
    const noConfig = host.toolEntry(
      'gh',
      {
        path: '/usr/bin/gh',
        version: '2.103.3',
        signedIn: false,
        authOutput: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
      },
      { env: { HOME: home }, platform: 'linux' },
    )
    expect(noConfig).toMatchObject({ signedIn: null, ok: false })
    expect(noConfig.problem).toBe(
      `gh cannot find its config: no HOME, so it looked for ${path.posix.join(home, '.config', 'gh', 'hosts.yml')}`,
    )
    expect(noConfig.fix).toMatch(/HOME/)
    expect(noConfig.fix).toMatch(/GH_CONFIG_DIR/)

    const signedOut = host.toolEntry('gh', {
      path: '/usr/bin/gh',
      version: '2.103.3',
      signedIn: false,
      authOutput: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    })
    expect(signedOut).toMatchObject({
      signedIn: false,
      ok: false,
      problem: 'gh is not signed in',
      fix: 'run gh auth login on this machine, then Check again',
    })
  })

  it("gives a feature the problem in one line: from the last check, or from a spawn's ENOENT", () => {
    expect(host.toolProblem('gh')).toBeNull()
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
    expect(host.toolProblem('git', enoent)).toMatch(/^git was not found on the board's PATH: install git/)
    expect(host.toolProblem('git', new Error('fatal: not a git repository'))).toBeNull()
    host.setHostTools(host.hostToolsWith({ pnpm: { path: null } }))
    expect(host.toolProblem('pnpm')).toMatch(
      /^pnpm was not found on the board's PATH: run corepack enable pnpm/,
    )
    expect(host.toolProblem('node')).toBeNull()
  })

  it('does not blame a tool for an ENOENT when the last check found it where it still is', () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
    const dir = shims({ git: '2.45.1' })
    const git = path.join(dir, WIN ? 'git.cmd' : 'git')
    host.setHostTools(host.hostToolsWith({ git: { path: git, version: '2.45.1' } }))
    // Node says the same of a folder it could not start git in: not git's fault.
    expect(host.toolProblem('git', enoent)).toBeNull()
    // Gone from where the check found it since: missing after all.
    fs.rmSync(git)
    expect(host.toolProblem('git', enoent)).toMatch(/^git was not found on the board's PATH: install git/)
  })
})

describe('over REST and MCP', () => {
  async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
      api.handle(request, actor),
    )
    const request = new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // A gate token: an agent, as opposed to the human's passkey session.
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return handle({ request, actor: as === 'agent' ? 'claude' : 'enrique' })
  }

  it('GET answers the last check (waiting for the first), POST checks again; health stays { ok: true }', async () => {
    const first = (await (await call('GET', '/api/host-tools', undefined, 'agent')).json()) as HostTools
    expect(first.tools.map((t) => t.name)).toEqual(['git', 'gh', 'claude', 'node', 'pnpm'])
    // The board's own stand-in claude, from CLAUDE_BIN and CLAUDE_ARGS.
    expect(first.tools.find((t) => t.name === 'claude')).toMatchObject({
      found: true,
      path: process.execPath,
    })
    const again = (await (await call('GET', '/api/host-tools')).json()) as HostTools
    expect(again.checkedAt).toBe(first.checkedAt)
    const res = await call('POST', '/api/host-tools/check')
    expect(res.status).toBe(200)
    const checked = (await res.json()) as HostTools
    expect(Date.parse(checked.checkedAt)).toBeGreaterThanOrEqual(Date.parse(first.checkedAt))
    expect(checked.checkedAt).not.toBe(first.checkedAt)
    expect(host.hostTools()?.checkedAt).toBe(checked.checkedAt)
    expect(await (await call('GET', '/api/health')).json()).toEqual({ ok: true })
  }, 30_000)

  it("get_project holds the last check: each tool's state, and the problem and fix of one missing", async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'tools' }).returning().get().id
    host.setHostTools(host.hostToolsWith({ gh: { path: null } }))
    const res = await call(
      'POST',
      '/api/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_project', arguments: { projectId } },
      },
      'agent',
    )
    const { result } = (await res.json()) as { result: { content: { text: string }[] } }
    const project = JSON.parse(result.content[0]!.text) as {
      hostTools: { tools: Record<string, unknown>[] }
    }
    expect(project.hostTools.tools).toHaveLength(5)
    expect(project.hostTools.tools.find((t) => t.name === 'gh')).toEqual({
      name: 'gh',
      found: false,
      version: null,
      signedIn: null,
      ok: false,
      optional: false,
      breaks: 'the PR queue, CI status and PR tickets',
      problem: "gh was not found on the board's PATH",
      fix: expect.stringContaining('https://cli.github.com'),
    })
    expect(project.hostTools.tools.find((t) => t.name === 'git')).toEqual({
      name: 'git',
      found: true,
      version: '1.0.0',
      ok: true,
      optional: false,
    })
    expect(project.hostTools.tools.find((t) => t.name === 'claude')).toMatchObject({
      name: 'claude',
      ok: true,
      optional: true,
    })
    // The tool says what it holds.
    const list = await call('POST', '/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'agent')
    const { result: tools } = (await list.json()) as {
      result: { tools: { name: string; description: string }[] }
    }
    expect(tools.tools.find((t) => t.name === 'get_project')!.description).toMatch(
      /hostTools \(the board's last check of the tools on its machine/,
    )
    // REST reads the same.
    const rest = (await (await call('GET', `/api/projects/${projectId}`)).json()) as typeof project
    expect(rest.hostTools.tools).toHaveLength(5)
  })
})
