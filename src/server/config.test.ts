import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  authOffBanner,
  builtServerBind,
  checkBind,
  entranceIgnored,
  LIVE_PORT,
  readAuthMode,
  readClaudeArgs,
  readClaudeTimeout,
  readPort,
  readPublicEntrance,
  readServedEntrance,
  StartupError,
} from './config'

const safe = { host: '127.0.0.1', port: 47131 }

describe('readAuthMode', () => {
  it('is production, with sign-in, when BOARD_ENV is unset or empty', () => {
    expect(readAuthMode({})).toEqual({ boardEnv: 'production', off: false, human: null })
    expect(readAuthMode({ BOARD_ENV: '' })).toEqual({ boardEnv: 'production', off: false, human: null })
    expect(readAuthMode({ BOARD_ENV: 'production', AUTH: 'on' }).off).toBe(false)
  })

  it('refuses AUTH=off in production, however it is spelled', () => {
    for (const env of [{ AUTH: 'off' }, { BOARD_ENV: 'production', AUTH: 'off' }, { AUTH: ' OFF ' }])
      expect(() => readAuthMode(env)).toThrow(StartupError)
    expect(() => readAuthMode({ AUTH: 'off' })).toThrow(
      'AUTH=off is refused with BOARD_ENV=production: the live board always requires sign-in',
    )
  })

  it('refuses an unknown BOARD_ENV or AUTH', () => {
    expect(() => readAuthMode({ BOARD_ENV: 'prod' })).toThrow(/BOARD_ENV must be one of/)
    expect(() => readAuthMode({ BOARD_ENV: 'staging', AUTH: 'off' })).toThrow(StartupError)
    expect(() => readAuthMode({ BOARD_ENV: 'development', AUTH: 'false' })).toThrow(/AUTH must be on or off/)
    expect(() => readAuthMode({ AUTH: '0' })).toThrow(StartupError)
  })

  it('keeps sign-in in development unless AUTH=off', () => {
    expect(readAuthMode({ BOARD_ENV: 'development' })).toEqual({
      boardEnv: 'development',
      off: false,
      human: null,
    })
    expect(readAuthMode({ BOARD_ENV: 'development', AUTH: 'on', DEV_HUMAN: 'me' }).off).toBe(false)
    expect(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })).toEqual({
      boardEnv: 'development',
      off: true,
      human: null,
    })
    expect(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off', DEV_HUMAN: ' Enrique ' }).human).toBe(
      'Enrique',
    )
  })

  it('never signs anyone in in test, with the human named by TEST_HUMAN or `human`', () => {
    expect(readAuthMode({ BOARD_ENV: 'test' })).toEqual({ boardEnv: 'test', off: true, human: 'human' })
    expect(readAuthMode({ BOARD_ENV: 'test', AUTH: 'on', TEST_HUMAN: 'qa' })).toEqual({
      boardEnv: 'test',
      off: true,
      human: 'qa',
    })
  })
})

describe('checkBind', () => {
  const test = readAuthMode({ BOARD_ENV: 'test' })
  const devOff = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })

  it('lets a board without sign-in listen on loopback, on any port but the live one', () => {
    for (const auth of [test, devOff])
      for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST'])
        expect(() => checkBind(auth, { host, port: 47131 })).not.toThrow()
  })

  it('refuses every other address, and every interface', () => {
    for (const auth of [test, devOff])
      for (const host of [undefined, '', '0.0.0.0', '::', '192.168.1.20', 'board.example.com', '127.0.0.2'])
        expect(() => checkBind(auth, { host, port: 47131 })).toThrow(/only listens on loopback/)
    expect(() => checkBind(test, { host: '0.0.0.0', port: 47131 })).toThrow(
      /^sign-in is off \(BOARD_ENV=test\), so the board only listens on loopback/,
    )
  })

  it("refuses the live board's port", () => {
    expect(LIVE_PORT).toBe(47100)
    for (const auth of [test, devOff])
      expect(() => checkBind(auth, { ...safe, port: 47100 })).toThrow(/live board's port/)
  })

  it('leaves a board with sign-in alone, wherever it listens', () => {
    for (const env of [{}, { BOARD_ENV: 'development' }])
      for (const bind of [
        { host: undefined, port: 47100 },
        { host: '0.0.0.0', port: 3000 },
      ])
        expect(() => checkBind(readAuthMode(env), bind)).not.toThrow()
  })
})

