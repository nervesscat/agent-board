import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-unattached-'))
process.env.DATA_DIR = tmp

let db: typeof import('#/db').db
let schema: typeof import('#/db').schema
let unattached: typeof import('./unattached')
let cleanup: typeof import('./cleanup')
let projectId: number
beforeAll(async () => {
  ;({ db, schema } = await import('#/db'))
  unattached = await import('./unattached')
  cleanup = await import('./cleanup')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
})

const DAY = 24 * 60 * 60 * 1000

/** An upload made two days ago, held by nothing yet. */
const upload = (name: string) =>
  db
    .insert(schema.attachments)
    .values({
      name,
      mime: 'image/png',
      size: 10,
      storedAs: name,
      uploadedBy: 'enrique',
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    })
    .returning()
    .get()

/** The statements SQLite runs from here on, as the server's own connection prepares them. */
function statements() {
  const sqlite = (db as unknown as { $client: { prepare: (s: string) => unknown } }).$client
  const prepare = sqlite.prepare.bind(sqlite)
  const seen: string[] = []
  sqlite.prepare = (s: string) => {
    seen.push(s)
    return prepare(s)
  }
  return {
    seen,
    stop: () => {
      sqlite.prepare = prepare
    },
  }
}

describe('what holds an upload, read from the schema as it is now', () => {
  it('sees a column, a foreign key or a text table added after a first count, on the next count', async () => {
    const byColumn = upload('invoice.pdf')
    const byKey = upload('pinned.png')
    const byText = upload('linked.png')
    upload('loose.png')
    expect(unattached.unattachedUploads()).toMatchObject({ count: 4, recent: 0 })

    db.run(sql`alter table attachments add column invoice_id integer`)
    db.run(sql`update attachments set invoice_id = 1 where id = ${byColumn.id}`)
    expect(unattached.unattachedUploads()).toMatchObject({ count: 3 })

    db.run(sql`create table pinned (id integer primary key, file_id integer references attachments(id))`)
    db.run(sql`insert into pinned (file_id) values (${byKey.id})`)
    expect(unattached.unattachedUploads()).toMatchObject({ count: 2 })

    db.run(sql`create table memos (id integer primary key, body varchar(200) not null)`)
    db.run(sql`insert into memos (body) values (${`see ![x](/api/uploads/${byText.id})`})`)
    expect(unattached.unattachedUploads()).toMatchObject({ count: 1 })
    expect((await cleanup.cleanupReport(projectId, { reach: false })).uploads).toMatchObject({ count: 1 })

    // Dropped again: what it held is loose once more.
    db.run(sql`drop table pinned`)
    expect(unattached.unattachedUploads()).toMatchObject({ count: 2 })
  })

  it('reads the schema once per version of it: a count is a few statements', () => {
    unattached.unattachedUploads()
    const { seen, stop } = statements()
    try {
      unattached.unattachedUploads()
    } finally {
      stop()
    }
    // The schema's version, the text scan (one statement for every text column of every table), the
    // uploads held by nothing.
    expect(seen).toHaveLength(3)
    expect(seen[0]).toMatch(/schema_version/)
    expect(seen[1]).toMatch(/union all/)
  })
})
