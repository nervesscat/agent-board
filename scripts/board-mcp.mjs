#!/usr/bin/env node
// The board's MCP tools over stdio, for an agent that reaches the board only through a proxy or a
// network it brings up itself (a cloud session on the tailnet, for one). Its client starts this as a
// stdio MCP server; each JSON-RPC message read from stdin is posted to <BOARD_URL>/api/mcp, and each
// message the board answers with is written to stdout, one per line.
//
//   BOARD_URL    the board as this machine reaches it, e.g. https://<machine>.<tailnet>.ts.net
//   BOARD_TOKEN  the agent token (Authorization: Bearer); read from the environment, never printed
//   BOARD_PROXY  optional http://host:port of an HTTP proxy that tunnels (CONNECT) to BOARD_URL
//   BOARD_UP     optional shell command that brings the network up (e.g. tailnet-up): run before the
//                first request, and once more when a request cannot connect, which is then retried
//
// stdout carries the protocol only: BOARD_UP's output and every note go to stderr.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import readline from 'node:readline'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'

const log = (msg) => process.stderr.write(`board-mcp: ${msg}\n`)

function settings(env) {
  const base = (env.BOARD_URL ?? '').trim().replace(/\/+$/, '')
  let target
  try {
    target = new URL(`${base}/api/mcp`)
  } catch {
    target = null
  }
  if (!target || !/^https?:$/.test(target.protocol))
    return { problem: 'BOARD_URL must be the board as http(s)://host[:port]' }
  if (!env.BOARD_TOKEN) return { problem: 'BOARD_TOKEN is not set' }
  let proxy = null
  if (env.BOARD_PROXY) {
    try {
      proxy = new URL(env.BOARD_PROXY.includes('://') ? env.BOARD_PROXY : `http://${env.BOARD_PROXY}`)
    } catch {
      return { problem: 'BOARD_PROXY must be http://host:port' }
    }
    if (proxy.protocol !== 'http:') return { problem: 'BOARD_PROXY must be http://host:port' }
  }
  return {
    target,
    token: env.BOARD_TOKEN,
    proxy,
    up: env.BOARD_UP?.trim() || null,
    agentName: env.BOARD_AGENT_NAME?.trim() || null,
  }
}

/** Runs BOARD_UP; resolves either way (its failure shows as the requests' errors). */
function runUp(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => process.stderr.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('error', (err) => {
      log(`BOARD_UP could not start: ${err.message}`)
      resolve()
    })
    // 'exit', not 'close': a daemon BOARD_UP leaves running may hold its output open for good.
    child.on('exit', (code) => {
      if (code !== 0) log(`BOARD_UP exited with ${code}`)
      resolve()
    })
  })
}

/** A socket to the board through the proxy's CONNECT tunnel (TLS on top for https). */
function tunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? 443 : 80)
    const authority = `${target.hostname}:${port}`
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: timeoutMs,
    })
    req.on('timeout', () => req.destroy(new Error(`the proxy ${proxy.host} did not answer`)))
    req.on('error', reject)
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`the proxy ${proxy.host} refused the tunnel (${res.statusCode})`))
      }
      if (target.protocol !== 'https:') return resolve(socket)
      const secure = tls.connect({ socket, servername: target.hostname }, () => resolve(secure))
      secure.on('error', reject)
    })
    req.end()
  })
}

/** Failures that come before the board could have read the request: safe to send again. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

/** One POST to the board: `{status, type, body, sessionId}`. */
async function post(cfg, payload, sessionId, timeoutMs = 120_000) {
  const { target, proxy } = cfg
  const headers = {
    // As the URL names it (Node would add :80 to a tunnelled request's Host).
    host: target.host,
    authorization: `Bearer ${cfg.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(payload),
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (cfg.agentName) headers['x-agent-name'] = cfg.agentName
  let socket = null
  if (proxy)
    socket = await tunnel(proxy, target, timeoutMs).catch((err) => {
      throw Object.assign(err, { beforeSend: true })
    })
  const lib = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: 'POST',
        headers,
        timeout: timeoutMs,
        // A tunnelled socket is used as it is (no agent: Node then takes createConnection); else a fresh one.
        ...(socket ? { createConnection: () => socket } : { agent: false }),
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            sessionId:
              typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : null,
          }),
        )
      },
    )
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('the board did not answer in time'), { code: 'ETIMEDOUT' })),
    )
    req.on('error', (err) =>
      reject(Object.assign(err, { beforeSend: err.beforeSend || NOT_SENT.has(err.code) })),
    )
    req.end(payload)
  })
}

/** The messages in a response: a JSON body (one message or a batch), or an event stream's data. */
export function messagesOf(type, body) {
  if (!body.trim()) return []
  if (type.includes('text/event-stream')) {
    const out = []
    for (const event of body.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data.trim()) out.push(JSON.parse(data))
    }
    return out
  }
  return [JSON.parse(body)]
}

/** The ids a message (or batch) asks an answer for: notifications and responses have none. */
const requestIds = (msg) =>
  (Array.isArray(msg) ? msg : [msg])
    .filter((m) => m && m.method && m.id !== undefined && m.id !== null)
    .map((m) => m.id)

const errorReply = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })

export function startBridge(env = process.env, input = process.stdin, output = process.stdout) {
  const cfg = settings(env)
  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`)
  let sessionId = null
  let upDone = null
  const ensureUp = (again = false) => {
    if (!cfg.up) return Promise.resolve()
    if (!upDone || again) upDone = runUp(cfg.up)
    return upDone
  }
  let reUp = null

  async function relay(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    const ids = requestIds(msg)
    if (cfg.problem) return ids.forEach((id) => write(errorReply(id, `board-mcp: ${cfg.problem}`)))
    const payload = JSON.stringify(msg)
    let res
    try {
      await ensureUp()
      try {
        res = await post(cfg, payload, sessionId)
      } catch (err) {
        // The network is down (an answer of any status resolves the post): bring it up again, once for
        // every request failing now, then retry. A request the board may have read is never sent twice.
        if (!err.beforeSend) throw err
        log(
          `cannot reach the board (${err.code ?? err.message}); ${cfg.up ? 'running BOARD_UP and ' : ''}retrying once`,
        )
        reUp ??= ensureUp(true).finally(() => (reUp = null))
        await reUp
        res = await post(cfg, payload, sessionId)
      }
    } catch (err) {
      return ids.forEach((id) =>
        write(errorReply(id, `cannot reach the board at ${cfg.target.origin}: ${err.message}`)),
      )
    }
    if (res.sessionId) sessionId = res.sessionId
    if (res.status < 200 || res.status >= 300) {
      let said = res.body.trim().slice(0, 300)
      try {
        said = JSON.parse(res.body).error?.message ?? JSON.parse(res.body).error ?? said
      } catch {}
      const hint = res.status === 401 ? ' (the agent token is wrong, revoked or expired)' : ''
      return ids.forEach((id) => write(errorReply(id, `the board answered ${res.status}${hint}: ${said}`)))
    }
    let messages
    try {
      messages = messagesOf(res.type, res.body)
    } catch {
      return ids.forEach((id) => write(errorReply(id, 'the board answered something that is not JSON-RPC')))
    }
    for (const m of messages) write(m)
  }

  if (cfg.problem) log(cfg.problem)
  const pending = new Set()
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const p = relay(line).catch((err) => log(`relay failed: ${err.message}`))
    pending.add(p)
    p.finally(() => pending.delete(p))
  })
  return new Promise((resolve) =>
    rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve())),
  )
}

const isMain = () => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
if (isMain()) startBridge().then(() => process.exit(0))
