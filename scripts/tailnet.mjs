#!/usr/bin/env node
// What to run so the devices of your tailnet open the board over HTTPS (README: "Using it from other
// devices"). It only reads, from Tailscale and from the board: it never runs `tailscale serve` or
// `tailscale funnel` itself, which is your step, and has no flag that would.
//
//   pnpm tailnet                                    # the commands for this machine, from .env
//   pnpm tailnet --port 47100                       # the same, checking the port is the board's
//   pnpm tailnet --target http://127.0.0.1:47100    # likewise with the whole target
//
// It refuses while Tailscale Funnel is on (that is the internet, not your tailnet), a target that is
// not the board on loopback (PORT in .env, 47100 by default: never a preview or a pnpm dev copy), a
// PUBLIC_ORIGIN in .env the board refuses to start with, and a board that answers /api/me without
// signing in (its sign-in is off). TAILSCALE_BIN names the CLI to ask (default `tailscale`; a .mjs or
// .js file runs with node).
import { execFileSync } from 'node:child_process'
import http from 'node:http'

import { boardAddress, readDotenv } from './dotenv.mjs'

const USAGE = 'usage: pnpm tailnet [--port <the board port>] [--target http://127.0.0.1:<the board port>]'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Everything this asks Tailscale, and nothing else: no `serve` or `funnel` with a target, ever. */
const READS = new Set(['version', 'status --json', 'serve status --json', 'funnel status --json'])

function fail(message) {
  console.error(message)
  process.exit(1)
}

// A host name of two labels or more, the last one starting with a letter: no wildcard, no IP literal.
const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * PUBLIC_ORIGIN as the board takes it, by the rules of readPublicEntrance in src/server/config.ts (its
 * tests hold the two to the same answers): null when it is not set, its origin (in lower case, no trailing
 * slash) when the board serves it, and false when the board refuses to start with it: http, a port, a
 * path, a wildcard, an IP, or no host at all (`https://${UNSET}`).
 */
function boardOrigin(raw) {
  const value = raw?.trim() ?? ''
  if (!value) return null
  const url = parseUrl(value)
  const trusted =
    url?.protocol === 'https:' &&
    !url.port &&
    value.replace(/\/$/, '').toLowerCase() === url.origin &&
    HOST_NAME.test(url.hostname)
  return trusted ? url.origin : false
}

function readArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const value = () =>
      flag !== arg ? arg.slice(eq + 1) : (argv[++i] ?? fail(`${flag} needs a value\n${USAGE}`))
    if (flag === '--help' || flag === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (flag === '--port') args.port = value()
    else if (flag === '--target') args.target = value()
    else if (!arg.startsWith('-') && args.target === undefined) args.target = arg
    else fail(`unknown option ${arg}\n${USAGE}`)
  }
  return args
}

const parseUrl = (raw) => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}
const portOf = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80))

/** What `tailscale <args>` prints; throws when it fails. Only the reads above ever run. */
function tailscale(...args) {
  if (!READS.has(args.join(' '))) throw new Error(`tailscale ${args.join(' ')} is not a read: refused`)
  const bin = process.env.TAILSCALE_BIN || 'tailscale'
  const [file, argv] = /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]
  try {
    return execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  } catch (err) {
    if (err.code === 'ENOENT')
      fail(
        `Tailscale is not installed here (no ${bin} on PATH). Install it on this machine and on each device ` +
          'first (README: "Using it from other devices"); TAILSCALE_BIN names another CLI.',
      )
    throw new Error(
      `tailscale ${args.join(' ')} failed: ${(err.stderr || err.message || '').toString().trim()}`,
    )
  }
}

/** A JSON answer (an empty one is an empty serve config); throws when there is none. */
function tailscaleJson(...args) {
  const out = tailscale(...args).trim()
  if (!out) return {}
  try {
    return JSON.parse(out)
  } catch {
    throw new Error(`tailscale ${args.join(' ')} did not print JSON:\n${out.slice(0, 400)}`)
  }
}

/** The same, stopping here when it fails. */
function mustRead(read) {
  try {
    return read()
  } catch (err) {
    fail(err.message)
  }
}

/** Every host:port a serve config lets Funnel put on the internet, its foreground sessions included. */
function funnelled(config) {
  const on = []
  const scan = (part, where) => {
    for (const [hostPort, allowed] of Object.entries(part?.AllowFunnel ?? {}))
      if (allowed === true) on.push({ hostPort, where })
  }
  scan(config, null)
  for (const [session, part] of Object.entries(config?.Foreground ?? {})) scan(part, session)
  return on
}

/** What a serve config already sends https://<name>:<port>/ to, if anything. */
function servedAt(config, name, port) {
  const handler = config?.Web?.[`${name}:${port}`]?.Handlers?.['/']
  return handler?.Proxy ?? handler?.Path ?? handler?.Text ?? null
}

/** Whether the board answers /api/me without credentials: 200 (sign-in off), another status, or null. */
function meStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/me', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? null)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

const args = readArgs(process.argv.slice(2))
const dotenv = readDotenv()
const boardPort = boardAddress(dotenv).port
const onlyTheBoard = `only the board goes on the tailnet, on 127.0.0.1:${boardPort} (PORT in .env), never a preview or a pnpm dev copy`

