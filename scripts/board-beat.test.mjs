import http from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildTimeline } from '#/lib/workTimeline'

import { beatBoard, createBeater, DEFAULT_INTERVAL_MS } from './board-beat.mjs'

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
  const posts = []
  const beater = createBeater({
    post: async (at, why) => posts.push({ at, why }),
    now: () => clock,
    intervalMs,
    setTimer: (fn) => {
      tick = fn
      return { unref() {} }
    },
    clearTimer: () => {
      tick = null
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
      tick?.()
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
      ticket: 874,
      at: new Date(T0).toISOString(),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/1/tickets/874/events',
      token: 'Bearer secret',
      agent: 'orch/builder-1',
      body: { kind: 'heartbeat' },
    })
  })

  it('reports a refused beat with what the board said', async () => {
    status = 401
    answer = { error: 'the agent token is wrong' }
    await expect(
      beatBoard({ url, token: 'secret', project: 1, ticket: 874, at: new Date(T0).toISOString() }),
    ).rejects.toThrow('the board answered 401: the agent token is wrong')
    status = 201
    answer = { at: '2026-11-12T17:15:00.000Z', lastSignalAt: '2026-11-12T17:15:00.000Z' }
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
