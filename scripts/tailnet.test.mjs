import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailnet.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-tailnet-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const NAME = 'devbox.example-tailnet.ts.net'

// The Tailscale CLI is an edge: a stand-in that records every argv it is run with (a JSON line each) and
// answers each read from the state the case gives it, as `tailscale` prints them.
const fake = path.join(tmp, 'fake-tailscale.mjs')
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

/** Tailscale on this machine, running, with MagicDNS and HTTPS on, serving nothing yet. */
const tailnet = (over = {}) => ({
  version: '1.80.2\n  tailscale commit: 0000000\n',
  'status --json': {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, HostName: 'devbox' },
    CertDomains: [NAME],
  },
  'serve status --json': {},
  'funnel status --json': {},
  ...over,
})

/** The board: a stand-in answering /api/me with the given status (401 with its gate, 200 without). */
async function board(status) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/api/me' ? status : 404, { 'content-type': 'application/json' })
    res.end(status === 200 ? '{"actor":"human","authOff":true}' : '{"error":"sign in"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}
const portOf = (server) => server.address().port

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

let runs = 0
/** Runs the helper in a checkout whose .env holds `dotenv`, with the fake answering from `state`. */
function run(args, { dotenv = {}, state = tailnet(), bin = fake } = {}) {
  const dir = path.join(tmp, `run-${++runs}`)
  fs.mkdirSync(dir)
  fs.writeFileSync(
    path.join(dir, '.env'),
    Object.entries(dotenv)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  )
  const log = path.join(dir, 'tailscale.log')
  const stateFile = path.join(dir, 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify(state))
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [helper, ...args],
      {
        cwd: dir,
        env: { ...process.env, TAILSCALE_BIN: bin, FAKE_TAILSCALE_LOG: log, FAKE_TAILSCALE_STATE: stateFile },
      },
      (err, stdout, stderr) => {
        const calls = fs.existsSync(log)
          ? fs
              .readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : []
        resolve({ code: err ? err.code : 0, stdout, stderr, calls })
      },
    )
  })
}

/** The read-only subcommands, and nothing that changes what Tailscale serves. */
const READS = [
  ['version'],
  ['status', '--json'],
  ['serve', 'status', '--json'],
  ['funnel', 'status', '--json'],
]
const onlyReads = (calls) => {
  for (const call of calls) expect(READS, JSON.stringify(call)).toContainEqual(call)
  expect(calls.some((c) => c[0] === 'funnel' && c[1] !== 'status')).toBe(false)
  expect(calls.some((c) => c[0] === 'serve' && c[1] !== 'status')).toBe(false)
}

const entrance = (gatePort = 47111) => ({
  PUBLIC_ORIGIN: `https://${NAME}`,
  PUBLIC_GATE_URL: `https://${NAME}:8443`,
  PUBLIC_GATE_AUTH_URL: `http://127.0.0.1:${gatePort}`,
})

let gated
beforeAll(async () => {
  gated = await board(401)
})
afterAll(() => gated.close())

// Each run starts node for the helper and once more per tailscale read: slow on a busy machine.
const slow = { timeout: 60_000 }

describe('pnpm tailnet', slow, () => {
  it('prints the serve commands, the URL and how to stop, and only reads', async () => {
    const port = portOf(gated)
    const res = await run([], { dotenv: { PORT: port, ...entrance(47111) } })
    expect(res.code, res.stderr).toBe(0)
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim())
    expect(lines).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)
    expect(lines).toContain('tailscale serve --bg --https=8443 http://127.0.0.1:47111')
    expect(res.stdout).toContain(`https://${NAME}/`)
    expect(lines).toContain('tailscale serve --https=443 off')
    expect(lines).toContain('tailscale serve --https=8443 off')
    expect(res.stderr).toBe('')
    onlyReads(res.calls)
    expect(res.calls).toEqual(READS)
  })

  it("takes the public gate's port from PUBLIC_GATE_AUTH_URL, and the board's port as --port or --target", async () => {
    const port = portOf(gated)
    for (const args of [
      [],
      ['--port', String(port)],
      [`--port=${port}`],
      ['--target', `http://127.0.0.1:${port}`],
      [`http://localhost:${port}`],
    ]) {
      const res = await run(args, { dotenv: { PORT: port, ...entrance(47262) } })
      expect(res.code, `${args} ${res.stderr}`).toBe(0)
      expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      expect(res.stdout).toContain('tailscale serve --bg --https=8443 http://127.0.0.1:47262\n')
      onlyReads(res.calls)
    }
  })

  it('warns when .env does not name this machine, and still prints', async () => {
    const port = portOf(gated)
    const res = await run([], { dotenv: { PORT: port, TAILNET_HOST: 'other.example-tailnet.ts.net' } })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain(`.env has no PUBLIC_ORIGIN: set PUBLIC_ORIGIN=https://${NAME}`)
    expect(res.stderr).toContain(`set PUBLIC_GATE_URL=https://${NAME}:8443`)
    expect(res.stderr).toContain('set PUBLIC_GATE_AUTH_URL=http://127.0.0.1:47111')
    expect(res.stderr).toContain(`set TAILNET_HOST=${NAME}`)
    expect(res.stdout).toContain('tailscale serve --bg --https=8443 http://127.0.0.1:47111')
    const wrong = await run([], {
      dotenv: { PORT: port, ...entrance(), PUBLIC_ORIGIN: 'https://old.example-tailnet.ts.net' },
    })
    expect(wrong.stderr).toContain(
      `.env has PUBLIC_ORIGIN=https://old.example-tailnet.ts.net: set PUBLIC_ORIGIN=https://${NAME}`,
    )
  })

  it('warns when the board does not answer yet, and still prints', async () => {
    const port = await freePort()
    const res = await run([], { dotenv: { PORT: port, ...entrance() } })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain(`nothing answers on 127.0.0.1:${port} yet`)
    expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)
  })

  it('says what a handler already on 443 serves, and that the command replaces it', async () => {
    const port = portOf(gated)
    const serve = { Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }
    const res = await run([], {
      dotenv: { PORT: port, ...entrance() },
      state: tailnet({ 'serve status --json': serve }),
    })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('443 serves http://127.0.0.1:3000 now: the command below replaces it')
  })
})

