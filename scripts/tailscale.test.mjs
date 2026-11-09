import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  funnelled,
  parseTailscaleJson,
  READS,
  servedAt,
  tailscaleAsync,
  tailscaleCommand,
  tailscaleSync,
} from '../src/server/tailscale.mjs'

// The shared module the board and `pnpm tailnet` read Tailscale through. The CLI is an edge: a stand-in
// (TAILSCALE_BIN) that records every argv it is run with and answers each read from the state the case gives it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-tailscale-module-'))
const fake = path.join(tmp, 'fake-tailscale.mjs')
const log = path.join(tmp, 'calls.log')
const stateFile = path.join(tmp, 'state.json')
fs.writeFileSync(
  fake,
  `import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_TAILSCALE_LOG, JSON.stringify(args) + '\\n')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_TAILSCALE_STATE, 'utf8'))
const answer = state[args.join(' ')]
if (answer === undefined) {
  process.stderr.write('fake tailscale: nothing for ' + args.join(' ') + '\\n')
  process.exit(1)
}
process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer))
`,
)

const calls = () =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).join(' '))
    : []

const saved = { TAILSCALE_BIN: process.env.TAILSCALE_BIN, FAKE_TAILSCALE_LOG: process.env.FAKE_TAILSCALE_LOG }
beforeAll(() => {
  process.env.TAILSCALE_BIN = fake
  process.env.FAKE_TAILSCALE_LOG = log
  process.env.FAKE_TAILSCALE_STATE = stateFile
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: '1.80.2\n', 'status --json': { BackendState: 'Running' } }),
  )
})
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the Tailscale reads', () => {
  it('are the four reads, and no other call is made or built', () => {
    expect([...READS]).toEqual(['version', 'status --json', 'serve status --json', 'funnel status --json'])
    for (const args of [
      ['serve', '--bg', '--https=443', 'http://127.0.0.1:47100'],
      ['serve', '--https=443', 'off'],
      ['funnel', '--https=443', 'on'],
      ['funnel', 'status'],
      ['up'],
    ])
      expect(() => tailscaleCommand(args), args.join(' ')).toThrow(/is not a read: refused/)
  })

  it('refuses a write before the CLI runs: the fake records no call for it', () => {
    fs.rmSync(log, { force: true })
    expect(() => tailscaleSync('funnel', '--https=443', 'on')).toThrow(/is not a read: refused/)
    expect(() => tailscaleSync('serve', '--bg', '--https=443', 'http://127.0.0.1:47100')).toThrow(
      /is not a read: refused/,
    )
    expect(calls()).toEqual([])
  })

  it('answers each read from the CLI, synchronously and asynchronously, and only reads reach it', async () => {
    fs.rmSync(log, { force: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ version: '1.80.2\n  commit\n', 'status --json': { BackendState: 'Running' } }),
    )
    expect(tailscaleSync('version').split('\n')[0]).toBe('1.80.2')
    expect(JSON.parse(await tailscaleAsync('status', '--json'))).toEqual({ BackendState: 'Running' })
    expect(calls()).toEqual(['version', 'status --json'])
  })

  it('fails with the error code ENOENT when the CLI is not there', async () => {
    const missing = path.join(tmp, 'no-such-tailscale')
    const before = process.env.TAILSCALE_BIN
    process.env.TAILSCALE_BIN = missing
    try {
      await expect(tailscaleAsync('version')).rejects.toMatchObject({ code: 'ENOENT' })
      let caught
      try {
        tailscaleSync('version')
      } catch (err) {
        caught = err
      }
      expect(caught).toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env.TAILSCALE_BIN = before
    }
  })

  it('fails as ENOENT when a TAILSCALE_BIN script is not there either', async () => {
    const before = process.env.TAILSCALE_BIN
    process.env.TAILSCALE_BIN = path.join(tmp, 'gone', 'tailscale.mjs')
    try {
      await expect(tailscaleAsync('status', '--json')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env.TAILSCALE_BIN = before
    }
  })

  it('reads an empty answer as an empty object, and refuses one that is not JSON', () => {
    expect(parseTailscaleJson('  \n', ['serve', 'status', '--json'])).toEqual({})
    expect(parseTailscaleJson('{"a":1}', ['status', '--json'])).toEqual({ a: 1 })
    expect(() => parseTailscaleJson('not json', ['status', '--json'])).toThrow(
      /tailscale status --json did not print JSON/,
    )
  })
})

describe('what a serve and funnel config says', () => {
  it('finds every host:port Funnel is on for, foreground sessions included', () => {
    expect(funnelled({})).toEqual([])
    expect(funnelled({ AllowFunnel: { 'devbox.example.ts.net:443': false } })).toEqual([])
    expect(funnelled({ AllowFunnel: { 'devbox.example.ts.net:443': true } })).toEqual([
      { hostPort: 'devbox.example.ts.net:443', where: null },
    ])
    expect(
      funnelled({
        AllowFunnel: { 'devbox.example.ts.net:8443': true },
        Foreground: { 'session-1': { AllowFunnel: { 'devbox.example.ts.net:10000': true } } },
      }),
    ).toEqual([
      { hostPort: 'devbox.example.ts.net:8443', where: null },
      { hostPort: 'devbox.example.ts.net:10000', where: 'session-1' },
    ])
  })

  it('says what a host:port is served with, or nothing', () => {
    const config = {
      Web: {
        'devbox.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47100' } } },
        'devbox.example.ts.net:8443': { Handlers: { '/': { Text: 'hi' } } },
      },
    }
    expect(servedAt(config, 'devbox.example.ts.net', 443)).toBe('http://127.0.0.1:47100')
    expect(servedAt(config, 'devbox.example.ts.net', 8443)).toBe('hi')
    expect(servedAt(config, 'devbox.example.ts.net', 9443)).toBeNull()
    expect(servedAt(undefined, 'devbox.example.ts.net', 443)).toBeNull()
  })
})
