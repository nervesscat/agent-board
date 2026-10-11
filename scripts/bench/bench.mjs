#!/usr/bin/env node
// The board's benchmark (README: "Benchmark"). Builds a checkout into a folder of its own, runs the
// build in test mode on copies of the data, and measures the server, MCP, the client and memory.
//
//   pnpm bench                          # everything, both datasets, this checkout
//   pnpm bench --quick                  # a short pass to see that it works
//   pnpm bench --target ../agent-board-main --label main
//   pnpm bench compare before.json after.json
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { isMainCheckout, mainCheckout } from '../checkout.mjs'
import * as client from './client.mjs'
import { assertBenchDataDir, copyLive, generate, pickTargets, tableCounts } from './data.mjs'
import {
  Metrics,
  compareResults,
  markdownComparison,
  markdownSummary,
  median,
  percentile,
  slope,
} from './report.mjs'
import { build, freePort, killAll, startServer } from './server.mjs'

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECTIONS = ['server', 'mcp', 'bundle', 'load', 'nav', 'idle', 'memory']
const DATASETS = ['live-copy', 'generated']

const HELP = `pnpm bench [options]            measure a checkout (this one by default)
pnpm bench compare <before.json> <after.json> [--out <file.md>]

Builds the target checkout into .bench/build/, starts the build in test mode (no passkey gate,
127.0.0.1, a free port from 47200, never 47100) on a copy of the data, and measures:
  server   p50/p95 latency of the hot endpoints, SQL statements and child processes per request
  mcp      size (chars, bytes) and latency of the main MCP tool results, as an agent
  bundle   JS and CSS each route downloads on a cold load, raw and gzip, and the whole client build
  load     cold first load of the main pages (TTFB, DOMContentLoaded, load, hydrated, data shown)
  nav      client-side navigations: board -> ticket, ticket -> board, Home -> board
  idle     requests per minute of pages left open, per API path
  memory   the server's RSS and heap under a steady request load, sampled over time
Datasets: live-copy (a backup of the main checkout's data/board.db and uploads) and generated (a
large dataset written from a seed). Results: .bench/results/<time>-<sha>[-label].json and .md.

Options:
  --target <dir>          checkout to measure (default: this one); never the main checkout
  --server <build|dev>    run the target's production build (default), or vite dev as the live
                          board runs (no bundle section; SQL and process counts not available)
  --sections <list>       ${SECTIONS.join(',')} (client = bundle,load,nav,idle); default all
  --datasets <list>       ${DATASETS.join(',')}; default both
  --runs <n>              independent runs, each on a fresh server (default 3)
  --requests <n>          measured requests per endpoint per run (default 20)
  --warmup <n>            requests per endpoint before measuring (default 3)
  --mcp-calls <n>         calls per MCP tool per run (default 3)
  --loads <n>             cold loads per page and navigations per run (default 3)
  --idle <s>              idle window per run (default 60)
  --memory <s>            memory run length, once per dataset (default 180)
  --memory-rate <n>       requests per second during the memory run (default 20)
  --memory-every <s>      seconds between memory samples (default 5)
  --scale <x>             size of the generated dataset (default 1: 20 projects, ~2,700 tickets)
  --seed <n>              seed of the generated dataset (default 1)
  --live-data <dir>       data folder to copy for live-copy (default: the main checkout's data/)
  --label <name>          added to the results' names
  --out <dir>             results folder (default .bench/results)
  --no-build              reuse the last build of the target
  --keep-data             keep the datasets in .bench/work afterwards
  --quick                 1 run, 5 requests, 1 load, 15 s idle, 20 s memory, scale 0.2
  --allow-main-checkout   for a plain clone that runs no board (CI); refused where data/board.db exists
  -h, --help              this text`

// --- clean-up on every way out ---

