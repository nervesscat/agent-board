// Loaded into the benchmarked server with `node --import`, never by the board itself: counts the SQL
// statements and child processes each HTTP request causes, and answers the server's memory, over the
// IPC channel the harness opens when it spawns the server. Without that channel it does nothing.
//
// A request is followed through its async work with AsyncLocalStorage, from the moment the server
// receives it until its response is finished; work outside any request (timers, background fetches)
// is counted apart. Only requests carrying an `x-bench-req` header are reported one by one.
import { AsyncLocalStorage } from 'node:async_hooks'
import { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'

if (typeof process.send === 'function' && isMainThread) {
  const als = new AsyncLocalStorage()
  const background = { db: 0, spawns: [] }
  const status = { db: false, spawn: false, reason: [] }

  const current = () => {
    const ctx = als.getStore()
    return ctx && !ctx.done ? ctx : background
  }

  // SQL statements: better-sqlite3 as the server resolves it (the build ships its own copy).
  try {
    const require = createRequire(pathToFileURL(path.resolve(process.argv[1] ?? '.')))
    const Database = require('better-sqlite3')
    const probe = new Database(':memory:')
    const Statement = Object.getPrototypeOf(probe.prepare('select 1'))
    probe.close()
    for (const method of ['run', 'get', 'all', 'iterate']) {
      const original = Statement[method]
      if (typeof original !== 'function') continue
      Statement[method] = function (...args) {
        current().db++
        return original.apply(this, args)
      }
    }
    const exec = Database.prototype.exec
    Database.prototype.exec = function (...args) {
      current().db++
      return exec.apply(this, args)
    }
    status.db = true
  } catch (err) {
    status.reason.push(`SQL statements not counted: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Child processes: every spawn, execFile and exec ends in ChildProcess#spawn.
  try {
    const spawn = ChildProcess.prototype.spawn
    ChildProcess.prototype.spawn = function (options) {
      const args = options?.args ?? []
      const file = path.basename(String(options?.file ?? '?')).replace(/\.(exe|cmd|bat)$/i, '')
      // With a shell the command is the shell's argument; name what it runs instead of cmd.exe or sh.
      const shown = options?.shell || /^(cmd|sh|bash)$/i.test(file) ? String(args.at(-1) ?? file) : file
      current().spawns.push(shown.split(/\s+/)[0] ?? shown)
      return spawn.call(this, options)
    }
    status.spawn = true
  } catch (err) {
    status.reason.push(`child processes not counted: ${err instanceof Error ? err.message : String(err)}`)
  }

  let next = 0
  const emit = http.Server.prototype.emit
  http.Server.prototype.emit = function (event, req, res, ...rest) {
    // The harness reads this when the server exits on the failed bind: written synchronously, as the exit
    // follows at once.
    if (event === 'error' && req?.code === 'EADDRINUSE')
      fs.writeSync(2, `[bench] bind failed: EADDRINUSE pid=${process.pid}\n`)
    if (event !== 'request' || !req || !res) return emit.call(this, event, req, res, ...rest)
    const header = req.headers['x-bench-req']
    const ctx = { id: typeof header === 'string' ? header : null, n: ++next, db: 0, spawns: [], done: false }
    const started = process.hrtime.bigint()
    let reported = false
    const report = () => {
      if (reported) return
      reported = true
      ctx.done = true
      if (ctx.id === null) return
      process.send?.({
        type: 'request',
        id: ctx.id,
        db: ctx.db,
        spawns: ctx.spawns,
        serverMs: Number(process.hrtime.bigint() - started) / 1e6,
      })
    }
    res.once('finish', report)
    res.once('close', report)
    return als.run(ctx, () => emit.call(this, event, req, res, ...rest))
  }

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'memory')
      process.send?.({ type: 'memory', seq: msg.seq, at: Date.now(), ...process.memoryUsage() })
    if (msg.type === 'background')
      process.send?.({ type: 'background', seq: msg.seq, db: background.db, spawns: [...background.spawns] })
  })
  // The channel must not keep a server alive that would otherwise exit. When it closes, the harness is
  // gone (even killed outright, which runs none of its clean-up): so is this server.
  process.channel?.unref()
  process.once('disconnect', () => process.exit(0))
  process.send({ type: 'instrumentation', ...status })
}
