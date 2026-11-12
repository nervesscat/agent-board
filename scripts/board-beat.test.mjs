import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildTimeline } from '#/lib/workTimeline'

import { beatBoard, createBeater, DEFAULT_INTERVAL_MS, parseArgs } from './board-beat.mjs'

// The board's events route as a stand-in: it records each heartbeat and answers as the case says.
const seen = []
let status = 201
let answer = { at: '2026-11-12T17:15:00.000Z', lastSignalAt: '2026-11-12T17:15:00.000Z' }
const board = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    seen.push({
      method: req.method,
      url: req.url,
      token: req.headers.authorization,
      agent: req.headers['x-agent-name'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
})
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
let url
beforeAll(async () => {
  url = `http://127.0.0.1:${await listen(board)}`
})
afterAll(() => {
  board.close()
})

const MIN = 60_000
const T0 = Date.parse('2026-11-12T17:15:00.000Z')

/** A beater with a fake clock and fake timer: `advance` moves both and fires the interval once. */
function fakeBeater(intervalMs = 2 * MIN) {
  let clock = T0
  let tick = null
  // When the fake timer is due next: its setInterval fires then and every interval after, never before.
  let due = null
  const posts = []
  const beater = createBeater({
    post: async (at, why) => posts.push({ at, why }),
    now: () => clock,
    intervalMs,
    setTimer: (fn) => {
      tick = fn
      due = clock + intervalMs
      return { unref() {} }
    },
    clearTimer: () => {
      tick = null
      due = null
    },
    log: () => {},
  })
  return {
    beater,
    posts,
    get clock() {
      return clock
    },
    async advance(ms) {
      clock += ms
      if (tick && due !== null && clock >= due) {
        due += intervalMs
        tick()
      }
      await beater.idle()
    },
    hasTimer: () => tick !== null,
  }
}

describe('the beater', () => {
  it('beats when it starts, every interval while the tool runs, and once when it ends', async () => {
    const f = fakeBeater(2 * MIN)
    await f.beater.start()
    expect(f.posts.map((p) => p.why)).toEqual(['start'])
    expect(f.posts[0].at).toBe(new Date(T0).toISOString())

    await f.advance(2 * MIN)
    await f.advance(2 * MIN)
    expect(f.posts.map((p) => [p.why, p.at])).toEqual([
      ['start', new Date(T0).toISOString()],
      ['interval', new Date(T0 + 2 * MIN).toISOString()],
      ['interval', new Date(T0 + 4 * MIN).toISOString()],
    ])

    await f.beater.stop()
    expect(f.posts.map((p) => p.why)).toEqual(['start', 'interval', 'interval', 'end'])
    // The tool ended: the beater stops, and a clock that runs on without a tool posts nothing more.
    expect(f.hasTimer()).toBe(false)
    await f.advance(10 * MIN)
    expect(f.posts).toHaveLength(4)
  })

  it('beats every two minutes by default: a beat shorter than the ten-minute lease', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(2 * 60_000)
    expect(DEFAULT_INTERVAL_MS).toBeLessThan(10 * 60_000)
  })

  it('a missed beat is not fatal: the next one tries again', async () => {
    let calls = 0
    const errors = []
    const beater = createBeater({
      post: async () => {
        if (++calls === 1) throw new Error('the board is down')
      },
      intervalMs: MIN,
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
      log: (m) => errors.push(m),
    })
    await beater.start()
    expect(errors[0]).toContain('the board is down')
    expect(await beater.beat('again')).toBeTruthy()
    expect(beater.beats).toHaveLength(1)
  })

  it('posts a heartbeat for the ticket it names, as the agent token, through the events route', async () => {
    seen.length = 0
    status = 201
    await beatBoard({
      url,
      token: 'secret',
      agentName: 'orch/builder-1',
      project: 1,
      ticket: 7,
      at: new Date(T0).toISOString(),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/1/tickets/7/events',
      token: 'Bearer secret',
      agent: 'orch/builder-1',
      body: { kind: 'heartbeat' },
    })
  })

  it('reports a refused beat with what the board said', async () => {
    status = 401
    answer = { error: 'the agent token is wrong' }
    await expect(
      beatBoard({ url, token: 'secret', project: 1, ticket: 7, at: new Date(T0).toISOString() }),
    ).rejects.toThrow('the board answered 401: the agent token is wrong')
    status = 201
    answer = { at: '2026-11-12T17:15:00.000Z', lastSignalAt: '2026-11-12T17:15:00.000Z' }
  })
})

