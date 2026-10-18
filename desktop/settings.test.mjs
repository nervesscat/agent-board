import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  appHome,
  CONFIG_FILE,
  CONFIG_TEMPLATE,
  DEFAULT_PORT,
  isPortFree,
  parseConfig,
  portBusyMessage,
  readConfigFile,
  resolveSettings,
  SettingsError,
  tail,
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
})

describe('parseConfig', () => {
  it('reads KEY=value lines as .env does', () => {
    const text = [
      '\uFEFF# a comment',
      '',
      'PORT=8250',
      '  CLAUDE_BIN = C:\\tools\\claude.exe  ',
      'export GATE_URL=http://localhost:47110',
      `DATA_DIR="D:\\board data"`,
      "QUOTED='# not a comment'",
      'TRAILING=value # a comment',
      'EMPTY=',
    ].join('\r\n')
    expect(parseConfig(text)).toEqual({
      PORT: '8250',
      CLAUDE_BIN: 'C:\\tools\\claude.exe',
      GATE_URL: 'http://localhost:47110',
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