describe('pnpm tailnet refuses', slow, () => {
  it('while Funnel is on, at the top level or in a foreground session, and runs no serve', async () => {
    const port = portOf(gated)
    for (const state of [
      tailnet({ 'serve status --json': { AllowFunnel: { [`${NAME}:443`]: true } } }),
      tailnet({
        'serve status --json': { AllowFunnel: { [`${NAME}:8443`]: false, [`${NAME}:10000`]: true } },
      }),
      tailnet({
        'serve status --json': { Foreground: { abc123: { AllowFunnel: { [`${NAME}:8443`]: true } } } },
      }),
      tailnet({ 'funnel status --json': { AllowFunnel: { [`${NAME}:443`]: true } } }),
    ]) {
      const res = await run([], { dotenv: { PORT: port, ...entrance() }, state })
      expect(res.code, res.stdout).toBe(1)
      expect(res.stderr).toMatch(/Tailscale Funnel is on/)
      expect(res.stderr).toMatch(/tailscale funnel --https=\d+ off/)
      expect(res.stdout).not.toContain('tailscale serve --bg')
      onlyReads(res.calls)
    }
    const res = await run([], {
      dotenv: { PORT: port },
      state: tailnet({ 'serve status --json': { AllowFunnel: { [`${NAME}:443`]: true } } }),
    })
    expect(res.stderr).toContain('tailscale funnel --https=443 off')
  })

  it('a port other than the board’s, or a target not on loopback, before asking Tailscale anything', async () => {
    const port = portOf(gated)
    for (const args of [
      ['--port', String(port + 1)],
      [`--port=${port + 1}`],
      ['--target', `http://192.168.1.20:${port}`],
      [`http://192.168.1.20:${port}`],
      ['--target', `http://${NAME}:${port}`],
      ['--target', `https://127.0.0.1:${port}`],
      ['--target', `http://127.0.0.1:${port + 1}`],
      ['--target', `http://127.0.0.1:${port}/admin`],
      ['--target', 'not a url'],
    ]) {
      const res = await run(args, { dotenv: { PORT: port, ...entrance() } })
      expect(res.code, `${args}`).toBe(1)
      expect(res.stderr).toMatch(/board|loopback|path/)
      expect(res.calls, `${args}`).toEqual([])
    }
    // PORT unset: the board is on 47100, and nothing else is.
    const preview = await run(['--port', '47101'])
    expect(preview.code).toBe(1)
    expect(preview.stderr).toContain("--port 47101 is not the board's port")
    expect(preview.stderr).toContain('127.0.0.1:47100')
    expect(preview.calls).toEqual([])
  })

  it('a public gate that is not on loopback', async () => {
    const res = await run([], {
      dotenv: { PORT: portOf(gated), ...entrance(), PUBLIC_GATE_AUTH_URL: 'http://192.168.1.20:47111' },
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toContain(
      'PUBLIC_GATE_AUTH_URL in .env (http://192.168.1.20:47111) is not on loopback',
    )
    expect(res.calls).toEqual([])
  })

  it('a board that answers /api/me without signing in: its gate is off', async () => {
    const open = await board(200)
    try {
      const res = await run([], { dotenv: { PORT: portOf(open), ...entrance() } })
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('answers /api/me without signing in')
      expect(res.stdout).not.toContain('tailscale serve --bg')
      onlyReads(res.calls)
    } finally {
      open.close()
    }
  })

  it('without Tailscale, signed out, or without a tailnet name', async () => {
    const port = portOf(gated)
    const missing = await run([], { dotenv: { PORT: port }, bin: path.join(tmp, 'no-such-tailscale') })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('Tailscale is not installed here')
    const stopped = await run([], {
      dotenv: { PORT: port },
      state: tailnet({ 'status --json': { BackendState: 'NeedsLogin', Self: { DNSName: '' } } }),
    })
    expect(stopped.code).toBe(1)
    expect(stopped.stderr).toContain('Tailscale is NeedsLogin on this machine')
    const nameless = await run([], {
      dotenv: { PORT: port },
      state: tailnet({ 'status --json': { BackendState: 'Running', Self: { DNSName: '' } } }),
    })
    expect(nameless.code).toBe(1)
    expect(nameless.stderr).toContain('turn on MagicDNS')
    for (const res of [stopped, nameless]) onlyReads(res.calls)
  })

  it('an option it does not know: it has no flag that would apply anything', async () => {
    for (const args of [
      ['--apply'],
      ['--yes'],
      ['-y'],
      ['--port', '47100', 'http://127.0.0.1:47100', 'extra'],
    ]) {
      const res = await run(args)
      expect(res.code, `${args}`).toBe(1)
      expect(res.stderr).toContain('usage: pnpm tailnet')
      expect(res.calls).toEqual([])
    }
  })
})