/** Sets env values for one test and gives back what restores them, deleting the ones that were unset. */
function withEnv(values) {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('the interval', () => {
  const args = ['--project', '1', '--ticket', '7']

  it('defaults from BOARD_BEAT_MS, and --interval wins over it', async () => {
    const restore = withEnv({ BOARD_TOKEN: 'secret', BOARD_BEAT_MS: '45000', BOARD_URL: undefined })
    try {
      expect(parseArgs(args).intervalMs).toBe(45_000)
      expect(parseArgs([...args, '--interval', '60000']).intervalMs).toBe(60_000)

      // The environment's cadence drives the beats: one at 45 seconds, not at the old two minutes.
      const fromEnv = fakeBeater(parseArgs(args).intervalMs)
      await fromEnv.beater.start()
      await fromEnv.advance(44_999)
      expect(fromEnv.posts).toHaveLength(1)
      await fromEnv.advance(1)
      expect(fromEnv.posts.map((p) => p.at)).toEqual([
        new Date(T0).toISOString(),
        new Date(T0 + 45_000).toISOString(),
      ])
      await fromEnv.beater.stop()

      // --interval replaces it: 45 seconds is not a beat now, a minute is.
      const overridden = fakeBeater(parseArgs([...args, '--interval', '60000']).intervalMs)
      await overridden.beater.start()
      await overridden.advance(45_000)
      expect(overridden.posts).toHaveLength(1)
      await overridden.advance(15_000)
      expect(overridden.posts.map((p) => p.at)).toEqual([
        new Date(T0).toISOString(),
        new Date(T0 + 60_000).toISOString(),
      ])
      await overridden.beater.stop()
    } finally {
      restore()
    }
  })

  it('reports an invalid BOARD_BEAT_MS as the usage problem, not silently ignored', () => {
    const restore = withEnv({ BOARD_TOKEN: 'secret', BOARD_BEAT_MS: 'soon' })
    try {
      expect(parseArgs(args)).toEqual({
        problem: expect.stringContaining(
          '--interval (or BOARD_BEAT_MS) must be a whole number of milliseconds',
        ),
      })
      process.env.BOARD_BEAT_MS = '0'
      expect(parseArgs(args)).toEqual({
        problem: expect.stringContaining(
          '--interval (or BOARD_BEAT_MS) must be a whole number of milliseconds',
        ),
      })
    } finally {
      restore()
    }
  })
})

const SCRIPT = path.join(import.meta.dirname, 'board-beat.mjs')

/** The script as an operator runs it: a real child process, its own clock, the stub board as its board. */
function runBeat(args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: 'secret', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  let exited = null
  child.on('exit', (code, signal) => (exited = { code, signal }))
  return { child, stderr: () => stderr, exited: () => exited }
}

/** Waits for `done`, or fails saying what the run looked like instead. */
async function until(done, what, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waited ${ms}ms for ${what}`)
}

describe('the wrapper as an operator runs it', () => {
  it('keeps beating with no command until it is stopped, and posts the last beat then', async () => {
    seen.length = 0
    status = 201
    const run = runBeat(['--project', '1', '--ticket', '7'], { BOARD_BEAT_MS: '120' })
    try {
      // Several intervals of a backgrounded phase: a beat each, and the process still up for them.
      await until(
        () => seen.length >= 3 || run.exited() !== null,
        `3 beats (beats=${seen.length} exit=${JSON.stringify(run.exited())} stderr=${run.stderr()})`,
      )
      expect(run.exited(), 'a background beat must stay up between its beats').toBeNull()
      expect(seen.length).toBeGreaterThanOrEqual(3)
    } finally {
      run.child.kill('SIGTERM')
      await until(() => run.exited() !== null, 'the beater to stop')
    }
    expect(run.exited()).toEqual({ code: 0, signal: null })
    expect(seen.length).toBeGreaterThanOrEqual(4)
    expect(seen.every((s) => s.url === '/api/projects/1/tickets/7/events')).toBe(true)
  })

  it('refuses a command that is not behind --, instead of dropping it silently', async () => {
    seen.length = 0
    status = 201
    const run = runBeat(['--project', '1', '--ticket', '7', 'pnpm', 'build'])
    await until(() => run.exited() !== null, 'the bad invocation to exit')
    expect(run.exited()).toEqual({ code: 2, signal: null })
    expect(run.stderr()).toContain('usage: board-beat.mjs')
    // Nothing ran and nothing was beaten: the invocation is refused before it starts.
    expect(seen).toHaveLength([])
  })

  it('starts the wrapped command even when the board accepts and never answers', async () => {
    const hang = http.createServer(() => {})
    const port = await listen(hang)
    const marker = path.join(os.tmpdir(), `board-beat-ran-${process.pid}-${Date.now()}`)
    try {
      const started = Date.now()
      const run = runBeat(
        ['--project', '1', '--ticket', '7', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        { BOARD_URL: `http://127.0.0.1:${port}`, BOARD_BEAT_TIMEOUT_MS: '150' },
      )
      try {
        await until(() => run.exited() !== null, 'the wrapper to finish')
        expect(run.exited()).toEqual({ code: 0, signal: null })
        expect(fs.readFileSync(marker, 'utf8')).toBe('ran')
        // One start beat and one end beat, each given up: the board never delays the command for long.
        expect(Date.now() - started).toBeLessThan(5000)
      } finally {
        run.child.kill('SIGKILL')
      }
    } finally {
      fs.rmSync(marker, { force: true })
      hang.closeAllConnections()
      await new Promise((r) => hang.close(r))
    }
  })

  it('gives a beat its own timeout, so a board that never answers cannot hold it', async () => {
    const hang = http.createServer(() => {})
    const port = await listen(hang)
    try {
      const started = Date.now()
      const outcome = await Promise.race([
        beatBoard({
          url: `http://127.0.0.1:${port}`,
          token: 'secret',
          project: 1,
          ticket: 7,
          at: new Date(T0).toISOString(),
          timeoutMs: 100,
        }).then(
          () => 'beat',
          (err) => err,
        ),
        new Promise((r) => setTimeout(() => r('still-waiting'), 3000)),
      ])
      expect(outcome, 'the beat must give up on its own, not wait out undici').not.toBe('still-waiting')
      expect(outcome).toBeInstanceOf(Error)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      hang.closeAllConnections()
      await new Promise((r) => hang.close(r))
    }
  })

  it('asks for the beat with an abort signal of its own timeout', async () => {
    let init
    await beatBoard({
      url,
      token: 'secret',
      project: 1,
      ticket: 7,
      at: new Date(T0).toISOString(),
      timeoutMs: 250,
      fetch: async (_url, options) => {
        init = options
        return new Response(JSON.stringify({ at: new Date(T0).toISOString() }), { status: 201 })
      },
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('the arguments a command must come behind', () => {
  const env = { BOARD_TOKEN: 'secret' }

  it('takes only a command after --, and refuses an argument it does not know', () => {
    const restore = withEnv(env)
    try {
      // Without the -- the command's words are stray arguments: refused, never run.
      expect(parseArgs(['--project', '1', '--ticket', '7', 'pnpm', 'build'])).toEqual({
        problem: expect.stringContaining('usage: board-beat.mjs'),
      })
      expect(parseArgs(['--project', '1', '--ticket', '7', '--watch'])).toEqual({
        problem: expect.stringContaining('usage: board-beat.mjs'),
      })
      // Behind it they are the command, as before.
      expect(parseArgs(['--project', '1', '--ticket', '7', '--', 'pnpm', 'build'])).toMatchObject({
        command: ['pnpm', 'build'],
      })
    } finally {
      restore()
    }
  })
})

describe('what the beats buy a long phase', () => {
  const ticket = {
    status: 'in_progress',
    archivedAt: null,
    prId: null,
    assignee: 'opencode',
    createdAt: new Date(T0).toISOString(),
    startedAt: new Date(T0).toISOString(),
  }
  const stages = [{ key: 'in_progress', kind: 'active' }]
  const span = {
    id: 1,
    kind: 'span_start',
    agent: 'opencode',
    by: 'opencode',
    phase: 'review',
    round: 4,
    refId: null,
    fromAgent: '',
    toAgent: '',
    reason: '',
    note: '',
    fromStage: '',
    toStage: '',
    at: new Date(T0).toISOString(),
  }

  it('a span whose only signals are the beater stays working past the lease TTL', async () => {
    // The agent starts the span, then says nothing itself: only the beater beats every two minutes.
    const beats = []
    const f = fakeBeater(2 * MIN)
    await f.beater.start()
    for (let i = 0; i < 8; i++) await f.advance(2 * MIN)
    await f.beater.stop()
    for (const b of f.posts) beats.push({ at: b.at, agent: 'opencode', human: false })

    // Read at 17:31 (16 minutes in, well past the 10-minute lease) while the phase still runs.
    const running = buildTimeline([span], {
      now: T0 + 16 * MIN,
      stages,
      ticket,
      stallMinutes: 30,
      posts: beats.filter((b) => Date.parse(b.at) <= T0 + 16 * MIN),
    })
    expect(running.liveness?.state).toBe('working')

    // The tool ended at 17:47 and nothing came after: at 17:58 the lease is long gone, the span is open.
    const killed = buildTimeline([span], {
      now: T0 + 43 * MIN,
      stages,
      ticket,
      stallMinutes: 30,
      posts: beats,
    })
    expect(killed.liveness?.state).toBe('lost')
    expect(killed.stalled).toBeNull()
  })
})
