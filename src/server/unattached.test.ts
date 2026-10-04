import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-unattached-'))
process.env.DATA_DIR = tmp

let db: typeof import('#/db').db
let schema: typeof import('#/db').schema
let storage: typeof import('./storage')
let unattached: typeof import('./unattached')
let projectId: number
let ticketId: number
beforeAll(async () => {
  ;({ db, schema } = await import('#/db'))
  storage = await import('./storage')
  unattached = await import('./unattached')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  ticketId = db
    .insert(schema.tickets)
    .values({ projectId, title: 't', createdBy: 'claude' })
    .returning()
    .get().id
})

const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** An upload with its file in `dir`, made `age` ago. */
function upload(dir: string, name: string, age = 2 * DAY) {
  fs.writeFileSync(path.join(dir, name), name)
  return db
    .insert(schema.attachments)
    .values({
      name,
      mime: 'image/png',
      size: name.length,
      storedAs: name,
      uploadedBy: 'enrique',
      createdAt: ago(age),
    })
    .returning()
    .get()
}

const row = (id: number) => db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()

describe('unattached uploads', () => {
  it('deletes old uploads nothing points at, file and row, and keeps every other', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const store = storage.localStore(dir)
    const a = schema.attachments

    const onTicket = upload(dir, 'ticket.png')
    db.update(a).set({ ticketId }).where(eq(a.id, onTicket.id)).run()
    const post = db
      .insert(schema.updates)
      .values({ ticketId, author: 'claude', body: 'done' })
      .returning()
      .get()
    const onPost = upload(dir, 'post.png')
    db.update(a).set({ updateId: post.id }).where(eq(a.id, onPost.id)).run()
    const reply = db
      .insert(schema.comments)
      .values({ parentType: 'update', parentId: post.id, author: 'enrique', body: 'ok' })
      .returning()
      .get()
    const onReply = upload(dir, 'reply.png')
    db.update(a).set({ commentId: reply.id }).where(eq(a.id, onReply.id)).run()
    const avatar = upload(dir, 'avatar.png')
    db.insert(schema.agents)
      .values({ projectId, name: 'Reviewer', createdBy: 'enrique', avatarId: avatar.id })
      .run()
    // Linked from text by URL instead of attached: the board's own address or relative.
    const inBody = upload(dir, 'body.png')
    db.update(schema.tickets)
      .set({ body: `see ![shot](http://localhost:47100/api/uploads/${inBody.id})` })
      .where(eq(schema.tickets.id, ticketId))
      .run()
    const inInstructions = upload(dir, 'instructions.png')
    db.update(schema.projects)
      .set({ instructions: `![](/api/uploads/${inInstructions.id})` })
      .where(eq(schema.projects.id, projectId))
      .run()

    const orphan = upload(dir, 'orphan.png')
    const young = upload(dir, 'young.png', 23 * 60 * 60 * 1000)

    expect(unattached.unattachedUploads()).toEqual({ count: 1, bytes: 'orphan.png'.length, recent: 1 })
    const { cleanupReport } = await import('./cleanup')
    expect((await cleanupReport(projectId, { reach: false })).uploads).toMatchObject({ count: 1 })
    expect(await unattached.deleteUnattachedUploads({ store })).toEqual({
      deleted: 1,
      bytes: 'orphan.png'.length,
      failed: 0,
    })
    expect(row(orphan.id)).toBeUndefined()
    expect(fs.existsSync(path.join(dir, 'orphan.png'))).toBe(false)
    for (const kept of [onTicket, onPost, onReply, avatar, inBody, inInstructions, young]) {
      expect(row(kept.id)).toBeDefined()
      expect(fs.existsSync(path.join(dir, kept.storedAs))).toBe(true)
    }
    expect(unattached.unattachedUploads()).toEqual({ count: 0, bytes: 0, recent: 1 })

    // A day later the young one has had its time; an agent without its picture frees that one too.
    db.delete(schema.agents).run()
    const later = await unattached.deleteUnattachedUploads({ store, now: Date.now() + DAY })
    expect(later.deleted).toBe(2)
    expect(row(young.id)).toBeUndefined()
    expect(row(avatar.id)).toBeUndefined()
    expect(row(onTicket.id)).toBeDefined()
  })

  it('deletes the row of a file that is already gone', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const gone = upload(dir, 'gone.png')
    fs.rmSync(path.join(dir, 'gone.png'))
    const r = await unattached.deleteUnattachedUploads({ store: storage.localStore(dir) })
    expect(r).toMatchObject({ deleted: 1, failed: 0 })
    expect(row(gone.id)).toBeUndefined()
  })

  it('keeps the row when the store cannot delete the file', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const stuck = upload(dir, 'stuck.png')
    const failing: import('./storage').FileStore = {
      ...storage.localStore(dir),
      delete: async () => {
        throw new Error('file storage unreachable')
      },
    }
    expect(await unattached.deleteUnattachedUploads({ store: failing })).toEqual({
      deleted: 0,
      bytes: 0,
      failed: 1,
    })
    expect(row(stuck.id)).toBeDefined()
    // The next run gets it.
    expect((await unattached.deleteUnattachedUploads({ store: storage.localStore(dir) })).deleted).toBe(1)
    expect(row(stuck.id)).toBeUndefined()
  })

  it('never deletes from a bucket a copy of the data shares with the live board', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const shared = upload(dir, 'shared.png')
    let deletes = 0
    const bucket: import('./storage').FileStore = {
      ...storage.localStore(dir),
      kind: 's3',
      delete: async () => void deletes++,
    }
    process.env.BOARD_DATA_COPY = '1'
    try {
      await expect(unattached.deleteUnattachedUploads({ store: bucket })).rejects.toThrow(/copy of the data/)
    } finally {
      delete process.env.BOARD_DATA_COPY
    }
    expect(deletes).toBe(0)
    expect(row(shared.id)).toBeDefined()
    db.delete(schema.attachments).where(eq(schema.attachments.id, shared.id)).run()
  })
})

describe('what holds an upload comes from the schema', () => {
  // Last in the file: it adds a column and tables the other tests never expect.
  it('keeps uploads held by a column, foreign key or text it was never told about', async () => {
    const { sql } = await import('drizzle-orm')
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const store = storage.localStore(dir)
    // What a later feature might add: an owner column, a table pointing at uploads, a text linking one.
    db.run(sql`alter table attachments add column invoice_id integer`)
    db.run(sql`create table pinned (id integer primary key, file_id integer references attachments(id))`)
    db.run(sql`create table memos (id integer primary key, text text not null)`)

    const byColumn = upload(dir, 'invoice.pdf')
    db.run(sql`update attachments set invoice_id = 1 where id = ${byColumn.id}`)
    const byKey = upload(dir, 'pinned.png')
    db.run(sql`insert into pinned (file_id) values (${byKey.id})`)
    const byText = upload(dir, 'linked.png')
    db.run(sql`insert into memos (text) values (${`see ![x](/api/uploads/${byText.id})`})`)
    const loose = upload(dir, 'loose.png')

    await unattached.deleteUnattachedUploads({ store })
    expect(row(byColumn.id)).toBeDefined()
    expect(row(byKey.id)).toBeDefined()
    expect(row(byText.id)).toBeDefined()
    expect(row(loose.id)).toBeUndefined()
  })
})
