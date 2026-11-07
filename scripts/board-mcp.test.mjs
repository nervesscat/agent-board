import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { messagesOf } from './board-mcp.mjs'

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board-mcp.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-bridge-'))

// The board's /api/mcp as a stand-in: it records each request and answers as the case says.
const seen = []
let answer = () => ({ status: 200, type: 'application/json', body: '{}' })
const board = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push({ url: req.url, headers: req.headers, body })
    const a = answer(body)
    res.writeHead(a.status, { 'content-type': a.type, ...(a.headers ?? {}) })
    res.end(a.body)
  })
})
// An HTTP proxy that only tunnels (CONNECT), as a tailnet's userspace proxy does.
const tunnels = []
const proxy = http.createServer((_req, res) => res.writeHead(405).end())
proxy.on('connect', (req, client, head) => {
  tunnels.push(req.url)
  const [host, port] = req.url.split(':')
  const upstream = net.connect(Number(port), host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
})
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
let boardPort
let proxyPort
beforeAll(async () => {
  boardPort = await listen(board)
  proxyPort = await listen(proxy)
})
afterAll(() => {
  board.close()
  proxy.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const withoutBoard = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^BOARD_/i.test(k)))

/** Runs the bridge with `env`, feeds it `lines`, and returns what it wrote: stdout's messages and stderr. */
function runBridge(env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      // This machine's environment without its own BOARD_* settings: only the case's reach the bridge.
      env: { ...withoutBoard(process.env), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code,
        messages: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
        stderr: err,
      }),
    )
    for (const l of lines) child.stdin.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`)
    child.stdin.end()
  })
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const byId = (messages) => Object.fromEntries(messages.map((m) => [m.id, m]))

describe('board-mcp, the stdio bridge to the board', () => {
  it('posts each message to /api/mcp with the token and writes each answer as a line', async () => {
    seen.length = 0
    answer = (msg) =>
      msg.method === 'notifications/initialized'
        ? { status: 202, type: 'text/plain', body: '' }
        : msg.method === 'tools/list'
          ? // An event stream answer, as the streamable HTTP transport may give.
            {
              status: 200,
              type: 'text/event-stream',
              body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami' }] } })}\n\n`,
            }
          : {
              status: 200,
              type: 'application/json',
              body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: 1 } }),
            }
    const { code, messages, stderr } = await runBridge(
      {
        BOARD_URL: `http://127.0.0.1:${boardPort}/`,
        BOARD_TOKEN: 'tok-secret',
        BOARD_AGENT_NAME: 'claude/builder',
      },
      [init, initialized, list],
    )
    expect(code).toBe(0)
    expect(byId(messages)).toEqual({
      1: { jsonrpc: '2.0', id: 1, result: { ok: 1 } },
      2: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'whoami' }] } },
    })
    // The notification was relayed, and nothing came back for it.
    expect(messages).toHaveLength(2)
    expect(seen.map((s) => s.body.method).sort()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    for (const s of seen) {
      expect(s.url).toBe('/api/mcp')
      expect(s.headers.authorization).toBe('Bearer tok-secret')
      expect(s.headers.accept).toBe('application/json, text/event-stream')
      expect(s.headers['x-agent-name']).toBe('claude/builder')
      expect(s.headers.host).toBe(`127.0.0.1:${boardPort}`)
    }
    expect(stderr).not.toContain('tok-secret')
  })

  it('goes through BOARD_PROXY with a CONNECT tunnel, the Host as BOARD_URL names it', async () => {
    seen.length = 0
    tunnels.length = 0
    answer = (msg) => ({
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
    })
    const { messages } = await runBridge(
      {
        BOARD_URL: `http://127.0.0.1:${boardPort}`,
        BOARD_TOKEN: 't',
        BOARD_PROXY: `http://127.0.0.1:${proxyPort}`,
      },
      [init],
    )
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
    expect(tunnels).toEqual([`127.0.0.1:${boardPort}`])
    expect(seen[0].headers.host).toBe(`127.0.0.1:${boardPort}`)
  })

  it('runs BOARD_UP once before its first request, its output kept off stdout', async () => {
    seen.length = 0
    const marker = path.join(tmp, 'up-once.txt')
    let upBeforeFirst = null
    answer = (msg) => {
      upBeforeFirst ??= fs.existsSync(marker)
      return {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
      }
    }
    const up = `node -e "require('fs').appendFileSync(process.argv[1], 'up\\n'); console.log('network is up')" "${marker}"`
    const { messages, stderr } = await runBridge(
      { BOARD_URL: `http://127.0.0.1:${boardPort}`, BOARD_TOKEN: 't', BOARD_UP: up },
      [init, list],
    )
    expect(byId(messages)).toEqual({
      1: { jsonrpc: '2.0', id: 1, result: {} },
      2: { jsonrpc: '2.0', id: 2, result: {} },
    })
    expect(upBeforeFirst).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toBe('up\n')
    expect(stderr).toContain('network is up')
  })

  it('brings the network up again when the board cannot be reached, retries once, then answers an error', async () => {
    const marker = path.join(tmp, 'up-again.txt')
    // A port nothing listens on any more.
    const free = net.createServer()
    const deadPort = await new Promise((r) => free.listen(0, '127.0.0.1', () => r(free.address().port)))
    await new Promise((r) => free.close(r))
    const up = `node -e "require('fs').appendFileSync(process.argv[1], 'up\\n')" "${marker}"`
    const { messages, stderr } = await runBridge(
      { BOARD_URL: `http://127.0.0.1:${deadPort}`, BOARD_TOKEN: 't', BOARD_UP: up },
      [init, initialized],
    )
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: expect.stringMatching(
            /^cannot reach the board at http:\/\/127\.0\.0\.1:\d+: .*ECONNREFUSED/,
          ),
        },
      },
    ])
    // The first run, then one more for the failing requests together.
    expect(fs.readFileSync(marker, 'utf8')).toBe('up\nup\n')
    expect(stderr).toMatch(/running BOARD_UP and retrying once/)
  })

  it("answers a request the board refused with the board's own error, and says what a 401 means", async () => {
    answer = () => ({
      status: 401,
      type: 'application/json',
      body: JSON.stringify({ error: 'not signed in' }),
    })
    const { messages } = await runBridge({ BOARD_URL: `http://127.0.0.1:${boardPort}`, BOARD_TOKEN: 'old' }, [
      init,
      initialized,
    ])
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'the board answered 401 (the agent token is wrong, revoked or expired): not signed in',
        },
      },
    ])
  })

  it('answers every request with what is missing when it is not set up, and a parse error for a bad line', async () => {
    seen.length = 0
    const { messages, stderr } = await runBridge({ BOARD_URL: `http://127.0.0.1:${boardPort}` }, [
      init,
      'not json',
    ])
    expect(byId(messages)).toEqual({
      1: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'board-mcp: BOARD_TOKEN is not set' } },
      null: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
    })
    expect(seen).toEqual([])
    expect(stderr).toContain('BOARD_TOKEN is not set')
    const bad = await runBridge({ BOARD_URL: 'ftp://board', BOARD_TOKEN: 't' }, [init])
    expect(bad.messages[0].error.message).toMatch(/BOARD_URL must be/)
  })

  it('reads JSON bodies, batches and event streams', () => {
    expect(messagesOf('application/json', '{"id":1}')).toEqual([{ id: 1 }])
    expect(messagesOf('application/json', '[{"id":1},{"id":2}]')).toEqual([[{ id: 1 }, { id: 2 }]])
    expect(
      messagesOf(
        'text/event-stream',
        'event: message\r\ndata: {"id":1}\r\n\r\nid: 2\ndata: {"id":\ndata: 2}\n\n',
      ),
    ).toEqual([{ id: 1 }, { id: 2 }])
    expect(messagesOf('application/json', '  ')).toEqual([])
  })
})
