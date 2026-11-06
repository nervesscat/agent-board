import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  appFolders,
  appHome,
  autostartEntry,
  autostartExec,
  autostartFile,
  closeAction,
  CONFIG_FILE,
  CONFIG_TEMPLATE,
  configPathEntries,
  configTemplate,
  DEFAULT_PORT,
  desktopExecArg,
  ensureWritableDir,
  exitReason,
  HEALTHY_RESET_MS,
  isPortFree,
  LOGIN_SHELL_MS,
  loginShellPath,
  mergePath,
  nearestFolder,
  parseConfig,
  parseShellPath,
  portBusyMessage,
  readConfigFile,
  resolveSettings,
  RESTART_DELAYS_MS,
  RESTART_LIMIT,
  restartPlan,
  runCapture,
  setAutostart,
  SettingsError,
  tail,
  trayHostPresent,
  withLoginPath,
} from './app/settings.mjs'

const home = path.resolve(os.tmpdir(), 'agent-board-home')

describe('appHome', () => {
  it('is agent-board under %LOCALAPPDATA% on Windows', () => {
    const local = path.resolve(os.tmpdir(), 'Local')
    expect(appHome({ LOCALAPPDATA: local }, 'win32')).toBe(path.join(local, 'agent-board'))
  })

  it('falls back to AppData\\Local in the home folder without LOCALAPPDATA', () => {
    expect(appHome({}, 'win32', '/home/me')).toBe(path.join('/home/me', 'AppData', 'Local', 'agent-board'))
  })

  it('is moved whole by AGENT_BOARD_HOME', () => {
    expect(appHome({ AGENT_BOARD_HOME: home, LOCALAPPDATA: '/elsewhere' }, 'win32')).toBe(home)
  })

  it('is agent-board in ~/.config on Linux', () => {
    expect(appHome({}, 'linux', '/home/me')).toBe('/home/me/.config/agent-board')
  })
})