let browser = null
/** Puts the target's files back and drops the copies of the data (set once they are known). */
let restoreTarget = () => {}
let dropData = () => {}
async function shutdown(code) {
  try {
    await browser?.close()
  } catch {}
  killAll()
  restoreTarget()
  dropData()
  process.exit(code)
}
process.on('SIGINT', () => {
  console.error('\nInterrupted: stopping the bench server and browser.')
  void shutdown(130)
})
process.on('SIGTERM', () => void shutdown(143))
process.on('exit', killAll)

const log = (...args) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...args)

// --- compare mode ---

if (process.argv[2] === 'compare') {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 2) {
    console.log(HELP)
    process.exit(values.help ? 0 : 1)
  }
  const [before, after] = positionals.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  const md = markdownComparison(before, after, compareResults(before, after))
  console.log(md)
  if (values.out) fs.writeFileSync(values.out, md)
  process.exit(0)
}

// --- options ---

const { values: opt } = parseArgs({
  options: {
    target: { type: 'string' },
    server: { type: 'string' },
    sections: { type: 'string' },
    datasets: { type: 'string' },
    runs: { type: 'string' },
    requests: { type: 'string' },
    warmup: { type: 'string' },
    'mcp-calls': { type: 'string' },
    loads: { type: 'string' },
    idle: { type: 'string' },
    memory: { type: 'string' },
    'memory-rate': { type: 'string' },
    'memory-every': { type: 'string' },
    scale: { type: 'string' },
    seed: { type: 'string' },
    'live-data': { type: 'string' },
    label: { type: 'string' },
    out: { type: 'string' },
    'no-build': { type: 'boolean' },
    'keep-data': { type: 'boolean' },
    quick: { type: 'boolean' },
    'allow-main-checkout': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (opt.help) {
  console.log(HELP)
  process.exit(0)
}

function fail(message) {
  console.error(`bench: ${message}`)
  process.exit(1)
}

const num = (name, fallback, quick) => {
  const raw = opt[name]
  if (raw === undefined) return opt.quick ? quick : fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a number, got ${raw}`)
  return n
}
const list = (raw, all, aliases = {}) => {
  if (!raw) return all
  const items = raw.split(',').flatMap((s) => aliases[s.trim()] ?? [s.trim()])
  const unknown = items.filter((s) => !all.includes(s))
  if (unknown.length) fail(`unknown ${unknown.join(', ')}; choose from ${all.join(', ')}`)
  return all.filter((s) => items.includes(s))
}

if (opt.server && !['build', 'dev'].includes(opt.server))
  fail(`--server must be build or dev, got ${opt.server}`)
const settings = {
  server: opt.server ?? 'build',
  sections: list(opt.sections, SECTIONS, { client: ['bundle', 'load', 'nav', 'idle'] }),
  datasets: list(opt.datasets, DATASETS),
  runs: Math.max(1, Math.round(num('runs', 3, 1))),
  requests: Math.max(1, Math.round(num('requests', 20, 5))),
  warmup: Math.round(num('warmup', 3, 1)),
  mcpCalls: Math.max(1, Math.round(num('mcp-calls', 3, 1))),
  loads: Math.max(1, Math.round(num('loads', 3, 1))),
  idleSeconds: num('idle', 60, 15),
  memorySeconds: num('memory', 180, 20),
  memoryRate: num('memory-rate', 20, 20),
  memoryEvery: num('memory-every', 5, 2),
  scale: num('scale', 1, 0.2),
  seed: Math.round(num('seed', 1, 1)),
}
const has = (s) => settings.sections.includes(s)

// --- where it runs, and what it refuses ---

const target = path.resolve(opt.target ?? HARNESS_ROOT)
if (!fs.existsSync(path.join(target, 'package.json')) || !fs.existsSync(path.join(target, 'drizzle')))
  fail(`${target} is not a checkout of the board (no package.json and drizzle/)`)
for (const [what, dir] of [
  ['target', target],
  ['harness', HARNESS_ROOT],
]) {
  if (!isMainCheckout(dir)) continue
  const live = fs.existsSync(path.join(dir, 'data', 'board.db'))
  if (!opt['allow-main-checkout'] || live)
    fail(
      `the ${what} ${dir} is the main checkout, where the live board runs: the bench never builds, writes ` +
        `or starts a server there. Run it from a worktree (git worktree add ../agent-board-<branch> <branch>)` +
        (live ? '.' : ', or pass --allow-main-checkout in a clone that runs no board.'),
    )
}

const benchDir = path.join(HARNESS_ROOT, '.bench')
const resultsDir = path.resolve(opt.out ?? path.join(benchDir, 'results'))
const workDir = path.join(benchDir, 'work')
const buildDir = path.join(benchDir, 'build', path.basename(target))
const liveDir = path.resolve(opt['live-data'] ?? path.join(mainCheckout(target), 'data'))
const forbidden = [
  ...new Set([
    liveDir,
    path.join(mainCheckout(target), 'data'),
    path.join(mainCheckout(HARNESS_ROOT), 'data'),
    path.join(target, 'data'),
    path.join(HARNESS_ROOT, 'data'),
  ]),
]

// --- machine and target ---

const sh = (cmd, args, cwd) => {
  try {
    // Through the shell on Windows, where pnpm is a .cmd; the commands here are fixed strings.
    const win = process.platform === 'win32'
    return execFileSync(win ? [cmd, ...args].join(' ') : cmd, win ? [] : args, {
      cwd,
      encoding: 'utf8',
      shell: win,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd()
  } catch {
    return null
  }
}
const machine = {
  cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
  cores: os.cpus().length,
  memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  freeMemoryGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
  os: os.version(),
  osRelease: os.release(),
  arch: os.arch(),
  node: process.version,
  pnpm: sh('pnpm', ['--version'], target),
}
const status = sh('git', ['status', '--porcelain'], target)
const targetInfo = {
  path: target,
  sha: sh('git', ['rev-parse', 'HEAD'], target) ?? 'unknown',
  branch: (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], target) ?? 'unknown').replace(
    /^HEAD$/,
    'detached',
  ),
  dirty: status ? status.split('\n').length : 0,
  buildDir,
  buildMs: null,
}

const startedAt = new Date()
const results = {
  harness: 1,
  label: opt.label ?? null,
  startedAt: startedAt.toISOString(),
  endedAt: null,
  wallMs: null,
  machine,
  target: targetInfo,
  settings,
  server: {
    mode:
      settings.server === 'dev'
        ? 'vite dev, BOARD_ENV=test (no passkey gate)'
        : 'production build, BOARD_ENV=test (no passkey gate)',
    host: '127.0.0.1',
    ports: [],
  },
  instrumentation: { available: null, reason: null },
  datasets: {},
}

fs.mkdirSync(resultsDir, { recursive: true })
fs.mkdirSync(workDir, { recursive: true })
const logsDir = path.join(benchDir, 'logs')
fs.mkdirSync(logsDir, { recursive: true })

// --- the endpoints, tools and pages each dataset is measured on ---

function endpoints(p) {
  const P = p.projectId
  const T = p.ticketId
  const agent = `agent:${p.agent}`
  return [
    ['me', '/api/me'],
    ['projects', '/api/projects'],
    ['actors', '/api/actors'],
    ['project', `/api/projects/${P}`],
    ['ticket', `/api/tickets/${T}`],
    ['ticket lanes', `/api/tickets/${T}?lanes=1`],
    ['ticket git', `/api/tickets/${T}/git`],
    ['post thread', p.postId && `/api/comments?parentType=update&parentId=${p.postId}`],
    ['board', `/api/projects/${P}/tickets?parent=root`],
    ['board archived', `/api/projects/${P}/tickets?parent=root&archived=only`],
    ['board cleanup', `/api/projects/${P}/cleanup?reach=0`],
    ['push', `/api/projects/${P}/push`],
    ['summary', '/api/summary'],
    ['summary project', `/api/summary?projectId=${P}`],
    ['prs', `/api/projects/${P}/prs`],
    ['inbox', `/api/projects/${P}/inbox`, agent],
    ['threads', `/api/projects/${P}/threads`, agent],
    ['tickets all', `/api/projects/${P}/tickets`],
    ['project agents', `/api/projects/${P}/agents`],
    ['agent-setup', '/api/agent-setup'],
    ['upload', p.attachmentId && `/api/uploads/${p.attachmentId}`],
  ].filter(([, url]) => url)
}

function tools(p) {
  const P = p.projectId
  const T = p.ticketId
  return [
    ['list_projects', {}],
    ['get_project', { projectId: P }],
    ['get_summary', {}],
    ['get_summary project', { projectId: P }, 'get_summary'],
    ['list_tickets', { projectId: P }],
    ['get_ticket', { ticketId: T }],
    ['get_ticket lanes', { ticketId: T, laneUpdates: true }, 'get_ticket'],
    ['list_comments ticket', { parentType: 'ticket', parentId: T }, 'list_comments'],
    ...(p.postId
      ? [['list_comments post', { parentType: 'update', parentId: p.postId }, 'list_comments']]
      : []),
    ['check_inbox', { projectId: P }],
    ['list_my_threads', { projectId: P }],
    ['list_prs', { projectId: P }],
    ['get_ticket_git', { ticketId: T }],
    ['cleanup_report', { projectId: P }],
    ['daily_report', {}],
    ['list_review_results', { projectId: P }],
    ['list_reports', { projectId: P }],
  ]
}

function pages(p) {
  const P = p.projectId
  const T = p.boardTicketId
  const ticket = `/projects/${P}/features/${p.ticketId}`
  const h1 = (text = '') => ({ selector: 'h1', text })
  return {
    ticket: { name: 'ticket', url: ticket, ready: h1(p.ticketTitle.slice(0, 40)) },
    board: {
      name: 'board',
      url: `/projects/${P}/features`,
      ready: { selector: `[data-column] a[href="/projects/${P}/features/${T}"]`, text: '' },
    },
    home: { name: 'home', url: '/', ready: { selector: `a[href="/projects/${P}/features"]`, text: '' } },
    overview: {
      name: 'overview',
      url: `/projects/${P}`,
      ready: { selector: 'span', text: 'in the backlog' },
    },
    // The filter tabs count the PRs; they render on the server too, with no PRs yet.
    prs: {
      name: 'prs',
      url: `/projects/${P}/prs`,
      ready: { selector: '[role="tablist"]', text: '', re: 'All[1-9]' },
    },
    agents: { name: 'agents', url: `/projects/${P}/agents`, ready: h1('Agents') },
    // The other routes, for their bundles.
    agentsSetup: { name: 'agents setup', url: '/agents', ready: h1('Connect agents') },
    daily: { name: 'daily', url: '/daily', ready: h1() },
    repositories: { name: 'repositories', url: '/repositories', ready: h1() },
    settings: { name: 'settings', url: '/settings', ready: h1() },
    reviews: { name: 'reviews', url: `/projects/${P}/reviews`, ready: h1() },
    projectDaily: { name: 'project daily', url: `/projects/${P}/daily`, ready: h1() },
    cleanup: { name: 'cleanup', url: `/projects/${P}/cleanup`, ready: h1('Cleanup') },
    projectSettings: { name: 'project settings', url: `/projects/${P}/settings`, ready: h1() },
    // Board ticket: a top-level ticket shown on the board, for navigations from it.
    boardTicket: {
      name: 'board ticket',
      url: `/projects/${P}/features/${T}`,
      ready: h1(p.boardTicketTitle.slice(0, 40)),
    },
  }
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

// --- sections ---

const countsOf = (spawns) => {
  const out = {}
  for (const c of spawns ?? []) out[c] = (out[c] ?? 0) + 1
  return out
}

async function serverSection(server, p, m, details) {
  const out = (details.server ??= { endpoints: {} })
  for (const [name, url, actor] of endpoints(p)) {
    const e = (out.endpoints[name] ??= { path: url, actor: actor ?? null, statuses: {}, commands: {} })
    const cold = await server.request(url, { actor })
    for (let i = 0; i < settings.warmup; i++) await server.request(url, { actor })
    const samples = []
    for (let i = 0; i < settings.requests; i++) samples.push(await server.request(url, { actor }))
    for (const s of [cold, ...samples]) e.statuses[s.status] = (e.statuses[s.status] ?? 0) + 1
    for (const [c, n] of Object.entries(countsOf(samples.flatMap((s) => s.spawns ?? []))))
      e.commands[c] = (e.commands[c] ?? 0) + n
    if (name === 'upload' && p.attachmentSize !== null)
      e.bytesMatch = samples.every((s) => s.bytes === p.attachmentSize)
    const key = `server.endpoint.${name}`
    const na = server.instrumentation?.reason?.join('; ') || 'the preload could not count'
    m.add(
      `${key}.p50_ms`,
      percentile(
        samples.map((s) => s.ms),
        50,
      ),
      'ms',
    )
    m.add(
      `${key}.p95_ms`,
      percentile(
        samples.map((s) => s.ms),
        95,
      ),
      'ms',
    )
    m.add(`${key}.cold_ms`, cold.ms, 'ms')
    m.add(
      `${key}.db_queries`,
      samples.every((s) => s.db !== null) ? median(samples.map((s) => s.db)) : null,
      'count',
      na,
    )
    m.add(
      `${key}.child_processes`,
      samples.every((s) => s.spawns !== null) ? median(samples.map((s) => s.spawns.length)) : null,
      'count',
      na,
    )
    m.add(`${key}.bytes`, median(samples.map((s) => s.bytes)), 'bytes')
  }
}

async function mcpSection(server, p, m, details) {
  const out = (details.mcp ??= { errors: {} })
  const actor = `agent:${p.agent}`
  for (const [name, args, tool = name] of tools(p)) {
    const samples = []
    for (let i = 0; i < settings.mcpCalls; i++) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      })
      samples.push(await server.request('/api/mcp', { actor, method: 'POST', body, headers: MCP_HEADERS }))
    }
    const last = samples.at(-1)
    let chars = null
    let error = null
    try {
      const json = JSON.parse(last.text)
      if (json.error) error = json.error.message
      else {
        const text = (json.result?.content ?? []).map((c) => c.text ?? '').join('')
        chars = text.length
        if (json.result?.isError) error = text
      }
    } catch {
      error = `HTTP ${last.status}: ${last.text.slice(0, 200)}`
    }
    if (error) out.errors[name] = error
    const key = `mcp.${name}`
    m.add(`${key}.chars`, chars, 'chars', error ?? undefined)
    m.add(`${key}.bytes`, last.bytes, 'bytes')
    m.add(`${key}.ms`, median(samples.map((s) => s.ms)), 'ms')
    m.add(
      `${key}.db_queries`,
      samples.every((s) => s.db !== null) ? median(samples.map((s) => s.db)) : null,
      'count',
      server.instrumentation?.reason?.join('; ') || 'unavailable',
    )
    m.add(
      `${key}.child_processes`,
      samples.every((s) => s.spawns !== null) ? median(samples.map((s) => s.spawns.length)) : null,
      'count',
      server.instrumentation?.reason?.join('; ') || 'unavailable',
    )
  }
}

async function memorySection(server, p, details) {
  const mix = []
  const weighted = {
    ticket: 6,
    'post thread': 6,
    board: 6,
    'board archived': 2,
    summary: 2,
    'summary project': 2,
    'ticket git': 2,
    prs: 1,
    'board cleanup': 1,
    push: 1,
    inbox: 2,
    threads: 1,
    me: 1,
  }
  for (const [name, url, actor] of endpoints(p))
    for (let i = 0; i < (weighted[name] ?? 0); i++) mix.push([url, actor])
  const samples = []
  const sample = async (t0) => {
    const s = await server.memory()
    if (s)
      samples.push({
        t: Math.round((Date.now() - t0) / 100) / 10,
        rss: s.rss,
        heapUsed: s.heapUsed,
        heapTotal: s.heapTotal,
        external: s.external,
      })
  }
  const t0 = Date.now()
  const end = t0 + settings.memorySeconds * 1000
  let nextSample = t0
  let requests = 0
  let errors = 0
  let i = 0
  while (Date.now() < end) {
    if (Date.now() >= nextSample) {
      await sample(t0)
      nextSample += settings.memoryEvery * 1000
    }
    const due = t0 + (requests * 1000) / settings.memoryRate
    if (Date.now() < due) await new Promise((r) => setTimeout(r, Math.min(due, end) - Date.now()))
    if (Date.now() >= end) break
    const [url, actor] = mix[i++ % mix.length]
    const r = await server.request(url, { actor })
    requests++
    if (r.status !== 200) errors++
  }
  await sample(t0)
  const stats = (k) => {
    const v = samples.map((s) => s[k])
    const per = slope(samples.map((s) => [s.t / 60, s[k]]))
    return {
      start: v[0] ?? null,
      end: v.at(-1) ?? null,
      peak: v.length ? Math.max(...v) : null,
      slopePerMin: per === null ? null : Math.round(per),
    }
  }
  details.memory = {
    seconds: settings.memorySeconds,
    ranSeconds: Math.round((Date.now() - t0) / 100) / 10,
    rate: settings.memoryRate,
    requests,
    errors,
    rss: stats('rss'),
    heapUsed: stats('heapUsed'),
    series: samples,
  }
}

// --- one dataset ---

async function prepare(name) {
  const dir = path.join(workDir, name)
  assertBenchDataDir(dir, forbidden)
  if (name === 'live-copy') {
    log(`Copying the live data from ${liveDir}`)
    const copied = await copyLive(liveDir, dir)
    if (!copied) return { skipped: `no live data at ${path.join(liveDir, 'board.db')}` }
    return { dir, source: copied }
  }
  log(`Generating the large dataset (scale ${settings.scale}, seed ${settings.seed})`)
  const t = Date.now()
  const gen = generate(dir, {
    scale: settings.scale,
    seed: settings.seed,
    migrationsFolder: path.join(target, 'drizzle'),
  })
  return {
    dir,
    source: { generator: { plan: gen.plan, scale: gen.scale, seed: gen.seed, ms: Date.now() - t } },
  }
}

async function measureDataset(name) {
  const prepared = await prepare(name)
  if (prepared.skipped) {
    log(`Skipping ${name}: ${prepared.skipped}`)
    return { skipped: prepared.skipped }
  }
  const { dir } = prepared
  const picks = pickTargets(path.join(dir, 'board.db'))
  const ds = {
    dataDir: dir,
    source: prepared.source,
    counts: tableCounts(path.join(dir, 'board.db')),
    picks,
    metrics: null,
    details: {},
    runs: [],
  }
  const m = new Metrics()
  const pg = pages(picks)
  const background = { db: 0, spawns: 0 }
  const serverLog = path.join(logsDir, `${name}-server.log`)
  fs.writeFileSync(serverLog, '')

  const start = async () => {
    const port = await freePort()
    if (!results.server.ports.includes(port)) results.server.ports.push(port)
    const server = await startServer({
      mode: settings.server,
      target,
      buildDir,
      dataDir: dir,
      port,
      human: picks.human,
      log: serverLog,
    })
    const inst = server.instrumentation
    results.instrumentation = {
      available: Boolean(inst?.db && inst?.spawn),
      reason: inst ? inst.reason.join('; ') || null : 'the preload did not report (no IPC channel)',
    }
    return server
  }

  for (let run = 1; run <= settings.runs; run++) {
    const server = await start()
    log(
      `${name} run ${run}/${settings.runs}: server on ${server.baseURL} (pid ${server.pid}), up in ${server.startupMs} ms`,
    )
    ds.runs.push({ run, port: server.port, pid: server.pid, startupMs: server.startupMs })
    m.add('server.startup_ms', server.startupMs, 'ms')
    try {
      if (has('server')) {
        log(`  server: ${endpoints(picks).length} endpoints`)
        await serverSection(server, picks, m, ds.details)
      }
      if (has('mcp')) {
        log(`  mcp: ${tools(picks).length} tools`)
        await mcpSection(server, picks, m, ds.details)
      }
      if (['bundle', 'load', 'nav', 'idle'].some(has)) browser ??= await client.launch()
      if (has('bundle') && run === 1 && settings.server === 'dev')
        ds.details.bundle = { skipped: 'measured on the production build only (--server build)' }
      else if (has('bundle') && run === 1) {
        log('  bundle: every route')
        const routes = [
          pg.home,
          pg.agentsSetup,
          pg.daily,
          pg.repositories,
          pg.settings,
          pg.overview,
          pg.board,
          pg.ticket,
          pg.prs,
          pg.reviews,
          pg.agents,
          pg.projectDaily,
          pg.cleanup,
          pg.projectSettings,
        ]
        const b = await client.bundle(browser, server.baseURL, routes, buildDir)
        ds.details.bundle = b
        for (const [route, r] of Object.entries(b.routes)) {
          m.add(`bundle.route.${route}.js_raw`, r.js.raw, 'bytes')
          m.add(`bundle.route.${route}.js_gzip`, r.js.gzip, 'bytes')
          m.add(`bundle.route.${route}.css_raw`, r.css.raw, 'bytes')
          m.add(`bundle.route.${route}.css_gzip`, r.css.gzip, 'bytes')
          m.add(`bundle.route.${route}.files`, r.js.files + r.css.files, 'count')
        }
        for (const k of ['js', 'css']) {
          m.add(`bundle.total.${k}_raw`, b.total[k].raw, 'bytes')
          m.add(`bundle.total.${k}_gzip`, b.total[k].gzip, 'bytes')
        }
        m.add('bundle.total.all_raw', b.total.all.raw, 'bytes')
      }
      if (has('load')) {
        log('  load: first loads')
        const loads = await client.firstLoads(
          browser,
          server.baseURL,
          [pg.ticket, pg.board, pg.home, pg.overview, pg.prs, pg.agents],
          settings.loads,
        )
        ;(ds.details.load ??= []).push(loads)
        for (const [page, l] of Object.entries(loads)) {
          const na = l.shown ? undefined : 'the page never showed its data'
          m.add(`load.${page}.ttfb_ms`, l.ttfb, 'ms')
          m.add(`load.${page}.dcl_ms`, l.dcl, 'ms')
          m.add(`load.${page}.load_ms`, l.load, 'ms')
          m.add(`load.${page}.hydrated_ms`, l.hydrated, 'ms')
          m.add(`load.${page}.content_ms`, l.content, 'ms', na)
          m.add(`load.${page}.requests`, l.requests, 'count')
          m.add(`load.${page}.api_requests`, l.apiRequests, 'count')
          m.add(`load.${page}.bytes`, l.bytes, 'bytes')
        }
      }
      if (has('nav')) {
        log('  nav: navigations')
        const P = picks.projectId
        const T = picks.boardTicketId
        const onBoard = { selector: `[data-column] a[href="/projects/${P}/features/${T}"]`, text: '' }
        const navs = [
          {
            name: 'board -> ticket',
            from: pg.board,
            link: `[data-column] a[href="/projects/${P}/features/${T}"]`,
            to: pg.boardTicket.ready,
          },
          {
            name: 'ticket -> board',
            from: pg.boardTicket,
            link: `main a[href="/projects/${P}/features"]`,
            to: onBoard,
          },
          {
            name: 'home -> board',
            from: pg.home,
            link: `main a[href="/projects/${P}/features"]`,
            to: onBoard,
          },
        ]
        const nav = await client.navigations(browser, server.baseURL, navs, settings.loads)
        ;(ds.details.nav ??= []).push(nav)
        for (const [n, v] of Object.entries(nav)) {
          m.add(`nav.${n}.ms`, v.ms, 'ms', v.reason ?? 'the destination never showed')
          m.add(`nav.${n}.api_requests`, v.apiRequests, 'count', v.reason)
        }
      }
      if (has('idle')) {
        log(`  idle: ${settings.idleSeconds} s`)
        const idle = await client.idle(
          browser,
          server.baseURL,
          [pg.ticket, pg.board, pg.home, pg.overview, pg.prs, pg.agents],
          settings.idleSeconds,
        )
        const d = (ds.details.idle ??= { pages: {}, runs: [] })
        d.runs.push(idle)
        d.pages = idle
        for (const [page, v] of Object.entries(idle)) m.add(`idle.${page}.per_min`, v.perMin, 'count')
      }
      const bg = server.instrumentation?.db ? await server.background() : null
      if (bg) {
        background.db += bg.db
        background.spawns += bg.spawns.length
      }
    } finally {
      await server.stop()
    }
  }
  if (ds.details.server) ds.details.server.background = results.instrumentation.available ? background : null

  if (has('memory')) {
    const server = await start()
    log(`${name} memory: ${settings.memorySeconds} s at ${settings.memoryRate} req/s on ${server.baseURL}`)
    try {
      await memorySection(server, picks, ds.details)
      if (settings.server === 'dev')
        ds.details.memory.note =
          'RSS is the whole vite dev process; heap used is its main thread only (not the Nitro worker)'
    } finally {
      await server.stop()
    }
  }
  ds.metrics = m.toJSON()
  return ds
}

/**
 * The build and vite dev regenerate src/routeTree.gen.ts, and with core.autocrlf only its line endings
 * change: put back what the run alone touched without changing its content, so the checkout stays as
 * it was.
 */
function restoreEolOnly(before) {
  const was = new Set((before ?? '').split('\n').filter(Boolean))
  const now = (sh('git', ['status', '--porcelain'], target) ?? '').split('\n').filter(Boolean)
  for (const line of now) {
    if (was.has(line) || !line.startsWith(' M ')) continue
    const file = line.slice(3)
    try {
      execFileSync('git', ['diff', '--quiet', '--', file], { cwd: target, stdio: 'ignore' })
      execFileSync('git', ['checkout', '--', file], { cwd: target, stdio: 'ignore' })
    } catch {}
  }
}

// --- the run ---

restoreTarget = () => restoreEolOnly(status)
dropData = () => {
  if (opt['keep-data']) return
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5 })
  } catch (err) {
    console.error(`bench: could not remove ${workDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
try {
  log(
    `Target ${target} @ ${targetInfo.sha.slice(0, 12)} (${targetInfo.branch}${targetInfo.dirty ? ', dirty' : ''})`,
  )
  if (settings.server === 'dev') {
    targetInfo.buildDir = null
    log('Running the target with vite dev: no build')
  } else if (opt['no-build'] && fs.existsSync(path.join(buildDir, 'server', 'index.mjs')))
    log(`Reusing the build in ${buildDir}`)
  else {
    log(`Building into ${buildDir}`)
    targetInfo.buildMs = await build(target, buildDir, path.join(logsDir, 'build.log'))
  }
  for (const name of settings.datasets) results.datasets[name] = await measureDataset(name)
} catch (err) {
  console.error(`bench: ${err instanceof Error ? err.message : String(err)}`)
  await shutdown(1)
} finally {
  await browser?.close().catch(() => {})
  browser = null
  killAll()
  restoreTarget()
}

const ended = new Date()
results.endedAt = ended.toISOString()
results.wallMs = ended.getTime() - startedAt.getTime()
const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const base = path.join(
  resultsDir,
  `${stamp}-${targetInfo.sha.slice(0, 8)}${opt.label ? `-${opt.label.replace(/[^\w.-]+/g, '_')}` : ''}`,
)
fs.writeFileSync(`${base}.json`, JSON.stringify(results, null, 2))
const md = markdownSummary(results)
fs.writeFileSync(`${base}.md`, md)
console.log('\n' + md)
log(`Results: ${base}.json and ${base}.md`)
dropData()
process.exit(0)
