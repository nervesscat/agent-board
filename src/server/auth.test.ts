import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// auth.ts reaches the database through actors.ts, and config.ts reads DATA_DIR as it loads: point it
// at a throwaway directory before either is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const { readAuthMode } = await import('./config')

let auth: typeof import('./auth')
beforeAll(async () => {
  auth = await import('./auth')
  const { db, schema } = await import('#/db')
  db.insert(schema.actors)
    .values([
      { name: 'old-laptop', kind: 'human', lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { name: 'enrique-desktop', kind: 'human', lastSeenAt: '2026-09-01T00:00:00.000Z' },
      { name: 'some-agent', kind: 'agent', lastSeenAt: '2026-10-01T00:00:00.000Z' },
    ])
    .run()
})
afterEach(() => vi.unstubAllGlobals())

const production = readAuthMode({})
const devGate = readAuthMode({ BOARD_ENV: 'development' })
const devOff = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off', DEV_HUMAN: 'enrique' })
const test = readAuthMode({ BOARD_ENV: 'test' })

const req = (headers: Record<string, string> = {}) => new Request('http://localhost/api/me', { headers })

/** A gate that lets every cookie and token in, naming the caller after what it was shown. */
function fakeGate() {
  const gate = vi.fn(async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers)
    const name = h.get('authorization') ? 'token-agent' : 'passkey-human'
    return new Response(null, { status: 200, headers: { 'x-gate-device': name } })
  })
  vi.stubGlobal('fetch', gate)
  return gate
}

describe('with the gate (production, and development without AUTH=off)', () => {
  for (const [label, mode] of [
    ['production', production],
    ['development', devGate],
  ] as const) {
    it(`${label}: ignores X-Test-Actor and asks the gate`, async () => {
      const gate = fakeGate()
      expect(await auth.callerOf(req({ 'x-test-actor': 'human:someone' }), mode)).toBeNull()
      expect(await auth.callerOf(req({ 'x-test-actor': 'agent:bot' }), mode)).toBeNull()
      expect(gate).not.toHaveBeenCalled()
      expect(auth.isAgent(req({ 'x-test-actor': 'agent:bot' }), mode)).toBe(false)

      const cookie = { cookie: `gate_session=${label}`, 'x-test-actor': 'agent:bot' }
      expect(await auth.callerOf(req(cookie), mode)).toEqual({ name: 'passkey-human', kind: 'human' })
      expect(auth.isAgent(req(cookie), mode)).toBe(false)
      const token = { authorization: `Bearer gate_${label}`, 'x-test-actor': 'human:me' }
      expect(await auth.callerOf(req(token), mode)).toEqual({ name: 'token-agent', kind: 'agent' })
      expect(auth.isAgent(req(token), mode)).toBe(true)
      expect(gate).toHaveBeenCalledTimes(2)
    })
  }

  it('turns away a caller the gate refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
    expect(await auth.callerOf(req({ cookie: 'gate_session=refused' }), production)).toBeNull()
  })
})

describe('development with AUTH=off', () => {
  it('makes every request the human, whatever it carries, without asking the gate', async () => {
    const gate = fakeGate()
    for (const headers of [
      {} as Record<string, string>,
      { 'x-test-actor': 'agent:bot' },
      { authorization: 'Bearer gate_x' },
      { cookie: 'gate_session=x' },
    ]) {
      expect(await auth.callerOf(req(headers), devOff)).toEqual({ name: 'enrique', kind: 'human' })
      expect(auth.isAgent(req(headers), devOff)).toBe(false)
    }
    expect(gate).not.toHaveBeenCalled()
  })

  it('without DEV_HUMAN, is the human the board saw sign in last', async () => {
    const mode = readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' })
    expect(await auth.callerOf(req(), mode)).toEqual({ name: 'enrique-desktop', kind: 'human' })
  })
})

describe('test', () => {
  it('takes the caller from X-Test-Actor, and the human without it', async () => {
    const gate = fakeGate()
    expect(await auth.callerOf(req({ 'x-test-actor': 'agent:builder' }), test)).toEqual({
      name: 'builder',
      kind: 'agent',
    })
    expect(await auth.callerOf(req({ 'x-test-actor': 'human: qa ' }), test)).toEqual({
      name: 'qa',
      kind: 'human',
    })
    expect(await auth.callerOf(req(), test)).toEqual({ name: 'human', kind: 'human' })
    // A gate cookie or token does not change who you are: only the header does.
    expect(await auth.callerOf(req({ authorization: 'Bearer gate_x' }), test)).toEqual({
      name: 'human',
      kind: 'human',
    })
    expect(await auth.callerOf(req(), readAuthMode({ BOARD_ENV: 'test', TEST_HUMAN: 'tester' }))).toEqual({
      name: 'tester',
      kind: 'human',
    })
    expect(gate).not.toHaveBeenCalled()
  })

  it('turns away a malformed X-Test-Actor', async () => {
    for (const value of ['', 'bot', 'robot:bot', 'agent:', 'human:  ', `agent:${'x'.repeat(81)}`])
      expect(await auth.callerOf(req({ 'x-test-actor': value }), test)).toBeNull()
  })

  it('isAgent is true for agent: and only for agent:', () => {
    expect(auth.isAgent(req({ 'x-test-actor': 'agent:builder' }), test)).toBe(true)
    expect(auth.isAgent(req({ 'x-test-actor': 'human:qa' }), test)).toBe(false)
    expect(auth.isAgent(req(), test)).toBe(false)
    expect(auth.isAgent(req({ authorization: 'Bearer gate_x' }), test)).toBe(false)
    expect(auth.isAgent(req({ 'x-test-actor': 'bot' }), test)).toBe(false)
  })
})
