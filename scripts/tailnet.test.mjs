import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnv } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readPublicEntrance, StartupError } from '../src/server/config.ts'
import { boardAddress, readDotenv } from './dotenv.mjs'

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

/** The board: a stand-in answering /api/me with the given status (401 with its sign-in, 200 without). */
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
/**
 * Runs the helper in a checkout (`dir`) whose .env holds `dotenv`, its lines ending in `eol`, with the fake
 * answering from `state`.
 */
function run(args, { dotenv = {}, state = tailnet(), bin = fake, eol = '\n' } = {}) {
  const dir = path.join(tmp, `run-${++runs}`)
  fs.mkdirSync(dir)
  fs.writeFileSync(
    path.join(dir, '.env'),
    Object.entries(dotenv)
      .map(([k, v]) => `${k}=${v}${eol}`)
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
        resolve({ code: err ? err.code : 0, stdout, stderr, calls, dir })
      },
    )
  })
}

/** The tailnet entrance the board takes from the .env in `dir`: read with Vite's loadEnv, then its own check. */
const boardEntrance = (dir) => readPublicEntrance(loadEnv('development', dir, ''))

/** Runs `fn` with these variables in this process's environment, which the helper inherits; then restores it. */
async function withShell(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
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

const entrance = () => ({ PUBLIC_ORIGIN: `https://${NAME}` })

let signingIn
beforeAll(async () => {
  signingIn = await board(401)
})
afterAll(() => signingIn.close())

// Each run starts node for the helper and once more per tailscale read: slow on a busy machine.
const slow = { timeout: 60_000 }

describe('pnpm tailnet', slow, () => {
  it('prints the serve command, the URL and how to stop, and only reads', async () => {
    const port = portOf(signingIn)
    const res = await run([], { dotenv: { PORT: port, ...entrance() } })
    expect(res.code, res.stderr).toBe(0)
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim())
    expect(lines).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)
    expect(res.stdout).toContain(`https://${NAME}/`)
    expect(lines).toContain('tailscale serve --https=443 off')
    // The board signs other devices in itself: nothing else goes on the tailnet.
    expect(lines.filter((l) => l.startsWith('tailscale serve'))).toEqual([
      `tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
      'tailscale serve --https=443 off',
    ])
    expect(res.stderr).toBe('')
    onlyReads(res.calls)
    expect(res.calls).toEqual(READS)
  })

  it("takes the board's port as --port or --target", async () => {
    const port = portOf(signingIn)
    for (const args of [
      [],
      ['--port', String(port)],
      [`--port=${port}`],
      ['--target', `http://127.0.0.1:${port}`],
      [`http://localhost:${port}`],
    ]) {
      const res = await run(args, { dotenv: { PORT: port, ...entrance() } })
      expect(res.code, `${args} ${res.stderr}`).toBe(0)
      expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      onlyReads(res.calls)
    }
  })

  it('reads .env as the board does: an inline comment is not part of a value, quoted or not', async () => {
    const port = portOf(signingIn)
    for (const [what, over] of [
      ['PUBLIC_ORIGIN with a comment', { PUBLIC_ORIGIN: `https://${NAME} # the board` }],
      ['PUBLIC_ORIGIN quoted, with a comment', { PUBLIC_ORIGIN: `"https://${NAME}" # note` }],
    ]) {
      const res = await run([], { dotenv: { PORT: port, ...over } })
      expect(res.code, `${what}: ${res.stderr}`).toBe(0)
      expect(res.stdout, what).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      // The board reads the value bare, so nothing is missing: no "set PUBLIC_ORIGIN" warning, no other.
      expect(res.stderr, what).toBe('')
      onlyReads(res.calls)
    }
  })

  it('serves the port pnpm start runs the board on, for the same .env', async () => {
    const port = portOf(signingIn)
    for (const eol of ['\n', '\r\n']) {
      const res = await run([], { dotenv: { PORT: `"${port}" # the board`, ...entrance() }, eol })
      // scripts/start.mjs starts the board on this address...
      expect(boardAddress(readDotenv(path.join(res.dir, '.env')))).toEqual({ port, host: '127.0.0.1' })
      // ...and the helper serves that port.
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      expect(res.stderr).toBe('')
    }
  })

  it('expands ${NAME} and $NAME in .env as the board does, from a line above or below, LF or CRLF', async () => {
    const port = portOf(signingIn)
    for (const eol of ['\n', '\r\n'])
      for (const [what, dotenv] of [
        [
          'PUBLIC_ORIGIN from ${TAILNET_TEST_HOST} above it',
          { PORT: port, TAILNET_TEST_HOST: NAME, PUBLIC_ORIGIN: 'https://${TAILNET_TEST_HOST}' },
        ],
        [
          'PUBLIC_ORIGIN from $TAILNET_TEST_HOST below it',
          { PORT: port, PUBLIC_ORIGIN: 'https://$TAILNET_TEST_HOST', TAILNET_TEST_HOST: NAME },
        ],
      ]) {
        const label = `${what}, ${JSON.stringify(eol)}`
        const res = await run([], { dotenv, eol })
        // The board serves it as this machine's entrance...
        expect(boardEntrance(res.dir), label).toEqual({ origin: `https://${NAME}`, host: NAME })
        // ...and the helper reads it so: the serve command, and nothing to set.
        expect(res.code, `${label}: ${res.stderr}`).toBe(0)
        expect(res.stdout, label).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
        expect(res.stderr, label).toBe('')
        onlyReads(res.calls)
      }
  })

  it("reads .env as Vite's loadEnv, the board's loader, does: references, quotes, comments, the shell", async () => {
    const port = portOf(signingIn)
    const shell = { TAILNET_TEST_SHELL_NAME: 'shell', PORT: String(await freePort()) }
    await withShell(shell, async () => {
      const res = await run([], {
        dotenv: {
          PORT: port,
          // A braced reference to a key further down, and one to a name defined nowhere (empty).
          PUBLIC_ORIGIN: 'https://${TAILNET_TEST_HOST}${TAILNET_TEST_UNDEFINED}',
          // Single-quoted, with a bare reference to a name from the shell, and a comment after it.
          TAILNET_TEST_HOST: "'$TAILNET_TEST_SHELL_NAME.example-tailnet.ts.net' # from the shell",
        },
      })
      const vite = loadEnv('development', res.dir, '')
      expect(vite).toMatchObject({ PUBLIC_ORIGIN: 'https://shell.example-tailnet.ts.net' })
      expect(res.code, res.stderr).toBe(0)
      // The value the helper read, as it prints it, is loadEnv's...
      expect(res.stderr).toContain(`.env has PUBLIC_ORIGIN=${vite.PUBLIC_ORIGIN}: set`)
      // ...but a name .env defines keeps .env's value: loadEnv takes the shell's PORT, while pnpm start runs
      // the board on .env's (scripts/start.mjs), and that is the one to serve.
      expect(vite.PORT).toBe(shell.PORT)
      expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      onlyReads(res.calls)
    })
  })

  it('reads PUBLIC_ORIGIN as the board does: trimmed, any case, a trailing slash aside', async () => {
    const port = portOf(signingIn)
    for (const [what, over] of [
      ['an upper-case host', { PUBLIC_ORIGIN: 'https://DEVBOX.example-tailnet.ts.net' }],
      ['an upper-case scheme and host', { PUBLIC_ORIGIN: 'HTTPS://DevBox.Example-Tailnet.TS.NET' }],
      ['quoted, with spaces and a slash inside the quotes', { PUBLIC_ORIGIN: `"  https://${NAME}/  "` }],
    ]) {
      const res = await run([], { dotenv: { PORT: port, ...over } })
      // The board takes it as this machine's entrance...
      expect(boardEntrance(res.dir), what).toEqual({ origin: `https://${NAME}`, host: NAME })
      // ...so there is nothing to set.
      expect(res.code, `${what}: ${res.stderr}`).toBe(0)
      expect(res.stdout, what).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}\n`)
      expect(res.stderr, what).toBe('')
      onlyReads(res.calls)
    }
    // Another host: the warning names it as the board reads it.
    const other = await run([], {
      dotenv: { PORT: port, PUBLIC_ORIGIN: '" HTTPS://OLD.example-tailnet.ts.net/ "' },
    })
    expect(other.code).toBe(0)
    expect(other.stderr).toContain(
      `.env has PUBLIC_ORIGIN=https://old.example-tailnet.ts.net: set PUBLIC_ORIGIN=https://${NAME}, then pnpm start`,
    )
  })

  it('warns when .env does not name this machine, and still prints', async () => {
    const port = portOf(signingIn)
    const res = await run([], { dotenv: { PORT: port } })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain(`.env has no PUBLIC_ORIGIN: set PUBLIC_ORIGIN=https://${NAME}`)
    expect(res.stdout).toContain(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)
    const wrong = await run([], {
      dotenv: { PORT: port, PUBLIC_ORIGIN: 'https://old.example-tailnet.ts.net' },
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
    const port = portOf(signingIn)
    const serve = { Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }
    const res = await run([], {
      dotenv: { PORT: port, ...entrance() },
      state: tailnet({ 'serve status --json': serve }),
    })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('443 serves http://127.0.0.1:3000 now: the command below replaces it')
  })

  it('names what else the tailnet name serves, which the board does not need, and how to stop it', async () => {
    const port = portOf(signingIn)
    const serve = {
      Web: {
        [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } },
        [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47111' } } },
      },
    }
    const res = await run([], {
      dotenv: { PORT: port, ...entrance() },
      state: tailnet({ 'serve status --json': serve }),
    })
    expect(res.code).toBe(0)
    expect(res.stderr).toContain(
      '8443 serves http://127.0.0.1:47111 too: the board needs only 443 (tailscale serve --https=8443 off)',
    )
    // 443 already serves the board: nothing to replace there.
    expect(res.stderr).not.toContain('replaces it')
    onlyReads(res.calls)
  })
})