describe('appFolders', () => {
  it('keeps everything in %LOCALAPPDATA%\\agent-board on Windows', () => {
    const local = path.resolve(os.tmpdir(), 'Local')
    const one = path.join(local, 'agent-board')
    expect(appFolders({ LOCALAPPDATA: local, XDG_CONFIG_HOME: '/x' }, 'win32')).toEqual({
      config: one,
      profile: path.join(one, 'electron'),
      data: one,
    })
  })

  it('follows the XDG defaults on Linux: config and profile in ~/.config, data in ~/.local/share', () => {
    expect(appFolders({}, 'linux', '/home/me')).toEqual({
      config: '/home/me/.config/agent-board',
      profile: '/home/me/.config/agent-board/electron',
      data: '/home/me/.local/share/agent-board',
    })
  })

  it('follows XDG_CONFIG_HOME and XDG_DATA_HOME on Linux', () => {
    expect(appFolders({ XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: ' /dat ' }, 'linux', '/home/me')).toEqual({
      config: '/cfg/agent-board',
      profile: '/cfg/agent-board/electron',
      data: '/dat/agent-board',
    })
  })

  it('ignores relative and blank XDG values, as the spec says', () => {
    expect(appFolders({ XDG_CONFIG_HOME: 'cfg', XDG_DATA_HOME: '  ' }, 'linux', '/home/me')).toEqual({
      config: '/home/me/.config/agent-board',
      profile: '/home/me/.config/agent-board/electron',
      data: '/home/me/.local/share/agent-board',
    })
  })

  it('puts all of it in AGENT_BOARD_HOME on Linux too', () => {
    expect(appFolders({ AGENT_BOARD_HOME: home, XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me')).toEqual({
      config: home,
      profile: path.join(home, 'electron'),
      data: home,
    })
  })
})

describe('configTemplate', () => {
  it('is the template as it is on Windows', () => {
    expect(configTemplate('win32', 'C:\\data')).toBe(CONFIG_TEMPLATE)
  })

  it('names the data folder on Linux, and still reads as no settings', () => {
    const text = configTemplate('linux', '/home/me/.local/share/agent-board')
    expect(text).toContain('/home/me/.local/share/agent-board/data')
    expect(text).not.toContain('next to this file')
    expect(text).toContain('but for PATH')
    expect(parseConfig(text)).toEqual({})
  })
})

describe('parseConfig', () => {
  it('reads KEY=value lines as .env does', () => {
    const text = [
      '\uFEFF# a comment',
      '',
      'PORT=8250',
      '  CLAUDE_BIN = C:\\tools\\claude.exe  ',
      'export PUBLIC_ORIGIN=https://box.example.ts.net',
      `DATA_DIR="D:\\board data"`,
      "QUOTED='# not a comment'",
      'TRAILING=value # a comment',
      'EMPTY=',
    ].join('\r\n')
    expect(parseConfig(text)).toEqual({
      PORT: '8250',
      CLAUDE_BIN: 'C:\\tools\\claude.exe',
      PUBLIC_ORIGIN: 'https://box.example.ts.net',
      DATA_DIR: 'D:\\board data',
      QUOTED: '# not a comment',
      TRAILING: 'value',
      EMPTY: '',
    })
  })

  it('refuses a line that is not KEY=value, saying which', () => {
    expect(() => parseConfig('PORT=1\nnot a setting')).toThrow(/line 2 is not KEY=value/)
  })

  it('reads the template as no settings at all', () => {
    expect(parseConfig(CONFIG_TEMPLATE)).toEqual({})
  })
})

describe('resolveSettings', () => {
  it('defaults to port 47100 and the data folder in the app folder', () => {
    const s = resolveSettings({ env: {}, file: {}, home })
    expect(s.port).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(47100)
    expect(s.dataDir).toBe(path.join(home, 'data'))
    expect(s.url).toBe('http://localhost:47100')
    expect(s.serverEnv).toMatchObject({
      BOARD_ENV: 'production',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: '47100',
      NITRO_PORT: '47100',
      DATA_DIR: path.join(home, 'data'),
      BOARD_URL: 'http://localhost:47100',
    })
  })

  it('takes the port and the data folder from the config file', () => {
    const data = path.resolve(os.tmpdir(), 'board-data')
    const s = resolveSettings({ env: {}, file: { PORT: '8250', DATA_DIR: data }, home })
    expect(s.port).toBe(8250)
    expect(s.dataDir).toBe(data)
    expect(s.url).toBe('http://localhost:8250')
    expect(s.serverEnv).toMatchObject({ PORT: '8250', NITRO_PORT: '8250', DATA_DIR: data })
  })

  it('lets the environment win over the config file', () => {
    const fromEnv = path.resolve(os.tmpdir(), 'env-data')
    const s = resolveSettings({
      env: { PORT: '8251', DATA_DIR: fromEnv, CLAUDE_BIN: 'env-claude' },
      file: { PORT: '8250', DATA_DIR: path.resolve(os.tmpdir(), 'file-data'), CLAUDE_BIN: 'file-claude' },
      home,
    })
    expect(s.port).toBe(8251)
    expect(s.dataDir).toBe(fromEnv)
    expect(s.serverEnv.CLAUDE_BIN).toBe('env-claude')
  })

  it('passes the config file on to the board', () => {
    const s = resolveSettings({
      env: {},
      file: { CLAUDE_BIN: 'C:\\tools\\claude.exe', PUBLIC_ORIGIN: 'https://pc.tail1.ts.net' },
      home,
    })
    expect(s.serverEnv).toMatchObject({
      CLAUDE_BIN: 'C:\\tools\\claude.exe',
      PUBLIC_ORIGIN: 'https://pc.tail1.ts.net',
    })
  })

  it('reads a relative DATA_DIR from the app folder and ~ as the home folder', () => {
    expect(resolveSettings({ env: {}, file: { DATA_DIR: 'boards/main' }, home }).dataDir).toBe(
      path.join(home, 'boards', 'main'),
    )
    expect(resolveSettings({ env: {}, file: { DATA_DIR: '~/board' }, home }).dataDir).toBe(
      path.join(os.homedir(), 'board'),
    )
  })

  it('puts the data folder and a relative DATA_DIR under the data home when it is apart (Linux)', () => {
    const dataHome = path.resolve(os.tmpdir(), 'share', 'agent-board')
    expect(resolveSettings({ env: {}, file: {}, home, dataHome }).dataDir).toBe(path.join(dataHome, 'data'))
    expect(resolveSettings({ env: {}, file: { DATA_DIR: 'boards/main' }, home, dataHome }).dataDir).toBe(
      path.join(dataHome, 'boards', 'main'),
    )
  })

  it('always runs the board as production on 127.0.0.1, whatever the settings say', () => {
    const s = resolveSettings({
      env: { BOARD_ENV: 'development', HOST: '0.0.0.0', NITRO_HOST: '0.0.0.0', NITRO_PORT: '3000' },
      file: { BOARD_ENV: 'test', DEV_HUMAN: 'me', TEST_HUMAN: 'me', BOARD_DATA_COPY: '1' },
      home,
    })
    expect(s.serverEnv).toMatchObject({
      BOARD_ENV: 'production',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '47100',
    })
    expect(s.serverEnv).not.toHaveProperty('DEV_HUMAN')
    expect(s.serverEnv).not.toHaveProperty('TEST_HUMAN')
    expect(s.serverEnv).not.toHaveProperty('BOARD_DATA_COPY')
  })

  it('keeps AUTH as given, so the board refuses AUTH=off as it starts', () => {
    expect(resolveSettings({ env: {}, file: { AUTH: 'off' }, home }).serverEnv.AUTH).toBe('off')
  })

  it('keeps a BOARD_URL that is set', () => {
    const s = resolveSettings({ env: {}, file: { BOARD_URL: 'http://127.0.0.1:47100' }, home })
    expect(s.serverEnv.BOARD_URL).toBe('http://127.0.0.1:47100')
  })

  it.each(['0', '65536', 'abc', '80.5', '-1'])('refuses PORT=%s', (port) => {
    expect(() => resolveSettings({ env: {}, file: { PORT: port }, home })).toThrow(SettingsError)
  })
})

describe('readConfigFile', () => {
  /** @type {string[]} */
  const dirs = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmpHome = () => {
    const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-config-')), 'agent-board')
    dirs.push(path.dirname(d))
    return d
  }

  it('writes the template the first time, and reads it as no settings', () => {
    const dir = tmpHome()
    expect(readConfigFile(dir)).toEqual({})
    expect(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')).toBe(CONFIG_TEMPLATE)
  })

  it('reads the settings in the file, and leaves the file as it is', () => {
    const dir = tmpHome()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, CONFIG_FILE), 'PORT=8252\n')
    expect(readConfigFile(dir)).toEqual({ PORT: '8252' })
    expect(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')).toBe('PORT=8252\n')
  })

  it('names the file in a parse error', () => {
    const dir = tmpHome()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, CONFIG_FILE), 'oops\n')
    expect(() => readConfigFile(dir)).toThrow(path.join(dir, CONFIG_FILE))
  })
})