// --- the target: the board on loopback, nothing else ---
if (args.port !== undefined && Number(args.port) !== boardPort)
  fail(`--port ${args.port} is not the board's port: ${onlyTheBoard}`)
if (args.target !== undefined) {
  const target = parseUrl(args.target)
  if (!target || target.protocol !== 'http:' || !LOOPBACK.has(target.hostname))
    fail(`${args.target} is not on loopback: the target is http://127.0.0.1:<port>, ${onlyTheBoard}`)
  if (portOf(target) !== boardPort) fail(`${args.target} is not the board's port: ${onlyTheBoard}`)
  if (target.pathname !== '/' || target.search || target.hash || target.username || target.password)
    fail(`${args.target}: the target is the board's origin, with no path`)
}
// --- Tailscale on this machine: its name, and no Funnel anywhere ---
const version = mustRead(() => tailscale('version'))
  .split(/\r?\n/)[0]
  .trim()
const status = mustRead(() => tailscaleJson('status', '--json'))
if (status.BackendState && status.BackendState !== 'Running')
  fail(`Tailscale is ${status.BackendState} on this machine: run \`tailscale up\` and sign in first`)
const name = (status.Self?.DNSName ?? '').replace(/\.$/, '')
if (!name)
  fail(
    'This machine has no tailnet name: turn on MagicDNS and HTTPS certificates in the Tailscale admin console',
  )
const serve = mustRead(() => tailscaleJson('serve', 'status', '--json'))
let funnel = {}
try {
  funnel = tailscaleJson('funnel', 'status', '--json')
} catch {
  // A CLI without it: the serve config above holds AllowFunnel as well.
}
const open = [...funnelled(serve), ...funnelled(funnel)]
if (open.length) {
  const ports = [...new Set(open.map(({ hostPort }) => hostPort.split(':').pop()))]
  fail(
    `Tailscale Funnel is on (${open.map(({ hostPort, where }) => (where ? `${hostPort}, foreground ${where}` : hostPort)).join('; ')}): ` +
      'Funnel puts what it serves on the public internet, and the board is for your tailnet only. Nothing was run.\n' +
      `Turn it off first: ${ports.map((p) => `tailscale funnel --https=${p} off`).join(', ')} (or \`tailscale serve reset\`, ` +
      'which clears every serve and funnel handler; stop a `tailscale funnel` running in a terminal with Ctrl+C), then run this again.',
  )
}

// --- the board itself: only with its sign-in on ---
const me = await meStatus(boardPort)
if (me === 200)
  fail(
    `The board on 127.0.0.1:${boardPort} answers /api/me without signing in: its sign-in is off (AUTH=off or ` +
      'test mode). Only the board with its sign-in goes on the tailnet (pnpm start).',
  )

const url = `https://${name}`
// A PUBLIC_ORIGIN the board refuses to start with: no command for a board that will not run.
const have = boardOrigin(dotenv.PUBLIC_ORIGIN)
if (have === false)
  fail(
    `.env has PUBLIC_ORIGIN="${dotenv.PUBLIC_ORIGIN.trim()}", which the board refuses to start with: it must be ` +
      'https://<machine>.<tailnet>.ts.net (https, a host name, no IP, no wildcard, no port and no path). ' +
      `Set PUBLIC_ORIGIN=${url}, then pnpm start and run this again. Nothing was run.`,
  )
const warnings = []
if (me === null) warnings.push(`nothing answers on 127.0.0.1:${boardPort} yet: start the board (pnpm start)`)
if (!status.CertDomains?.includes(name))
  warnings.push(`no HTTPS certificate for ${name}: turn on HTTPS certificates in the Tailscale admin console`)
if (have !== url)
  warnings.push(
    `.env has ${have ? `PUBLIC_ORIGIN=${have}` : 'no PUBLIC_ORIGIN'}: set PUBLIC_ORIGIN=${url}, then pnpm start`,
  )
const now = servedAt(serve, name, 443)
if (now && now.replace(/\/$/, '') !== `http://127.0.0.1:${boardPort}`)
  warnings.push(`443 serves ${now} now: the command below replaces it`)
// What else this machine serves on its tailnet name, which the board does not need (an older setup put
// a sign-in service of its own on 8443).
for (const hostPort of Object.keys(serve?.Web ?? {})) {
  const [host, port] = [hostPort.slice(0, hostPort.lastIndexOf(':')), hostPort.split(':').pop()]
  if (host === name && port !== '443')
    warnings.push(
      `${port} serves ${servedAt(serve, name, port) ?? 'something'} too: the board needs only 443 (tailscale serve --https=${port} off)`,
    )
}

console.log(`${version ? `Tailscale ${version}; ` : ''}this machine is ${name} on your tailnet.

Run this on this machine to open the board to your tailnet (never Funnel):

  tailscale serve --bg --https=443 http://127.0.0.1:${boardPort}

Then open ${url}/ on your other devices, and add each one with a link from the board (Settings, Devices).

To stop:

  tailscale serve --https=443 off`)
if (warnings.length) console.warn(`\nBefore that:\n${warnings.map((w) => `  - ${w}`).join('\n')}`)