describe('builtServerBind', () => {
  it("reads HOST and PORT the way Nitro's node server does", () => {
    expect(builtServerBind({ HOST: '127.0.0.1', PORT: '47131' })).toEqual({ host: '127.0.0.1', port: 47131 })
    expect(
      builtServerBind({ NITRO_HOST: '0.0.0.0', HOST: '127.0.0.1', NITRO_PORT: '47100', PORT: '1' }),
    ).toEqual({ host: '0.0.0.0', port: 47100 })
    // No HOST: Nitro listens on every interface, which a board without sign-in refuses.
    expect(builtServerBind({ PORT: '47131' })).toEqual({ host: undefined, port: 47131 })
    expect(builtServerBind({})).toEqual({ host: undefined, port: 3000 })
  })
})

describe('authOffBanner', () => {
  it('says sign-in is off, who you are and not to expose it', () => {
    expect(authOffBanner(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' }), 'enrique')).toBe(
      'AUTH OFF: development, signed in as enrique, do not expose this',
    )
    expect(authOffBanner(readAuthMode({ BOARD_ENV: 'test' }), 'human')).toMatch(
      /^AUTH OFF: test, signed in as human, do not expose this .*X-Test-Actor/,
    )
  })

  it('names every X-Test-Actor form in test, the orchestrator included', () => {
    const banner = authOffBanner(readAuthMode({ BOARD_ENV: 'test' }), 'human')
    for (const form of ['human:<name>', 'agent:<name>', 'orchestrator:<name>']) expect(banner).toContain(form)
    expect(authOffBanner(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' }), 'enrique')).not.toContain(
      'orchestrator',
    )
  })
})

describe('readPort', () => {
  it('is PORT, else 47100', () => {
    expect(readPort({ PORT: '47264' })).toBe(47264)
    expect(readPort({ PORT: '' })).toBe(47100)
    expect(readPort({})).toBe(47100)
  })
})

describe('the tailnet entrance', () => {
  const keys = { PUBLIC_ORIGIN: 'https://devbox.example-tailnet.ts.net' }
  const entrance = { origin: 'https://devbox.example-tailnet.ts.net', host: 'devbox.example-tailnet.ts.net' }

  it('is off when PUBLIC_ORIGIN is not set', () => {
    expect(readPublicEntrance({})).toBeNull()
    expect(readPublicEntrance({ PUBLIC_ORIGIN: ' ' })).toBeNull()
    expect(readServedEntrance({})).toBeNull()
  })

  it('reads PUBLIC_ORIGIN as an origin, and its host as the public host', () => {
    expect(readPublicEntrance(keys)).toEqual(entrance)
    expect(readPublicEntrance({ PUBLIC_ORIGIN: ' https://DevBox.Example-Tailnet.ts.net/ ' })).toEqual(
      entrance,
    )
  })

  it('refuses a board origin that is not https://<host>: no port, no path, no wildcard, no IP', () => {
    for (const origin of [
      'http://devbox.example-tailnet.ts.net',
      'https://devbox.example-tailnet.ts.net:443',
      'https://devbox.example-tailnet.ts.net:8080',
      'https://devbox.example-tailnet.ts.net/board',
      'https://devbox.example-tailnet.ts.net/?x=1',
      'https://devbox.example-tailnet.ts.net#top',
      'https://me@devbox.example-tailnet.ts.net',
      'https://*.example-tailnet.ts.net',
      'https://*.ts.net',
      'https://*',
      'https://ts.net.',
      'https://100.101.102.103',
      'https://[fd7a:115c:a1e0::1]',
      'https://localhost',
      'https://<machine>.<tailnet>.ts.net',
      'devbox.example-tailnet.ts.net',
    ])
      expect(() => readPublicEntrance({ PUBLIC_ORIGIN: origin }), origin).toThrow(
        /^PUBLIC_ORIGIN must be https:\/\/<machine>\.<tailnet>\.ts\.net/,
      )
  })

  it('is served with sign-in on, in production and in development', () => {
    expect(readServedEntrance(keys)).toEqual(entrance)
    expect(readServedEntrance({ ...keys, BOARD_ENV: 'production', AUTH: 'on' })).toEqual(entrance)
    expect(readServedEntrance({ ...keys, BOARD_ENV: 'development' })).toEqual(entrance)
  })

  it('is ignored with sign-in off (test, development with AUTH=off), and says so', () => {
    for (const env of [{ BOARD_ENV: 'test' }, { BOARD_ENV: 'development', AUTH: 'off' }]) {
      expect(readServedEntrance({ ...keys, ...env })).toBeNull()
      expect(entranceIgnored(readAuthMode(env))).toMatch(
        new RegExp(`^sign-in is off \\(${env.BOARD_ENV}\\), so PUBLIC_ORIGIN is ignored: .*loopback only`),
      )
    }
    // Ignored, but still checked: a PUBLIC_ORIGIN it cannot trust stops a board without sign-in too.
    expect(() => readServedEntrance({ BOARD_ENV: 'test', PUBLIC_ORIGIN: 'http://devbox' })).toThrow(
      StartupError,
    )
  })

  it('does not change who answers, or where a board without sign-in may listen', () => {
    expect(readAuthMode({ ...keys })).toEqual({ boardEnv: 'production', off: false, human: null })
    expect(() => readAuthMode({ ...keys, AUTH: 'off' })).toThrow(/AUTH=off is refused/)
    const test = readAuthMode({ ...keys, BOARD_ENV: 'test' })
    expect(() => checkBind(test, { host: '0.0.0.0', port: 47131 })).toThrow(/only listens on loopback/)
    expect(() => checkBind(test, { host: '127.0.0.1', port: 47100 })).toThrow(/live board's port/)
  })
})

describe('servedEntrance', () => {
  // Read once, as the module loads its environment: each case loads a fresh copy.
  const load = async (env: Record<string, string>) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.resetModules()
    return (await import('./config')).servedEntrance()
  }
  afterEach(() => vi.unstubAllEnvs())

  it("is the process's entrance, read from its environment", async () => {
    const keys = { PUBLIC_ORIGIN: 'https://devbox.example-tailnet.ts.net' }
    expect(await load({ ...keys, BOARD_ENV: 'production', AUTH: '' })).toMatchObject({
      host: 'devbox.example-tailnet.ts.net',
    })
    expect(await load({ ...keys, BOARD_ENV: 'test' })).toBeNull()
    expect(await load({ PUBLIC_ORIGIN: '', BOARD_ENV: 'production' })).toBeNull()
  })
})

describe('claudeHome', () => {
  // The value is read once, as the module loads: each case loads a fresh copy under its own environment.
  const load = async (value: string) => {
    vi.stubEnv('CLAUDE_HOME', value)
    vi.resetModules()
    return (await import('./config')).config.claudeHome
  }
  afterEach(() => vi.unstubAllEnvs())

  it('is ~/.claude of the user the board runs as, unless CLAUDE_HOME names another folder', async () => {
    expect(await load('')).toBe(path.join(os.homedir(), '.claude'))
    expect(await load('~/elsewhere/.claude')).toBe(path.join(os.homedir(), 'elsewhere', '.claude'))
    expect(await load('rel/.claude')).toBe(path.resolve('rel', '.claude'))
  })
})

describe('readClaudeArgs', () => {
  it('is no arguments when unset, else the JSON array of strings given', () => {
    expect(readClaudeArgs(undefined)).toEqual([])
    expect(readClaudeArgs(' ')).toEqual([])
    expect(readClaudeArgs('["e2e/fake-claude.mjs", "--slow"]')).toEqual(['e2e/fake-claude.mjs', '--slow'])
  })

  it('refuses anything else', () => {
    for (const raw of ['e2e/fake-claude.mjs', '{"a": 1}', '[1]', '"x"'])
      expect(() => readClaudeArgs(raw)).toThrow(/CLAUDE_ARGS must be a JSON array of strings/)
  })
})

describe('readClaudeTimeout', () => {
  it('is two minutes when unset, else the milliseconds given', () => {
    expect(readClaudeTimeout(undefined)).toBe(120_000)
    expect(readClaudeTimeout('')).toBe(120_000)
    expect(readClaudeTimeout('1500')).toBe(1500)
  })

  it('refuses anything but a whole number above 0', () => {
    for (const raw of ['0', '-5', '1.5', 'soon'])
      expect(() => readClaudeTimeout(raw)).toThrow(/CLAUDE_TIMEOUT_MS must be/)
  })
})