describe('isPortFree', () => {
  /** @type {net.Server[]} */
  const servers = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  })
  /** Listens on `host` (every interface when it is left out, as `listen(port)` does), on a port the
   *  system picks unless one is given. */
  const listen = (/** @type {string | undefined} */ host, port = 0) =>
    new Promise((/** @type {(port: number) => void} */ resolve, reject) => {
      const s = net.createServer()
      s.once('error', reject)
      s.listen({ port, host }, () => {
        servers.push(s)
        resolve(/** @type {net.AddressInfo} */ (s.address()).port)
      })
    })

  it('is true for a port nothing listens on', async () => {
    const port = await listen('127.0.0.1')
    await new Promise((r) => servers.pop()?.close(r))
    expect(await isPortFree(port)).toBe(true)
  })

  it('is false while something listens on 127.0.0.1', async () => {
    expect(await isPortFree(await listen('127.0.0.1'))).toBe(false)
  })

  it('is false while something listens on [::1] only', async () => {
    expect(await isPortFree(await listen('::1'))).toBe(false)
  })

  it('is false while something listens on every interface, as listen(port) does ([::])', async () => {
    expect(await isPortFree(await listen(undefined))).toBe(false)
  })

  it('is false while something listens on [::] explicitly', async () => {
    expect(await isPortFree(await listen('::'))).toBe(false)
  })

  it('is false while something listens on 0.0.0.0', async () => {
    expect(await isPortFree(await listen('0.0.0.0'))).toBe(false)
  })
})

describe('the busy-port dialog', () => {
  it('names the port and the file to change it in', () => {
    const file = path.join(home, CONFIG_FILE)
    const message = portBusyMessage(8253, file)
    expect(message).toContain('Port 8253 is already in use')
    expect(message).toContain(file)
  })
})

describe('tail', () => {
  it('keeps a short log whole', () => {
    expect(tail('one\ntwo\n')).toBe('one\ntwo')
  })

  it('keeps the end of a long one, from a line start', () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const end = tail(log, 50)
    expect(end.length).toBeLessThanOrEqual(50)
    expect(end.endsWith('line 99')).toBe(true)
    expect(end.startsWith('line ')).toBe(true)
  })
})

describe('ensureWritableDir', () => {
  /** @type {string[]} */
  const dirs = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-writable-'))
    dirs.push(d)
    return d
  }

  it('makes a missing folder and leaves nothing of its check in it', () => {
    const dir = path.join(tmp(), 'a', 'electron')
    ensureWritableDir(dir)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('throws for a folder that cannot be made, under a file', () => {
    const file = path.join(tmp(), 'file')
    fs.writeFileSync(file, '')
    expect(() => ensureWritableDir(path.join(file, 'electron'))).toThrow()
  })
})

describe('nearestFolder', () => {
  /** @type {string[]} */
  const dirs = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-nearest-'))
    dirs.push(d)
    return d
  }

  it('is the folder itself when it exists', () => {
    const dir = tmp()
    expect(nearestFolder(dir)).toBe(dir)
  })

  it('is the closest existing parent of a folder not made yet', () => {
    const dir = tmp()
    expect(nearestFolder(path.join(dir, 'a', 'b', 'agent-board'))).toBe(dir)
  })

  it('is the folder a file is in, never the file', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'home'), '')
    expect(nearestFolder(path.join(dir, 'home'))).toBe(dir)
    expect(nearestFolder(path.join(dir, 'home', 'electron'))).toBe(dir)
  })

  it('is null when nothing on the way exists, as on a missing drive', () => {
    expect(nearestFolder(path.resolve('/q/agent-board'), () => undefined)).toBeNull()
  })

  it('looks further up past a folder it cannot read', () => {
    const top = path.resolve('/')
    /** @param {string} p */
    const stat = (p) => {
      if (p === top) return /** @type {fs.Stats} */ ({ isDirectory: () => true })
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    }
    expect(nearestFolder(path.join(top, 'locked', 'agent-board'), stat)).toBe(top)
  })
})