describe('pnpm tailnet refuses', slow, () => {
  it('while Funnel is on, at the top level or in a foreground session, and runs no serve', async () => {
    const port = portOf(signingIn)
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
    const port = portOf(signingIn)
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
      // An empty port is http's own, 80: never the board's.
      ['--target', 'http://127.0.0.1:'],
    ]) {
      const res = await run(args, { dotenv: { PORT: port, ...entrance() } })
      expect(res.code, `${args}`).toBe(1)
      expect(res.stderr).toMatch(/board|loopback|path/)
      expect(res.stdout, `${args}`).not.toContain('tailscale serve')
      expect(res.calls, `${args}`).toEqual([])
    }
    const empty = await run(['--target', 'http://127.0.0.1:'], { dotenv: { PORT: port, ...entrance() } })
    expect(empty.stderr).toContain(`http://127.0.0.1: is not the board's port`)
    expect(empty.stderr).toContain(`127.0.0.1:${port} (PORT in .env)`)
    // PORT unset: the board is on 47100, and nothing else is.
    const preview = await run(['--port', '47101'])
    expect(preview.code).toBe(1)
    expect(preview.stderr).toContain("--port 47101 is not the board's port")
    expect(preview.stderr).toContain('127.0.0.1:47100')
    expect(preview.calls).toEqual([])
  })

  it('a PUBLIC_ORIGIN the board refuses to start with, as the board reads it, and prints no command', async () => {
    const port = portOf(signingIn)
    for (const [origin, value] of [
      [`http://${NAME}`, `http://${NAME}`],
      [`https://${NAME}:8443`, `https://${NAME}:8443`],
      [`https://${NAME}:443`, `https://${NAME}:443`],
      [`https://${NAME}/board`, `https://${NAME}/board`],
      [`https://${NAME}/?x=1`, `https://${NAME}/?x=1`],
      ['https://*.example-tailnet.ts.net', 'https://*.example-tailnet.ts.net'],
      ['https://100.101.102.103', 'https://100.101.102.103'],
      ['https://[fd7a:115c:a1e0::1]', 'https://[fd7a:115c:a1e0::1]'],
      ['https://localhost', 'https://localhost'],
      [NAME, NAME],
      // A name defined nowhere is empty, as the board reads .env: no host is left.
      ['https://${TAILNET_TEST_UNDEFINED}', 'https://'],
      ['"https://${TAILNET_TEST_UNDEFINED}" # note', 'https://'],
    ]) {
      const res = await run([], { dotenv: { PORT: port, PUBLIC_ORIGIN: origin } })
      // The board refuses to start with it...
      expect(() => boardEntrance(res.dir), origin).toThrow(StartupError)
      expect(() => boardEntrance(res.dir), origin).toThrow(`got "${value}"`)
      // ...and so does the helper: no command, and what to change.
      expect(res.code, `${origin}: ${res.stdout}`).toBe(1)
      expect(res.stdout, origin).not.toContain('tailscale serve')
      expect(res.stderr, origin).toContain(`.env has PUBLIC_ORIGIN="${value}", which the board refuses`)
      expect(res.stderr, origin).toContain(`Set PUBLIC_ORIGIN=https://${NAME}`)
      onlyReads(res.calls)
    }
  })

  it('a board that answers /api/me without signing in: its sign-in is off', async () => {
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
    const port = portOf(signingIn)
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
