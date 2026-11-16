import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

const database = path.join(tmp, 'board.db')
const driver = () => createRequire(import.meta.url).resolve('better-sqlite3')

let db: typeof import('#/db').db
let schema: typeof import('#/db').schema
let features: typeof import('./features')
let needs: typeof import('./needs')
let listStages: typeof import('./stages').listStages

beforeAll(async () => {
  features = await import('./features')
  needs = await import('./needs')
  ;({ listStages } = await import('./stages'))
  ;({ db, schema } = await import('#/db'))
})

/** A project with a repo and its stages, so a ticket can be placed in it. */
function project(name: string): number {
  const id = db.insert(schema.projects).values({ name }).returning().get().id
  db.insert(schema.repos)
    .values({ projectId: id, name: 'repo', repoPath: `/r/${name}`, baseBranch: 'main' })
    .run()
  listStages(id)
  return id
}

/** A connection of its own on another thread: it can hold the write lock while this thread's write waits. */
function holder(source: string, extra: Record<string, unknown> = {}) {
  return new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
    const Database = require(workerData.driver)
    const other = new Database(workerData.file)
    ${source}
    other.close()`,
    { eval: true, workerData: { driver: driver(), file: database, ...extra } },
  )
}

/** Runs `fn` once the worker says it holds the lock, and waits for the worker to end afterwards. */
async function whileHeld(worker: Worker, fn: () => Promise<void>) {
  const ended = new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', () => resolve())
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  try {
    await fn()
  } finally {
    await ended
  }
}

/** The top-level phases a created ticket carries, in order. */
const phasesOf = (id: number) =>
  features
    .getTicketFull(id)
    .tasks.filter((task) => task.parentId === null)
    .map((task) => task.text)

const BUILT_IN = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Summary', 'Merged']

describe('ticket writes under a competing writer', () => {
  it(
    'waits out a write lock another connection holds, instead of answering a 500',
    { timeout: 20_000 },
    async () => {
      const projectId = project('create-waits-out-a-lock')
      // The holder keeps the write lock longer than the connection waits for one on its own (5 s,
      // better-sqlite3's default): a create that only relied on that wait would throw SQLITE_BUSY.
      // The write path tries again, so it still lands.
      const worker = holder(
        `other.prepare('BEGIN IMMEDIATE').run()
        other.prepare("INSERT INTO projects (name) VALUES ('holder')").run()
        parentPort.postMessage('locked')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500)
        other.prepare('COMMIT').run()`,
      )
      await whileHeld(worker, async () => {
        const row = await needs.newTicket(projectId, { title: 'waited out the lock' }, 'human', {
          agent: false,
        })
        expect(row.title).toBe('waited out the lock')
      })
      const [ticket] = features.listTickets(projectId)
      expect(ticket!.title).toBe('waited out the lock')
      expect(phasesOf(ticket!.id)).toEqual(BUILT_IN)
    },
  )

  it(
    'writes a burst of creates exactly once each, whatever locks it meets on the way',
    { timeout: 60_000 },
    async () => {
      const projectId = project('create-burst')
      const titles = Array.from({ length: 50 }, (_, i) => `Burst ${i + 1}`)
      // Another connection takes the write lock for a moment, over and over, until this thread is done:
      // creates issued meanwhile lost the lock and have to try again.
      const end = new SharedArrayBuffer(4)
      const worker = holder(
        `const stop = new Int32Array(workerData.end)
        parentPort.postMessage('ready')
        while (Atomics.load(stop, 0) === 0) {
          other.prepare('BEGIN IMMEDIATE').run()
          other.prepare("INSERT INTO projects (name) VALUES ('holder-burst')").run()
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
          other.prepare('COMMIT').run()
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        }`,
        { end },
      )
      await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve())
        worker.once('error', reject)
      })
      const failures: string[] = []
      try {
        for (const title of titles) {
          try {
            await needs.newTicket(projectId, { title }, 'human', { agent: false })
          } catch (err) {
            failures.push(`${title}: ${(err as Error).message}`)
          }
        }
      } finally {
        Atomics.store(new Int32Array(end), 0, 1)
        await new Promise((resolve) => worker.once('exit', resolve))
      }
      expect(failures, failures.join('\n')).toEqual([])

      // Exactly the tickets asked for: no title twice, none missing.
      const tickets = features.listTickets(projectId)
      expect(tickets.map((t) => t.title).sort()).toEqual([...titles].sort())
      for (const ticket of tickets) expect(phasesOf(ticket.id)).toEqual(BUILT_IN)

      // And one activity line per ticket, no more (a retry must not write it twice).
      const created = db
        .select()
        .from(schema.activity)
        .where(eq(schema.activity.projectId, projectId))
        .all()
        .filter((line) => line.kind === 'ticket')
      expect(created.map((line) => line.text).sort()).toEqual(
        tickets.map((t) => `created ticket #${t.id} ${t.title}`).sort(),
      )

      // A create that fails writes nothing: the ticket and its rows land together or not at all.
      expect(() =>
        features.createTicket(projectId, { title: 'never written', attachmentIds: [999_999] }, 'human'),
      ).toThrow()
      expect(features.listTickets(projectId)).toHaveLength(titles.length)
    },
  )
})