/** What a login shell prints for `-ilc`: `before`, then the PATH between the markers, then `after`. */
const shellSays = (/** @type {string} */ p, before = '', after = '') =>
  `${before}\n__AGENT_BOARD_PATH_START__${p}__AGENT_BOARD_PATH_END__\n${after}`

/**
 * A runner that answers as `answer` says and keeps what it was asked.
 * @param {(command: string, args: string[]) => import('./app/settings.mjs').RunResult | Promise<import('./app/settings.mjs').RunResult>} answer
 */
const fakeRunner = (answer) => {
  /** @type {{ command: string, args: string[], timeoutMs: number }[]} */
  const calls = []
  /** @type {import('./app/settings.mjs').Runner} */
  const run = async (command, args, { timeoutMs }) => {
    calls.push({ command, args, timeoutMs })
    return answer(command, args)
  }
  return { run, calls }
}

describe('parseShellPath', () => {
  it('reads the PATH between the markers, whatever the profile printed around it', () => {
    const out = shellSays('/home/u/.local/share/mise/shims:/usr/bin', 'Welcome!\x1b[0m\n', 'bye')
    expect(parseShellPath(out)).toEqual(['/home/u/.local/share/mise/shims', '/usr/bin'])
  })

  it('takes the last marked PATH, past a banner that echoes the markers', () => {
    expect(parseShellPath(shellSays('/b', shellSays('/a')))).toEqual(['/b'])
  })

  it('leaves out entries that are not absolute paths', () => {
    expect(parseShellPath(shellSays('relative::/usr/bin:.'))).toEqual(['/usr/bin'])
  })

  it('is null without the markers, or with nothing usable between them', () => {
    expect(parseShellPath('garbage\n/usr/bin\n')).toBeNull()
    expect(parseShellPath('__AGENT_BOARD_PATH_START__/usr/bin')).toBeNull()
    expect(parseShellPath(shellSays('nope'))).toBeNull()
  })
})

describe('mergePath', () => {
  it('keeps the order and each folder once', () => {
    expect(mergePath('/a:/b', '/b:/c:', undefined, '/a:/d')).toBe('/a:/b:/c:/d')
  })
})

