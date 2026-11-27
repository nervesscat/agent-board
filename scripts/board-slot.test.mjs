import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  claim,
  createRecorder,
  formatHolder,
  isStale,
  parseHolder,
  pidAlive,
  readSlot,
  reclaimSlot,
  release,
} from './board-slot.mjs'

const SCRIPT = fileURLToPath(new URL('./board-slot.mjs', import.meta.url))
const INSTRUCTIONS = fileURLToPath(
  new URL('../src/server/skill/review/agents/todo-review-ticket.md', import.meta.url),
)
const MIN = 60_000

// The events route as a stand-in: it records each request and answers a wait_start with a waitId.
const seen = []
let nextWaitId = 40
const stub = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    seen.push({
      method: req.method,
      url: req.url,
      token: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ waitId: ++nextWaitId, event: {} }))
  })
})
let url
beforeAll(async () => {
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${stub.address().port}`
})
afterAll(() => {
  stub.close()
})

// Every locks folder a test makes lives in its own temp folder, removed after the test.
const made = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  seen.length = 0
})
function newLocks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-slot-test-'))
  made.push(root)
  const locks = path.join(root, 'locks')
  fs.mkdirSync(locks)
  return locks
}

/** A held slot as a test sets it up: the folder and its holder.txt, as a claim would have written them. */
function holdSlot(locks, name, { pid = process.pid, holder = '3 build', token = 'tok-' + name, at } = {}) {
  const dir = path.join(locks, name)
  fs.mkdirSync(dir)
  const started = new Date(at ?? Date.now()).toISOString()
  fs.writeFileSync(path.join(dir, 'holder.txt'), formatHolder({ holder, pid, token, started }))
  return dir
}

const deadPid = () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid

/** Runs the script with these arguments and environment; answers its exit code and output. */
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, BOARD_PROJECT: '', BOARD_TICKET: '', BOARD_URL: '', BOARD_TOKEN: '', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('claim', () => {
  it('claim takes the first free slot', async () => {
    const locks = newLocks()
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(got.ok).toBe(true)
    expect(got.slot).toBe('tests-1-1')
    expect(path.basename(got.dir)).toBe('tests-1-1')
  })

  it('with slot 1 held by a live holder, claim returns slot 2', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1')
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(got.slot).toBe('tests-1-2')
  })

  it('claim writes the holder with its pid and a token', async () => {
    const locks = newLocks()
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: 4242, pollMs: 1 })
    const parsed = parseHolder(fs.readFileSync(path.join(got.dir, 'holder.txt'), 'utf8'))
    expect(parsed.holder).toMatch(/^7 smoke \d{4}-\d\d-\d\dT/)
    expect(parsed.pid).toBe(4242)
    expect(parsed.token).toBe(got.token)
    expect(parsed.token).toMatch(/^[0-9a-f]{16}$/)
    expect(fs.readFileSync(path.join(got.dir, 'holder.txt'), 'utf8')).toMatch(/\nstarted \d{4}-/)
  })

  it('claim defaults the holder pid to its parent process', async () => {
    const locks = newLocks()
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pollMs: 1 })
    expect(parseHolder(fs.readFileSync(path.join(got.dir, 'holder.txt'), 'utf8')).pid).toBe(process.ppid)
  })

  it('claim waits in the queue until a slot frees, then takes it', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1')
    holdSlot(locks, 'tests-1-2')
    let sleeps = 0
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      pollMs: 10,
      sleep: async () => {
        sleeps++
        if (sleeps === 1) fs.rmSync(path.join(locks, 'tests-1-1'), { recursive: true })
      },
    })
    expect(sleeps).toBe(1)
    expect(got.slot).toBe('tests-1-1')
    expect(fs.readdirSync(path.join(locks, 'queue'))).toEqual([])
  })

  it('claim gives up after the timeout and names the holders', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1', { holder: '3 build' })
    holdSlot(locks, 'tests-1-2', { holder: '4 review' })
    let clock = Date.now()
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      timeoutMs: 3 * MIN,
      pollMs: MIN,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    expect(got.ok).toBe(false)
    const named = got.holders.join('\n')
    expect(named).toContain('tests-1-1')
    expect(named).toContain('#3 build')
    expect(named).toContain('#4 review')
    expect(fs.readdirSync(path.join(locks, 'queue'))).toEqual([])
  })

  it('claim records the wait on the ticket: wait_start, then wait_end with its waitId', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1')
    holdSlot(locks, 'tests-1-2')
    const recorder = createRecorder({ url, token: 'secret-token', project: 1, ticket: 7 })
    await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      pollMs: 1,
      recorder,
      sleep: async () => fs.rmSync(path.join(locks, 'tests-1-2'), { recursive: true }),
    })
    expect(seen.map((r) => [r.method, r.url, r.token])).toEqual([
      ['POST', '/api/projects/1/tickets/7/events', 'Bearer secret-token'],
      ['POST', '/api/projects/1/tickets/7/events', 'Bearer secret-token'],
    ])
    expect(seen[0].body).toEqual({ kind: 'wait_start', reason: 'lock', note: 'tests-1-1 to tests-1-2' })
    expect(seen[1].body).toEqual({ kind: 'wait_end', waitId: 41 })
  })

  it('without a ticket no request is made and the wait is not recorded', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1', { holder: '3 build' })
    holdSlot(locks, 'tests-1-2', { holder: '4 review' })
    const result = await cli(['claim', locks, '1', '7 smoke', '--timeout', '0.02'], {
      BOARD_URL: url,
      BOARD_TOKEN: 'secret-token',
      BOARD_SLOT_POLL_MS: '10',
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('not recorded')
    expect(result.stderr).toContain('#3 build')
    expect(seen).toHaveLength(0)
  })

  it('claim reclaims a slot whose holder pid is dead', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1', { pid: deadPid() })
    holdSlot(locks, 'tests-1-2')
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(got.slot).toBe('tests-1-1')
    expect(parseHolder(fs.readFileSync(path.join(got.dir, 'holder.txt'), 'utf8')).pid).toBe(process.pid)
  })

  it('claim never reclaims a live holder', async () => {
    const locks = newLocks()
    const one = holdSlot(locks, 'tests-1-1', { token: 'live-1' })
    const two = holdSlot(locks, 'tests-1-2', { token: 'live-2' })
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      timeoutMs: 0,
      pollMs: 1,
    })
    expect(got.ok).toBe(false)
    expect(parseHolder(fs.readFileSync(path.join(one, 'holder.txt'), 'utf8')).token).toBe('live-1')
    expect(parseHolder(fs.readFileSync(path.join(two, 'holder.txt'), 'utf8')).token).toBe('live-2')
  })

  it('claim never reclaims a holder with no pid line, however old', async () => {
    const locks = newLocks()
    const one = path.join(locks, 'tests-1-1')
    fs.mkdirSync(one)
    fs.writeFileSync(path.join(one, 'holder.txt'), '#9 build 2026-01-01T00:00:00.000Z\n')
    const old = (Date.now() - 3 * 60 * MIN) / 1000
    fs.utimesSync(one, old, old)
    holdSlot(locks, 'tests-1-2')
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      timeoutMs: 0,
      pollMs: 1,
    })
    expect(got.ok).toBe(false)
    expect(fs.readFileSync(path.join(one, 'holder.txt'), 'utf8')).toContain('#9 build')
  })

  it('claim treats a holder with a bad pid as live', async () => {
    const locks = newLocks()
    const one = path.join(locks, 'tests-1-1')
    fs.mkdirSync(one)
    fs.writeFileSync(path.join(one, 'holder.txt'), '#9 build 2026-01-01T00:00:00.000Z\npid nope\ntoken t\n')
    holdSlot(locks, 'tests-1-2')
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      timeoutMs: 0,
      pollMs: 1,
    })
    expect(got.ok).toBe(false)
    expect(fs.existsSync(one)).toBe(true)
  })

  it('claim reclaims a slot with no holder after the grace', async () => {
    const locks = newLocks()
    const one = path.join(locks, 'tests-1-1')
    fs.mkdirSync(one)
    const old = (Date.now() - 61_000) / 1000
    fs.utimesSync(one, old, old)
    holdSlot(locks, 'tests-1-2')
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(got.slot).toBe('tests-1-1')
  })

  it('claim leaves a slot with no holder inside the grace', async () => {
    const locks = newLocks()
    const one = path.join(locks, 'tests-1-1')
    fs.mkdirSync(one)
    const recent = (Date.now() - 10_000) / 1000
    fs.utimesSync(one, recent, recent)
    holdSlot(locks, 'tests-1-2')
    const got = await claim({
      locks,
      repo: '1',
      holder: '7 smoke',
      pid: process.pid,
      timeoutMs: 0,
      pollMs: 1,
    })
    expect(got.ok).toBe(false)
    expect(fs.existsSync(one)).toBe(true)
  })

  it('a reclaim that raced a new claim gives the live slot back', () => {
    const locks = newLocks()
    const dir = holdSlot(locks, 'tests-1-1', { pid: deadPid() })
    const result = reclaimSlot(dir, {
      now: () => Date.now(),
      isAlive: pidAlive,
      // Between the stale check and the move, a new claim takes the folder with a live holder.
      beforeRename: () => {
        fs.rmSync(dir, { recursive: true })
        holdSlot(locks, 'tests-1-1', { token: 'live-new' })
      },
    })
    expect(result).toBe(false)
    expect(parseHolder(fs.readFileSync(path.join(dir, 'holder.txt'), 'utf8')).token).toBe('live-new')
    expect(fs.readdirSync(locks)).toEqual(['tests-1-1'])
  })

  it('a slot whose holder is dead is stale, a live one is not', () => {
    const locks = newLocks()
    const dead = readSlot(holdSlot(locks, 'tests-1-1', { pid: deadPid() }))
    const live = readSlot(holdSlot(locks, 'tests-1-2'))
    expect(isStale(dead, { now: () => Date.now(), isAlive: pidAlive })).toBe(true)
    expect(isStale(live, { now: () => Date.now(), isAlive: pidAlive })).toBe(false)
  })
})

describe('release', () => {
  it('release frees only a slot whose holder it wrote', async () => {
    const locks = newLocks()
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(release(got.dir, 'not-the-token')).toBe(false)
    expect(fs.existsSync(got.dir)).toBe(true)
    expect(release(got.dir, got.token)).toBe(true)
    expect(fs.existsSync(got.dir)).toBe(false)
  })

  it('release refuses a slot another claim now holds', async () => {
    const locks = newLocks()
    const first = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    expect(release(first.dir, first.token)).toBe(true)
    const second = await claim({ locks, repo: '1', holder: '8 smoke', pid: process.pid, pollMs: 1 })
    expect(second.dir).toBe(first.dir)
    expect(release(first.dir, first.token)).toBe(false)
    expect(parseHolder(fs.readFileSync(path.join(second.dir, 'holder.txt'), 'utf8')).token).toBe(second.token)
  })

  it('the release command answers 4 and removes nothing for a token it did not write', async () => {
    const locks = newLocks()
    const got = await claim({ locks, repo: '1', holder: '7 smoke', pid: process.pid, pollMs: 1 })
    const refused = await cli(['release', got.dir, 'wrong-token'])
    expect(refused.code).toBe(4)
    expect(fs.existsSync(got.dir)).toBe(true)
    const freed = await cli(['release', got.dir, got.token])
    expect(freed.code).toBe(0)
    expect(fs.existsSync(got.dir)).toBe(false)
  })
})

describe('run', () => {
  const runArgs = (locks, command) => [
    'run',
    '--locks',
    locks,
    '--repo',
    '1',
    '--',
    process.execPath,
    '-e',
    command,
  ]

  it('run releases the slot and passes the exit code through', async () => {
    const locks = newLocks()
    const failed = await cli(runArgs(locks, 'process.exit(3)'))
    expect(failed.code).toBe(3)
    expect(fs.readdirSync(locks)).toEqual([])
    const passed = await cli(runArgs(locks, 'process.exit(0)'))
    expect(passed.code).toBe(0)
    expect(fs.readdirSync(locks)).toEqual([])
  })

  it('run releases the slot when the command is killed', async () => {
    const locks = newLocks()
    const killed = await cli(runArgs(locks, 'process.kill(process.pid, "SIGKILL")'))
    expect(killed.code).toBe(128 + 9)
    expect(fs.readdirSync(locks)).toEqual([])
  })
})

describe('the slots under concurrency and full runs', () => {
  it('three concurrent claims never hold the same slot', async () => {
    const locks = newLocks()
    const runs = await Promise.all(
      [0, 1, 2].map(() =>
        cli(['claim', locks, '1', '7 smoke', '--timeout', '0.05'], { BOARD_SLOT_POLL_MS: '50' }),
      ),
    )
    const won = runs.filter((r) => r.code === 0)
    expect(won).toHaveLength(2)
    expect(runs.filter((r) => r.code === 3)).toHaveLength(1)
    const slots = won.map((r) => r.stdout.split('\t')[0]).sort()
    expect(slots.map((dir) => path.basename(dir))).toEqual(['tests-1-1', 'tests-1-2'])
    expect(
      fs
        .readdirSync(locks)
        .filter((name) => name.startsWith('tests-'))
        .sort(),
    ).toEqual(['tests-1-1', 'tests-1-2'])
  }, 30_000)

  it('a full run waits for every numbered slot and blocks new claims', async () => {
    const locks = newLocks()
    holdSlot(locks, 'tests-1-1')
    const full = await claim({
      locks,
      repo: '1',
      holder: '9 full',
      pid: process.pid,
      full: true,
      pollMs: 1,
      sleep: async () => fs.rmSync(path.join(locks, 'tests-1-1'), { recursive: true }),
    })
    expect(full.ok).toBe(true)
    expect(full.slot).toBe('tests-1-full')

    // While the full folder exists, a numbered claim waits: both numbered folders are free, nothing is taken.
    let fullWhileWaiting = null
    let numberedWhileWaiting = null
    const numbered = await claim({
      locks,
      repo: '1',
      holder: '5 build',
      pid: process.pid,
      pollMs: 1,
      sleep: async () => {
        fullWhileWaiting = fs.existsSync(path.join(locks, 'tests-1-full'))
        numberedWhileWaiting = fs
          .readdirSync(locks)
          .filter((name) => name.startsWith('tests-1-') && !name.endsWith('full'))
        fs.rmSync(path.join(locks, 'tests-1-full'), { recursive: true })
      },
    })
    expect(fullWhileWaiting).toBe(true)
    expect(numberedWhileWaiting).toEqual([])
    expect(numbered.slot).toBe('tests-1-1')
  })
})

describe('the ticket agent instructions', () => {
  it('the ticket agent takes its slots with the script', () => {
    const text = fs.readFileSync(INSTRUCTIONS, 'utf8')
    const start = text.indexOf('## Shared with the other tickets of this repo')
    expect(start).toBeGreaterThan(-1)
    const next = text.indexOf('\n## ', start + 1)
    const section = text.slice(start, next === -1 ? undefined : next)
    expect(section).toContain('board-slot.mjs')
    expect(section).toContain('run --')
    expect(section).not.toMatch(/mkdir\b[^\n]*tests-/)
    expect(section).not.toMatch(/rm -r[^\n]*tests-/)
    expect(section).not.toMatch(/write[^\n]*holder\.txt/i)
    // The lock-error rule and the priority rule stay as they were.
    expect(section).toContain('Unable to create')
    expect(section).toContain('**Priority.**')
    // Light checks take no slot.
    expect(section).toMatch(/light ones take no slot/)
  })
})
