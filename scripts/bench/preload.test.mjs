import { fork } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, expect, it } from 'vitest'

// A tiny server in place of the board: a request runs three SQL statements and starts one process,
// and two statements run outside any request. It lives under node_modules so it resolves
// better-sqlite3 the way the built board does.
const dir = path.resolve('node_modules', '.cache', 'bench-preload-test')
const server = path.join(dir, 'server.mjs')
const preload = pathToFileURL(path.resolve('scripts', 'bench', 'preload.mjs')).href
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
  server,
  `import { execFile } from 'node:child_process'
import http from 'node:http'
import Database from 'better-sqlite3'
const db = new Database(':memory:')
const insert = db.prepare('create table t (x)').run() && db.prepare('insert into t values (?)')
const srv = http.createServer(async (req, res) => {
  insert.run(1)
  await new Promise((r) => setTimeout(r, 5))
  db.prepare('select count(*) from t').get()
  insert.run(2)
  await new Promise((r) => execFile(process.execPath, ['-e', ''], r))
  res.end('ok')
})
srv.listen(0, '127.0.0.1', () => {
  setTimeout(() => {
    db.prepare('select 1').get()
    process.send({ type: 'port', port: srv.address().port })
  }, 10)
})
`,
)

let child
afterAll(() => {
  child?.kill()
  fs.rmSync(dir, { recursive: true, force: true })
})

const get = (port, headers) =>
  new Promise((resolve, reject) =>
    http
      .get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      .on('error', reject),
  )

it('counts the SQL statements and processes each request causes, apart from background work', async () => {
  child = fork(server, [], { execArgv: ['--import', preload], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const messages = []
  const listeners = new Set()
  child.on('message', (m) => {
    messages.push(m)
    for (const l of listeners) l()
  })
  const waitFor = (pred) =>
    new Promise((resolve) => {
      const check = () => {
        const found = messages.find(pred)
        if (found) {
          listeners.delete(check)
          resolve(found)
        }
      }
      listeners.add(check)
      check()
    })

  expect(await waitFor((m) => m.type === 'instrumentation')).toMatchObject({
    db: true,
    spawn: true,
    reason: [],
  })
  const { port } = await waitFor((m) => m.type === 'port')

  await get(port, { 'x-bench-req': 'one' })
  await get(port, {})
  const one = await waitFor((m) => m.type === 'request' && m.id === 'one')
  expect(one.db).toBe(3)
  expect(one.spawns).toEqual(['node'])

  // The request without the header is not reported; creating the table and the timer's statement ran
  // outside any request.
  child.send({ type: 'background', seq: 1 })
  const bg = await waitFor((m) => m.type === 'background')
  expect(bg.db).toBe(2)
  expect(bg.spawns).toEqual([])
  expect(messages.filter((m) => m.type === 'request')).toHaveLength(1)

  child.send({ type: 'memory', seq: 2 })
  expect((await waitFor((m) => m.type === 'memory')).rss).toBeGreaterThan(0)
}, 30_000)