describe('loginShellPath', () => {
  const none = () => false

  it('runs $SHELL interactive and login, and puts its PATH before the inherited one, once each', async () => {
    const { run, calls } = fakeRunner(() => ({
      code: 0,
      stdout: shellSays('/home/u/tools:/usr/local/bin:/usr/bin', 'motd'),
    }))
    const p = await loginShellPath({
      env: { SHELL: '/usr/bin/zsh', PATH: '/usr/bin:/bin' },
      home: '/home/u',
      run,
      exists: none,
    })
    expect(p).toBe('/home/u/tools:/usr/local/bin:/usr/bin:/bin')
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/usr/bin/zsh')
    expect(calls[0].args[0]).toBe('-ilc')
    expect(calls[0].args[1]).toContain('"$PATH"')
    expect(calls[0].timeoutMs).toBeGreaterThan(0)
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(10_000)
  })

  it('uses /bin/sh without SHELL, or with one that is not an absolute path', async () => {
    for (const SHELL of [undefined, '', 'zsh']) {
      const { run, calls } = fakeRunner(() => ({ code: 0, stdout: shellSays('/x') }))
      await loginShellPath({ env: { SHELL, PATH: '/usr/bin' }, home: '/home/u', run, exists: none })
      expect(calls[0].command).toBe('/bin/sh')
    }
  })

  it('leaves the inherited PATH and the user bins that exist when the shell fails', async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: shellSays('/should/not/use') }))
    const p = await loginShellPath({
      env: { SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
      home: '/home/u',
      run,
      exists: (b) => b === '/home/u/.local/bin',
    })
    expect(p).toBe('/usr/bin:/bin:/home/u/.local/bin')
  })

  it('leaves the inherited PATH when the shell times out, cannot be run, or prints garbage', async () => {
    const answers = [
      () => ({ code: null, stdout: '' }),
      () => Promise.reject(new Error('ENOENT')),
      () => ({ code: 0, stdout: 'oh-my-zsh update? [Y/n]' }),
    ]
    for (const answer of answers) {
      const { run } = fakeRunner(answer)
      const p = await loginShellPath({
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        home: '/h',
        run,
        exists: none,
      })
      expect(p).toBe('/usr/bin')
    }
  })

  it('returns within its timeout from a shell that hangs, with the inherited PATH', async () => {
    // The real runner, on a "shell" that never ends: Node itself, waiting forever.
    const hang = process.execPath
    const started = Date.now()
    const p = await loginShellPath({
      env: { SHELL: hang, PATH: '/usr/bin' },
      home: '/h',
      timeoutMs: 500,
      exists: none,
      run: (_command, _args, opts) => runCapture(hang, ['-e', 'setInterval(() => {}, 1000)'], opts),
    })
    expect(p).toBe('/usr/bin')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it.runIf(process.platform === 'linux' && fs.existsSync('/bin/bash'))(
    'finds what a real bash login reads from .bashrc (through .bash_profile)',
    async () => {
      const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-shell-'))
      try {
        fs.writeFileSync(path.join(fake, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n')
        fs.writeFileSync(
          path.join(fake, '.bashrc'),
          `echo hello from bashrc\nexport PATH="$HOME/tools:$PATH"\n`,
        )
        const p = await loginShellPath({
          env: { SHELL: '/bin/bash', HOME: fake, PATH: '/usr/bin:/bin' },
          home: fake,
        })
        expect(p.split(':')[0]).toBe(path.join(fake, 'tools'))
        expect(p.split(':')).toContain('/usr/bin')
      } finally {
        fs.rmSync(fake, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'linux' && fs.existsSync('/bin/bash'))(
    'takes the PATH of a real bash whose .bashrc leaves a job in the background, at once, and leaves the job running',
    async () => {
      const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-shell-'))
      const pidFile = path.join(fake, 'job.pid')
      try {
        fs.writeFileSync(path.join(fake, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n')
        fs.writeFileSync(
          path.join(fake, '.bashrc'),
          `export PATH="$HOME/tools:$PATH"\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\n`,
        )
        const started = Date.now()
        const p = await loginShellPath({
          env: { SHELL: '/bin/bash', HOME: fake, PATH: '/usr/bin:/bin' },
          home: fake,
        })
        expect(Date.now() - started).toBeLessThan(LOGIN_SHELL_MS / 2)
        expect(p.split(':')[0]).toBe(path.join(fake, 'tools'))
        const pid = Number(fs.readFileSync(pidFile, 'utf8'))
        expect(() => process.kill(pid, 0)).not.toThrow()
        process.kill(pid, 'SIGKILL')
      } finally {
        fs.rmSync(fake, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'linux' && fs.existsSync('/bin/bash'))(
    'leaves a job from .bashrc that prints after the shell has exited to run on past that',
    async () => {
      const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-shell-'))
      const marker = path.join(fake, 'after-echo')
      try {
        fs.writeFileSync(path.join(fake, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n')
        fs.writeFileSync(
          path.join(fake, '.bashrc'),
          `export PATH="$HOME/tools:$PATH"\n( sleep 1; echo tick; touch ${JSON.stringify(marker)} ) &\n`,
        )
        const p = await loginShellPath({
          env: { SHELL: '/bin/bash', HOME: fake, PATH: '/usr/bin:/bin' },
          home: fake,
        })
        expect(p.split(':')[0]).toBe(path.join(fake, 'tools'))
        // The job prints to the shell's output a second later, then goes on; a closed pipe would end it there.
        await waitFor(() => fs.existsSync(marker), 5000)
        expect(fs.existsSync(marker)).toBe(true)
      } finally {
        fs.rmSync(fake, { recursive: true, force: true })
      }
    },
  )
})

/**
 * Polls until `check` holds or `ms` passes.
 * @param {() => boolean} check
 * @param {number} ms
 */
async function waitFor(check, ms) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
}

describe('runCapture', () => {
  it('gives the exit code and the output of a command that ends', async () => {
    const res = await runCapture(process.execPath, ['-e', 'console.log("hi"); process.exit(3)'], {
      timeoutMs: 10_000,
      env: process.env,
    })
    expect(res).toEqual({ code: 3, stdout: 'hi\n' })
  })

  it('answers null for a command that cannot be started', async () => {
    const res = await runCapture(path.join(os.tmpdir(), 'no-such-shell'), [], {
      timeoutMs: 5000,
      env: process.env,
    })
    expect(res.code).toBeNull()
  })

  it.runIf(process.platform !== 'win32')(
    'answers when the command exits, with its code and output, while a background child it left holds its output open, and leaves that child alone',
    async () => {
      const marker = path.join(os.tmpdir(), `agent-board-bg-child-${process.pid}`)
      // The parent prints, starts a child that keeps its stdout and runs on, and exits 0 at once.
      const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); c.unref(); console.log('printed'); setTimeout(() => process.exit(0), 200)`
      const started = Date.now()
      const res = await runCapture(process.execPath, ['-e', script], { timeoutMs: 5000, env: process.env })
      expect(res).toEqual({ code: 0, stdout: 'printed\n' })
      expect(Date.now() - started).toBeLessThan(2500)
      const pid = Number(fs.readFileSync(marker, 'utf8'))
      fs.rmSync(marker, { force: true })
      try {
        // Still running: process.kill(pid, 0) throws for a process that is gone.
        expect(() => process.kill(pid, 0)).not.toThrow()
      } finally {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    },
  )

  it.runIf(process.platform === 'linux' && fs.existsSync('/bin/sh'))(
    'keeps reading for a background child that prints after the command has exited, so the child runs on',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-bg-print-'))
      const marker = path.join(dir, 'after-echo')
      try {
        const script = `( sleep 1; echo tick; touch ${JSON.stringify(marker)} ) & echo printed`
        const started = Date.now()
        const res = await runCapture('/bin/sh', ['-c', script], { timeoutMs: 5000, env: process.env })
        expect(res).toEqual({ code: 0, stdout: 'printed\n' })
        expect(Date.now() - started).toBeLessThan(900)
        // Its echo comes after the answer; on a closed pipe it would die there and never reach the touch.
        await waitFor(() => fs.existsSync(marker), 5000)
        expect(fs.existsSync(marker)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'answers at the timeout even while something it started holds its output open, and kills that too',
    async () => {
      const marker = path.join(os.tmpdir(), `agent-board-grandchild-${process.pid}`)
      const script = `require('child_process').spawn(process.execPath, ['-e', 'require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
      const started = Date.now()
      const res = await runCapture(process.execPath, ['-e', script], { timeoutMs: 1500, env: process.env })
      expect(res.code).toBeNull()
      expect(Date.now() - started).toBeLessThan(4000)
      await new Promise((r) => setTimeout(r, 300))
      const pid = Number(fs.readFileSync(marker, 'utf8'))
      fs.rmSync(marker, { force: true })
      // Gone, or a zombie waiting for whatever reaps orphans here (in a container, maybe nothing).
      const state = () => {
        try {
          return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0]
        } catch {
          return 'gone'
        }
      }
      expect(['gone', 'Z', 'X']).toContain(state())
    },
  )
})

describe('withLoginPath', () => {
  const resolvePath = async (/** @type {{ inherited?: string }} */ { inherited }) =>
    `/home/u/tools:${inherited ?? ''}`

  it('gives the server the login shell PATH on Linux', async () => {
    const env = { PATH: '/usr/bin', PORT: '47100' }
    expect(await withLoginPath(env, { platform: 'linux', resolvePath })).toEqual({
      PATH: '/home/u/tools:/usr/bin',
      PORT: '47100',
    })
  })

  it('leaves the PATH as it is on Windows', async () => {
    const env = { PATH: 'C:\\Windows', PORT: '47100' }
    expect(await withLoginPath(env, { platform: 'win32', resolvePath })).toBe(env)
    expect(await withLoginPath(env, { configPath: 'C:\\tools', platform: 'win32', resolvePath })).toBe(env)
  })

  it('puts the login dirs into the PATH resolveSettings gives the server', async () => {
    const s = resolveSettings({ env: { PATH: '/usr/bin' }, file: {}, home })
    const { run } = fakeRunner(() => ({ code: 0, stdout: shellSays('/home/u/tools:/usr/bin') }))
    const env = await withLoginPath(s.serverEnv, {
      configPath: s.configPath,
      platform: 'linux',
      resolvePath: (input) => loginShellPath({ ...input, home: '/home/u', run, exists: () => false }),
    })
    expect(env.PATH).toBe('/home/u/tools:/usr/bin')
    expect(env.BOARD_ENV).toBe('production')
  })

  it('puts the PATH of the config file first on Linux, though the app was started with a PATH of its own', async () => {
    const s = resolveSettings({
      env: { PATH: '/usr/bin:/bin' },
      file: { PATH: '~/claude-bin:/opt/tools/bin:$PATH:relative/bin' },
      home,
    })
    // The environment's PATH is the one the settings carry, as for every other key...
    expect(s.serverEnv.PATH).toBe('/usr/bin:/bin')
    const { run } = fakeRunner(() => ({ code: 0, stdout: shellSays('/home/u/.cargo/bin:/usr/bin:/bin') }))
    const env = await withLoginPath(s.serverEnv, {
      configPath: s.configPath,
      home: '/home/u',
      platform: 'linux',
      resolvePath: (input) => loginShellPath({ ...input, home: '/home/u', run, exists: () => false }),
    })
    // ...and the file's folders still come first in the server's, before the login shell's.
    expect(env.PATH).toBe('/home/u/claude-bin:/opt/tools/bin:/home/u/.cargo/bin:/usr/bin:/bin')
  })
})

describe('configPathEntries', () => {
  it('expands ~ to the home folder and leaves out $PATH and relative folders', () => {
    expect(configPathEntries('~:~/bin: /opt/x :$PATH:rel:', '/home/u')).toEqual([
      '/home/u',
      '/home/u/bin',
      '/opt/x',
    ])
    expect(configPathEntries('', '/home/u')).toEqual([])
  })
})

describe('trayHostPresent', () => {
  it('is true when gdbus says the StatusNotifierWatcher has an owner', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, stdout: '(true,)\n' }))
    expect(await trayHostPresent(run, {})).toBe(true)
    expect(calls[0].command).toBe('gdbus')
    expect(calls[0].args).toContain('org.kde.StatusNotifierWatcher')
  })

  it('is false when it has none', async () => {
    const { run } = fakeRunner(() => ({ code: 0, stdout: '(false,)\n' }))
    expect(await trayHostPresent(run, {})).toBe(false)
  })

  it('asks dbus-send when there is no gdbus', async () => {
    const { run, calls } = fakeRunner((command) =>
      command === 'gdbus'
        ? { code: null, stdout: '' }
        : { code: 0, stdout: 'method return time=1 sender=org.freedesktop.DBus\n   boolean true\n' },
    )
    expect(await trayHostPresent(run, {})).toBe(true)
    expect(calls.map((c) => c.command)).toEqual(['gdbus', 'dbus-send'])
  })

  it('is false with no session bus (both fail)', async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: '' }))
    expect(await trayHostPresent(run, {})).toBe(false)
  })
})

describe('restartPlan', () => {
  it('waits 1, 2, 5, 10 and 30 s before the restarts of a server that never comes up, then gives up', () => {
    let state = { exits: 0, healthySince: /** @type {number | null} */ (null) }
    /** @type {(number | null)[]} */
    const delays = []
    for (let i = 0; i <= RESTART_LIMIT; i++) {
      const plan = restartPlan(state, 1000 * i)
      delays.push(plan.delay)
      state = { exits: plan.exits, healthySince: null }
    }
    expect(delays).toEqual([1000, 2000, 5000, 10_000, 30_000, null])
    expect(RESTART_DELAYS_MS).toHaveLength(RESTART_LIMIT)
  })

  it('counts the exits of a server that dies a while after each start, however far apart', () => {
    let state = { exits: 0, healthySince: /** @type {number | null} */ (null) }
    let now = 0
    /** @type {(number | null)[]} */
    const delays = []
    for (let i = 0; i <= RESTART_LIMIT; i++) {
      const plan = restartPlan(state, now)
      delays.push(plan.delay)
      // Up again after the wait, and answering for four minutes before it dies again.
      state = { exits: plan.exits, healthySince: now + (plan.delay ?? 0) }
      now += (plan.delay ?? 0) + HEALTHY_RESET_MS - 60_000
    }
    expect(delays.at(-1)).toBeNull()
  })

  it('forgets the earlier exits once the server has answered for five minutes', () => {
    expect(restartPlan({ exits: RESTART_LIMIT, healthySince: 0 }, HEALTHY_RESET_MS)).toEqual({
      exits: 1,
      delay: 1000,
    })
    expect(restartPlan({ exits: RESTART_LIMIT, healthySince: 0 }, HEALTHY_RESET_MS - 1)).toEqual({
      exits: RESTART_LIMIT + 1,
      delay: null,
    })
  })
})

describe('exitReason', () => {
  it('names the exit code, else the signal', () => {
    expect(exitReason(1, null)).toBe('exit code 1')
    expect(exitReason(0, null)).toBe('exit code 0')
    expect(exitReason(null, 'SIGKILL')).toBe('signal SIGKILL')
    expect(exitReason(null, null)).toBe('no exit code')
  })
})

describe('closeAction', () => {
  it('hides the window on Windows, tray host or not', () => {
    expect(closeAction(false, 'win32')).toBe('hide')
  })

  it('hides it on Linux while a tray host shows the icon, and quits without one', () => {
    expect(closeAction(true, 'linux')).toBe('hide')
    expect(closeAction(false, 'linux')).toBe('quit')
  })
})

describe('autostart', () => {
  it('is ~/.config/autostart/agent-board.desktop, or under an absolute XDG_CONFIG_HOME', () => {
    expect(autostartFile({}, '/home/me')).toBe('/home/me/.config/autostart/agent-board.desktop')
    expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe('/cfg/autostart/agent-board.desktop')
    expect(autostartFile({ XDG_CONFIG_HOME: 'cfg' }, '/home/me')).toBe(
      '/home/me/.config/autostart/agent-board.desktop',
    )
  })

  it('runs the AppImage when the app runs from one, else the executable', () => {
    const exe = '/tmp/.mount_agentXYZ/agent-board'
    const image = '/home/me/Apps/agent-board-0.1.0-x86_64.AppImage'
    expect(autostartExec({ APPIMAGE: image, APPDIR: '/tmp/.mount_agentXYZ' }, exe)).toBe(image)
    expect(autostartExec({ APPIMAGE: image, APPDIR: '/tmp/.mount_agentXYZ/' }, exe)).toBe(image)
    expect(autostartExec({}, '/opt/CrossBoard/agent-board')).toBe('/opt/CrossBoard/agent-board')
    expect(autostartExec({ APPIMAGE: 'relative.AppImage', APPDIR: '/tmp/.mount_agentXYZ' }, exe)).toBe(exe)
    expect(autostartExec({ APPIMAGE: image, APPDIR: 'relative' }, exe)).toBe(exe)
    expect(autostartExec({ APPIMAGE: image }, exe)).toBe(exe)
  })

  it('runs the installed executable when the APPIMAGE it sees belongs to another AppImage', () => {
    // Started from a terminal another AppImage app opened: that image's APPIMAGE and APPDIR are inherited.
    const env = { APPIMAGE: '/home/u/Applications/Other.AppImage', APPDIR: '/tmp/.mount_OtherAB' }
    expect(autostartExec(env, '/opt/CrossBoard/agent-board')).toBe('/opt/CrossBoard/agent-board')
    // A mount whose name only starts like the other's is not inside it.
    expect(autostartExec(env, '/tmp/.mount_OtherABC/agent-board')).toBe('/tmp/.mount_OtherABC/agent-board')
    expect(autostartExec(env, '/tmp/.mount_OtherAB')).toBe('/tmp/.mount_OtherAB')
  })

  it("runs an unpacked AppImage's AppRun, which adds --no-sandbox where it is needed", () => {
    // squashfs-root/AppRun exports neither APPIMAGE nor APPDIR: the app sees only its executable.
    const appRun = '/home/u/squashfs-root/AppRun'
    const isExecutable = (/** @type {string} */ p) => p === appRun
    expect(autostartExec({}, '/home/u/squashfs-root/agent-board', isExecutable)).toBe(appRun)
    const spaced = '/home/u/My Apps/squashfs-root/AppRun'
    expect(autostartExec({}, '/home/u/My Apps/squashfs-root/agent-board', (p) => p === spaced)).toBe(spaced)
    expect(autostartEntry({ exec: spaced, name: 'CrossBoard' }).split('\n')).toContain(
      'Exec="/home/u/My Apps/squashfs-root/AppRun"',
    )
    // The mounted AppImage still starts the image, though its mount has an AppRun too.
    const image = '/home/me/Apps/agent-board-0.1.0-x86_64.AppImage'
    const env = { APPIMAGE: image, APPDIR: '/tmp/.mount_agentXYZ' }
    expect(autostartExec(env, '/tmp/.mount_agentXYZ/agent-board', () => true)).toBe(image)
  })

  it('runs the installed executable, which has no AppRun beside it', () => {
    const exe = '/opt/CrossBoard/agent-board'
    const asked = /** @type {string[]} */ ([])
    const isExecutable = (/** @type {string} */ p) => (asked.push(p), false)
    expect(autostartExec({}, exe, isExecutable)).toBe(exe)
    expect(asked).toEqual(['/opt/CrossBoard/AppRun'])
  })

  it.runIf(process.platform !== 'win32')('finds an AppRun only when it is a file this user may run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-apprun-'))
    try {
      const exe = path.join(dir, 'agent-board')
      const appRun = path.join(dir, 'AppRun')
      expect(autostartExec({}, exe)).toBe(exe)
      fs.writeFileSync(appRun, '#!/bin/sh\n', { mode: 0o644 })
      expect(autostartExec({}, exe)).toBe(exe)
      fs.chmodSync(appRun, 0o755)
      expect(autostartExec({}, exe)).toBe(appRun)
      fs.rmSync(appRun)
      fs.mkdirSync(appRun)
      expect(autostartExec({}, exe)).toBe(exe)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes an entry that starts it at login', () => {
    const text = autostartEntry({ exec: '/opt/CrossBoard/agent-board', name: 'CrossBoard' })
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        '[Desktop Entry]',
        'Type=Application',
        'Name=CrossBoard',
        'Exec=/opt/CrossBoard/agent-board',
        'Icon=agent-board',
        'Terminal=false',
      ]),
    )
  })

  it('quotes an Exec that needs it, as the desktop entry spec says', () => {
    expect(desktopExecArg('/opt/CrossBoard/agent-board')).toBe('/opt/CrossBoard/agent-board')
    expect(desktopExecArg('/home/me/My Apps/a.AppImage')).toBe('"/home/me/My Apps/a.AppImage"')
    expect(desktopExecArg('/home/me/$x/"a"')).toBe('"/home/me/\\\\$x/\\\\"a\\\\""')
    expect(desktopExecArg('/home/me/100%/a')).toBe('/home/me/100%%/a')
  })

  it('is written when turned on and removed when turned off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-autostart-'))
    try {
      const file = path.join(dir, 'autostart', 'agent-board.desktop')
      const entry = { file, exec: '/opt/CrossBoard/agent-board', name: 'CrossBoard' }
      setAutostart(true, entry)
      expect(fs.readFileSync(file, 'utf8')).toContain('Exec=/opt/CrossBoard/agent-board')
      setAutostart(false, entry)
      expect(fs.existsSync(file)).toBe(false)
      setAutostart(false, entry)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
