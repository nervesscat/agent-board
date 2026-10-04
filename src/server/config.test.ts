import { describe, expect, it } from 'vitest'

import { authOffBanner, builtServerBind, checkBind, LIVE_PORT, readAuthMode, StartupError } from './config'

const safe = { host: '127.0.0.1', port: 47131 }

describe('readAuthMode', () => {
  it('is production, with the gate, when BOARD_ENV is unset or empty', () => {
    expect(readAuthMode({})).toEqual({ boardEnv: 'production', off: false, human: null })
    expect(readAuthMode({ BOARD_ENV: '' })).toEqual({ boardEnv: 'production', off: false, human: null })
    expect(readAuthMode({ BOARD_ENV: 'production', AUTH: 'on' }).off).toBe(false)
  })

  it('refuses AUTH=off in production, however it is spelled', () => {
    for (const env of [{ AUTH: 'off' }, { BOARD_ENV: 'production', AUTH: 'off' }, { AUTH: ' OFF ' }])
      expect(() => readAuthMode(env)).toThrow(StartupError)
    expect(() => readAuthMode({ AUTH: 'off' })).toThrow(/AUTH=off is refused with BOARD_ENV=production/)
  })

  it('refuses an unknown BOARD_ENV or AUTH', () => {
    expect(() => readAuthMode({ BOARD_ENV: 'prod' })).toThrow(/BOARD_ENV must be one of/)
    expect(() => readAuthMode({ BOARD_ENV: 'staging', AUTH: 'off' })).toThrow(StartupError)
    expect(() => readAuthMode({ BOARD_ENV: 'development', AUTH: 'false' })).toThrow(/AUTH must be on or off/)
    expect(() => readAuthMode({ AUTH: '0' })).toThrow(StartupError)
  })

  it('keeps the gate in development unless AUTH=off', () => {
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

  it('never asks the gate in test, with the human named by TEST_HUMAN or `human`', () => {
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

  it('lets a gate-off board listen on loopback, on any port but the live one', () => {
    for (const auth of [test, devOff])
      for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST'])
        expect(() => checkBind(auth, { host, port: 47131 })).not.toThrow()
  })

  it('refuses every other address, and every interface', () => {
    for (const auth of [test, devOff])
      for (const host of [undefined, '', '0.0.0.0', '::', '192.168.1.20', 'board.example.com', '127.0.0.2'])
        expect(() => checkBind(auth, { host, port: 47131 })).toThrow(/only listens on loopback/)
  })

  it("refuses the live board's port", () => {
    expect(LIVE_PORT).toBe(47100)
    for (const auth of [test, devOff])
      expect(() => checkBind(auth, { ...safe, port: 47100 })).toThrow(/live board's port/)
  })

  it('leaves a board with the gate alone, wherever it listens', () => {
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
    // No HOST: Nitro listens on every interface, which a gate-off board refuses.
    expect(builtServerBind({ PORT: '47131' })).toEqual({ host: undefined, port: 47131 })
    expect(builtServerBind({})).toEqual({ host: undefined, port: 3000 })
  })
})

describe('authOffBanner', () => {
  it('says the gate is off, who you are and not to expose it', () => {
    expect(authOffBanner(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' }), 'enrique')).toBe(
      'AUTH OFF: development, signed in as enrique, do not expose this',
    )
    expect(authOffBanner(readAuthMode({ BOARD_ENV: 'test' }), 'human')).toMatch(
      /^AUTH OFF: test, signed in as human, do not expose this .*X-Test-Actor/,
    )
  })
})
