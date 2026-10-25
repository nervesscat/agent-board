import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import type { CommentParent } from '#/lib/constants'
import { FILE_KINDS, type FileKind, GALLERY_SORTS, type GallerySort, fileKind } from '#/lib/fileKinds'
import { parseAnchor } from '#/lib/reveal'
import type { GalleryQuery } from './gallery'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-gallery-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let gallery: typeof import('./gallery')
let unattached: typeof import('./unattached')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  gallery = await import('./gallery')
  unattached = await import('./unattached')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

const db = () => dbm.db
const s = () => dbm.schema

const newProject = (name: string) => db().insert(s().projects).values({ name }).returning().get().id
const newTicket = (projectId: number, title: string, more: { parentId?: number; status?: string } = {}) =>
  db()
    .insert(s().tickets)
    .values({ projectId, title, createdBy: 'claude', ...more })
    .returning()
    .get()
const newPost = (ticketId: number) =>
  db().insert(s().updates).values({ ticketId, author: 'claude', body: 'a post' }).returning().get().id
// 'pr' is no longer a comment parent, but the replies made on PRs before stay in the database.
const newComment = (parentType: CommentParent | 'pr', parentId: number) =>
  db()
    .insert(s().comments)
    .values({ parentType: parentType as CommentParent, parentId, author: 'claude', body: 'a reply' })
    .returning()
    .get().id

type Owner = { updateId?: number; commentId?: number; ticketId?: number; reportId?: number }
/** An upload's row (the gallery reads only rows), held by `owner`, made at `createdAt`. */
function file(name: string, owner: Owner = {}, more: { mime?: string; createdAt?: string } = {}) {
  return db()
    .insert(s().attachments)
    .values({
      name,
      mime: more.mime ?? 'image/png',
      size: 2048,
      storedAs: `${name}-${Math.random().toString(36).slice(2)}`,
      uploadedBy: 'claude',
      ...owner,
      ...(more.createdAt ? { createdAt: more.createdAt } : {}),
    })
    .returning()
    .get().id
}

const ids = (g: { items: { id: number }[] }) => g.items.map((i) => i.id)

async function call(pathname: string, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      headers: as === 'agent' ? { authorization: 'Bearer token-of-test' } : {},
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    'claude',
  )
  const { result } = (await res.json()) as { result: any }
  return result as { isError?: boolean; content: { text: string }[] }
}

describe('which files the gallery lists', () => {
  it("lists the files of the project's posts, replies under posts and instructions, lanes' included, and nothing else", () => {
    const p = newProject('which files')
    const other = newProject('another project')
    const t = newTicket(p, 'A ticket')
    const lane = newTicket(p, 'A lane', { parentId: t.id })
    const subLane = newTicket(p, 'A lane of the lane', { parentId: lane.id })
    const post = newPost(t.id)
    const lanePost = newPost(lane.id)

    const included = [
      file('post.png', { updateId: post }),
      file('reply.png', { commentId: newComment('update', post) }),
      file('instructions.png', { ticketId: t.id }),
      file('lane-post.png', { updateId: lanePost }),
      file('lane-reply.png', { commentId: newComment('update', lanePost) }),
      file('sub-lane-instructions.png', { ticketId: subLane.id }),
    ]
    // Another project's post, a report's file, an agent's picture, replies on a PR and on a review
    // result, and an upload nothing holds.
    file('elsewhere.png', { updateId: newPost(newTicket(other, 'Elsewhere').id) })
    const report = db()
      .insert(s().reports)
      .values({ projectId: p, cadence: 'daily', period: '2026-10-01', author: 'claude' })
      .returning()
      .get().id
    file('report.pdf', { reportId: report }, { mime: 'application/pdf' })
    const avatar = file('avatar.png')
    db()
      .insert(s().agents)
      .values({ projectId: p, name: 'builder', avatarId: avatar, createdBy: 'enrique' })
      .run()
    file('pr-reply.png', { commentId: newComment('pr', 1) })
    file('review-reply.png', { commentId: newComment('review', 1) })
    file('unattached.png')

    const g = gallery.listGallery(p)
    expect(ids(g).sort((x, y) => x - y)).toEqual(included)
    expect(g.next).toBeNull()

    const byName = Object.fromEntries(g.items.map((i) => [i.name, i]))
    // A lane's files are under its top-level ticket, however deep the lane, with the lane as context.
    expect(byName['post.png']).toMatchObject({ ticket: { id: t.id, title: 'A ticket' }, lane: null })
    expect(byName['lane-post.png']).toMatchObject({
      ticket: { id: t.id, title: 'A ticket' },
      lane: { id: lane.id, title: 'A lane' },
      source: { kind: 'post', postId: lanePost },
      anchor: `post-${lanePost}`,
    })
    expect(byName['lane-reply.png']).toMatchObject({
      ticket: { id: t.id, title: 'A ticket' },
      lane: { id: lane.id, title: 'A lane' },
      source: { kind: 'reply', postId: lanePost },
    })
    expect(byName['sub-lane-instructions.png']).toMatchObject({
      ticket: { id: t.id, title: 'A ticket' },
      lane: { id: subLane.id, title: 'A lane of the lane' },
      source: { kind: 'instructions' },
      anchor: null,
    })
    expect(byName['post.png']!.ticket).toEqual({ id: t.id, title: 'A ticket' })
    expect(byName['post.png']!.source).toEqual({ kind: 'post', postId: post })
    expect(byName['post.png']!.anchor).toBe(`post-${post}`)
    const r = byName['reply.png']!
    expect(r.source).toMatchObject({ kind: 'reply', postId: post })
    expect(r.anchor).toBe(`post-${post}-reply-${(r.source as { commentId: number }).commentId}`)
    // The ticket page reads it as the reply in the post's thread.
    expect(parseAnchor(r.anchor!)).toMatchObject({ holder: `post-${post}`, target: `reply-${r.commentId}` })
    expect(byName['instructions.png']!.source).toEqual({ kind: 'instructions' })
    expect(byName['instructions.png']!.anchor).toBeNull()
  })

  it("leaves out the files of a PR's own ticket, which is the PR's discussion", async () => {
    const p = newProject('pr tickets')
    const now = new Date().toISOString()
    const pr = db()
      .insert(s().prs)
      .values({
        projectId: p,
        number: 7,
        title: 'seven',
        url: 'https://github.com/acme/app/pull/7',
        author: 'ana',
        headRef: 'feat/seven',
        baseRef: 'main',
        headSha: 'abc1234',
        updatedAt: now,
        fetchedAt: now,
      })
      .returning()
      .get().id
    const prTicket = db()
      .insert(s().tickets)
      .values({ projectId: p, title: 'PR #7', createdBy: 'claude', prId: pr, prNumber: 7 })
      .returning()
      .get()
    const prPost = newPost(prTicket.id)
    file('pr-post.png', { updateId: prPost })
    file('pr-reply.png', { commentId: newComment('update', prPost) })
    file('pr-instructions.png', { ticketId: prTicket.id })
    const kept = file('ticket.png', { updateId: newPost(newTicket(p, 'A ticket').id) })

    expect(ids(gallery.listGallery(p))).toEqual([kept])
    expect(ids(gallery.listGallery(p, { archived: 'include' }))).toEqual([kept])
    const rest = await call(`/api/projects/${p}/gallery`)
    expect(rest.body.items.map((i: { id: number }) => i.id)).toEqual([kept])
  })

  it('hides the files of archived tickets unless asked, and shows those of cancelled ones', () => {
    const p = newProject('archived')
    const archived = newTicket(p, 'Archived', { status: 'done' })
    db()
      .update(s().tickets)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(s().tickets.id, archived.id))
      .run()
    const cancelled = newTicket(p, 'Cancelled', { status: 'cancelled' })
    const a = file('archived.png', { updateId: newPost(archived.id) })
    const c = file('cancelled.png', { updateId: newPost(cancelled.id) })
    expect(ids(gallery.listGallery(p))).toEqual([c])
    expect(ids(gallery.listGallery(p, { archived: 'include' }))).toEqual([c, a])
  })

  it('browsing it changes nothing the unattached sweep would delete', () => {
    const p = newProject('read only')
    file('held.png', { updateId: newPost(newTicket(p, 'T').id) })
    file('loose.png', {}, { createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })
    const before = unattached.unattachedUploads()
    gallery.listGallery(p)
    gallery.listGallery(p, { archived: 'include', type: ['image'] })
    expect(unattached.unattachedUploads()).toEqual(before)
  })
})

describe('filters, order and pages', () => {
  it('filters by kind on the server, several at once, as fileKind classifies', () => {
    const p = newProject('kinds')
    const post = newPost(newTicket(p, 'T').id)
    const files: [string, string, FileKind][] = [
      ['shot.png', 'image/png', 'image'],
      ['clip.webm', 'video/webm', 'video'],
      ['spec.pdf', 'application/pdf', 'pdf'],
      ['notes.md', 'application/octet-stream', 'docs'],
      ['run.LOG', '', 'docs'],
      ['data.json', 'application/json', 'docs'],
      ['main.mts', 'application/octet-stream', 'docs'],
      ['plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docs'],
      ['sheet.xlsx', 'application/octet-stream', 'docs'],
      ['legacy.doc', 'application/msword', 'docs'],
      ['bundle.zip', 'application/zip', 'other'],
      ['blob.bin', 'application/octet-stream', 'other'],
      ['song.mp3', 'audio/mpeg', 'other'],
      ['IMAGE/PNG upper', 'IMAGE/PNG', 'other'],
    ]
    const byId = new Map(files.map(([name, mime, kind]) => [file(name, { updateId: post }, { mime }), kind]))
    for (const [name, mime, kind] of files) expect(fileKind({ name, mime }), name).toBe(kind)

    // The kind SQL gives each file is the one fileKind gives it.
    for (const item of gallery.listGallery(p).items) expect(item.kind, item.name).toBe(byId.get(item.id))

    const some = gallery.listGallery(p, { type: ['image', 'pdf'] })
    expect(some.items.map((i) => i.name).sort()).toEqual(['shot.png', 'spec.pdf'])
    for (const kind of ['video', 'docs', 'other'] as const)
      expect(ids(gallery.listGallery(p, { type: [kind] })).sort()).toEqual(
        [...byId]
          .filter(([, k]) => k === kind)
          .map(([id]) => id)
          .sort(),
      )
  })

  it('filters by upload day, local days inclusive, either end open', () => {
    const p = newProject('days')
    const post = newPost(newTicket(p, 'T').id)
    // Midday local time on each day, as UTC like the rows keep it.
    const at = (day: string) => new Date(`${day}T12:00:00`).toISOString()
    const before = file('before.png', { updateId: post }, { createdAt: at('2026-09-08') })
    const on = file('on.png', { updateId: post }, { createdAt: at('2026-09-10') })
    // The day's very first and last moments count as that day.
    const start = file(
      'start.png',
      { updateId: post },
      { createdAt: new Date('2026-09-10T00:00:00').toISOString() },
    )
    const end = file(
      'end.png',
      { updateId: post },
      {
        createdAt: new Date(new Date('2026-09-11T00:00:00').getTime() - 1).toISOString(),
      },
    )
    const after = file('after.png', { updateId: post }, { createdAt: at('2026-09-12') })

    expect(ids(gallery.listGallery(p, { from: '2026-09-10', to: '2026-09-10' }))).toEqual([end, on, start])
    expect(ids(gallery.listGallery(p, { from: '2026-09-10' }))).toEqual([after, end, on, start])
    expect(ids(gallery.listGallery(p, { to: '2026-09-10' }))).toEqual([end, on, start, before])
    expect(ids(gallery.listGallery(p, { from: '2026-09-11', to: '2026-09-11' }))).toEqual([])
  })

  it('takes the first and last days the calendar check accepts as bounds that hold every file', async () => {
    const p = newProject('far days')
    const post = newPost(newTicket(p, 'T').id)
    const one = file(
      'one.png',
      { updateId: post },
      { createdAt: new Date('2026-09-10T12:00:00').toISOString() },
    )
    // West of UTC the end of 9999-12-31 is in year 10000, written +010000-…, which compared as a string
    // falls before every stored time; east of UTC the start of 0000-01-01 is in year -1.
    for (const q of [
      { to: '9999-12-31' },
      { from: '0000-01-01' },
      { from: '0000-01-01', to: '9999-12-31' },
    ]) {
      expect(ids(gallery.listGallery(p, q)), JSON.stringify(q)).toEqual([one])
    }
    expect(ids(gallery.listGallery(p, { from: '9999-12-31', to: '9999-12-31' }))).toEqual([])
    expect(ids(gallery.listGallery(p, { from: '0000-01-01', to: '0000-01-01' }))).toEqual([])
    const rest = await call(`/api/projects/${p}/gallery?to=9999-12-31`)
    expect(rest.status).toBe(200)
    expect(rest.body.items.map((i: { id: number }) => i.id)).toEqual([one])
  })

  it('lists newest first, ties by id, and oldest first with sort: oldest', () => {
    const p = newProject('order')
    const post = newPost(newTicket(p, 'T').id)
    const same = '2026-08-01T10:00:00.000Z'
    const a = file('a.png', { updateId: post }, { createdAt: '2026-08-01T09:00:00.000Z' })
    const b = file('b.png', { updateId: post }, { createdAt: same })
    const c = file('c.png', { updateId: post }, { createdAt: same })
    const d = file('d.png', { updateId: post }, { createdAt: '2026-08-02T09:00:00.000Z' })
    expect(ids(gallery.listGallery(p))).toEqual([d, c, b, a])
    expect(ids(gallery.listGallery(p, { sort: 'oldest' }))).toEqual([a, b, c, d])
  })

  it('pages with a cursor: every file once, even with files arriving between pages, both ways', () => {
    const p = newProject('pages')
    const post = newPost(newTicket(p, 'T').id)
    const base = Date.parse('2026-07-01T00:00:00.000Z')
    // Pairs share a time, so a page can end between two files of the same moment.
    const all = Array.from({ length: 11 }, (_, i) =>
      file(
        `f${i}.png`,
        { updateId: post },
        { createdAt: new Date(base + Math.floor(i / 2) * 1000).toISOString() },
      ),
    )

    let late = 0
    for (const sort of ['newest', 'oldest'] as const) {
      const seen: number[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = gallery.listGallery(p, { sort, limit: 3, cursor })
        expect(page.items.length).toBeLessThanOrEqual(3)
        seen.push(...ids(page))
        cursor = page.next ?? undefined
        pages++
        // A file arriving now is newer than every one listed: it moves nothing on the pages to come.
        if (pages === 1 && sort === 'newest') late = file('late.png', { updateId: post })
      } while (cursor)
      expect(pages).toBe(4)
      // Oldest first, it comes last.
      expect(seen).toEqual(sort === 'newest' ? [...all].reverse() : [...all, late])
    }
  })

  describe('every order', () => {
    // Names equal but for case, sizes and kinds shared, times shared: each order has ties to break.
    const specs: [string, string, number, string][] = [
      ['b.png', 'image/png', 300, '2026-03-01T10:00:00.000Z'],
      ['B.png', 'image/png', 100, '2026-03-01T10:00:00.000Z'],
      ['a.pdf', 'application/pdf', 300, '2026-03-02T10:00:00.000Z'],
      ['A.pdf', 'application/pdf', 200, '2026-03-02T10:00:00.000Z'],
      ['c.md', 'text/markdown', 100, '2026-03-03T10:00:00.000Z'],
      ['clip.webm', 'video/webm', 300, '2026-03-01T10:00:00.000Z'],
      ['zeta.zip', 'application/zip', 200, '2026-03-04T10:00:00.000Z'],
      ['b.png', 'image/png', 200, '2026-03-05T10:00:00.000Z'],
      ['Alpha.png', 'image/png', 100, '2026-03-05T10:00:00.000Z'],
    ]
    type Made = { id: number; name: string; size: number; createdAt: string; kind: FileKind }
    let p = 0
    let made: Made[] = []
    beforeAll(() => {
      p = newProject('every order')
      const post = newPost(newTicket(p, 'T').id)
      made = specs.map(([name, mime, size, createdAt]) => {
        const id = db()
          .insert(s().attachments)
          .values({
            name,
            mime,
            size,
            createdAt,
            storedAs: `${name}-${size}`,
            uploadedBy: 'claude',
            updateId: post,
          })
          .returning()
          .get().id
        return { id, name, size, createdAt, kind: fileKind({ name, mime }) }
      })
    })

    const by =
      <T extends string | number>(key: (m: Made) => T, descending = false) =>
      (x: Made, y: Made) => {
        const kx = key(x)
        const ky = key(y)
        const c = kx < ky ? -1 : kx > ky ? 1 : x.id - y.id
        return descending ? -c : c
      }
    const rank = (k: FileKind) => FILE_KINDS.indexOf(k)
    const expected: Record<GallerySort, (x: Made, y: Made) => number> = {
      newest: by((m) => m.createdAt, true),
      oldest: by((m) => m.createdAt),
      name: by((m) => m.name.toLowerCase()),
      'name-desc': by((m) => m.name.toLowerCase(), true),
      largest: by((m) => m.size, true),
      smallest: by((m) => m.size),
      type: (x, y) => rank(x.kind) - rank(y.kind) || by((m) => m.name.toLowerCase())(x, y),
    }

    const walk = (q: Omit<GalleryQuery, 'cursor'>) => {
      const seen: number[] = []
      let cursor: string | undefined
      do {
        const page = gallery.listGallery(p, { ...q, limit: 2, cursor })
        expect(page.items.length).toBeLessThanOrEqual(2)
        seen.push(...ids(page))
        cursor = page.next ?? undefined
      } while (cursor)
      return seen
    }

    it.each(GALLERY_SORTS)('sorts by %s and pages through every file once, two at a time', (sort) => {
      const want = [...made].sort(expected[sort]).map((m) => m.id)
      expect(ids(gallery.listGallery(p, { sort }))).toEqual(want)
      expect(walk({ sort })).toEqual(want)
    })

    it.each(GALLERY_SORTS)('pages by %s under a kind filter', (sort) => {
      const want = [...made]
        .filter((m) => m.kind === 'image' || m.kind === 'pdf')
        .sort(expected[sort])
        .map((m) => m.id)
      expect(walk({ sort, type: ['image', 'pdf'] })).toEqual(want)
    })

    it('names order ignores case, and by type is by kind, then name', () => {
      const names = (sort: GallerySort) => gallery.listGallery(p, { sort }).items.map((i) => i.name)
      expect(names('name').slice(0, 4)).toEqual(['a.pdf', 'A.pdf', 'Alpha.png', 'b.png'])
      expect(gallery.listGallery(p, { sort: 'type' }).items.map((i) => i.kind)).toEqual([
        'image',
        'image',
        'image',
        'image',
        'video',
        'pdf',
        'pdf',
        'docs',
        'other',
      ])
      expect(names('type').slice(0, 4)).toEqual(['Alpha.png', 'b.png', 'B.png', 'b.png'])
    })

    it('refuses a cursor handed out by another order, so paging on never skips or repeats', () => {
      const first = gallery.listGallery(p, { sort: 'name', limit: 2 })
      for (const sort of GALLERY_SORTS.filter((s) => s !== 'name'))
        expect(() => gallery.listGallery(p, { sort, limit: 2, cursor: first.next! }), sort).toThrow(/cursor/)
      // A cursor from before the orders, [createdAt, id], is not one either.
      const old = Buffer.from(JSON.stringify(['2026-03-01T10:00:00.000Z', made[0]!.id])).toString('base64url')
      expect(() => gallery.listGallery(p, { cursor: old })).toThrow(/cursor/)
    })
  })

  it('pages stay right under a kind filter', () => {
    const p = newProject('filtered pages')
    const post = newPost(newTicket(p, 'T').id)
    const pdfs: number[] = []
    for (let i = 0; i < 9; i++) {
      const pdf = i % 3 === 0
      const id = file(
        pdf ? `d${i}.pdf` : `i${i}.png`,
        { updateId: post },
        {
          mime: pdf ? 'application/pdf' : 'image/png',
          createdAt: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 1000).toISOString(),
        },
      )
      if (pdf) pdfs.push(id)
    }
    const first = gallery.listGallery(p, { type: ['pdf'], limit: 2 })
    expect(ids(first)).toEqual([pdfs[2], pdfs[1]])
    const second = gallery.listGallery(p, { type: ['pdf'], limit: 2, cursor: first.next! })
    expect(ids(second)).toEqual([pdfs[0]])
    expect(second.next).toBeNull()
  })
})

describe('the gallery over REST and MCP', () => {
  it('answers agents with every field, the same as list_gallery, and 404 for an unknown project', async () => {
    const p = newProject('rest')
    const t = newTicket(p, 'Over REST')
    const post = newPost(t.id)
    const png = file('rest.png', { updateId: post })
    file('rest.pdf', { updateId: post }, { mime: 'application/pdf' })

    const res = await call(`/api/projects/${p}/gallery?type=image&limit=5`, 'agent')
    expect(res.status).toBe(200)
    expect(res.body.next).toBeNull()
    expect(res.body.items).toHaveLength(1)
    const item = res.body.items[0]
    expect(item).toMatchObject({
      id: png,
      name: 'rest.png',
      mime: 'image/png',
      kind: 'image',
      size: 2048,
      uploadedBy: 'claude',
      url: `/api/uploads/${png}`,
      ticket: { id: t.id, title: 'Over REST' },
      lane: null,
      source: { kind: 'post', postId: post },
      anchor: `post-${post}`,
    })
    expect(item.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(path.isAbsolute(item.path)).toBe(true)

    const listed = await tool('list_gallery', { projectId: p, type: ['image'], limit: 5 })
    expect(listed.isError).toBeFalsy()
    expect(JSON.parse(listed.content[0]!.text)).toEqual(res.body)
    // The human's browser gets the same list.
    expect((await call(`/api/projects/${p}/gallery?type=image&limit=5`)).body).toEqual(res.body)

    expect((await call('/api/projects/99999/gallery')).status).toBe(404)
    expect((await tool('list_gallery', { projectId: 99999 })).isError).toBe(true)
  })

  it('pages over REST and refuses filters it does not know', async () => {
    const p = newProject('rest pages')
    const post = newPost(newTicket(p, 'T').id)
    const made = [1, 2, 3].map((i) =>
      file(`p${i}.png`, { updateId: post }, { createdAt: `2026-05-0${i}T10:00:00.000Z` }),
    )
    const first = await call(`/api/projects/${p}/gallery?limit=2&sort=oldest`)
    expect(first.body.items.map((i: { id: number }) => i.id)).toEqual(made.slice(0, 2))
    const second = await call(`/api/projects/${p}/gallery?limit=2&sort=oldest&cursor=${first.body.next}`)
    expect(second.body.items.map((i: { id: number }) => i.id)).toEqual(made.slice(2))
    expect(second.body.next).toBeNull()

    // Every order over REST, the same as list_gallery, page for page.
    file('A-big.png', { updateId: post }, { createdAt: '2026-05-04T10:00:00.000Z' })
    for (const sort of GALLERY_SORTS) {
      let cursor = ''
      const seen: string[] = []
      do {
        const rest = await call(
          `/api/projects/${p}/gallery?limit=2&sort=${sort}${cursor && `&cursor=${cursor}`}`,
        )
        expect(rest.status, sort).toBe(200)
        const listed = await tool('list_gallery', {
          projectId: p,
          sort,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        })
        expect(JSON.parse(listed.content[0]!.text), sort).toEqual(rest.body)
        seen.push(...rest.body.items.map((i: { name: string }) => i.name))
        cursor = rest.body.next ?? ''
      } while (cursor)
      expect(seen, sort).toEqual(gallery.listGallery(p, { sort }).items.map((i) => i.name))
    }
    expect(
      (await call(`/api/projects/${p}/gallery?limit=2&sort=name`)).body.items.map(
        (i: { name: string }) => i.name,
      ),
    ).toEqual(['A-big.png', 'p1.png'])
    // A cursor is good for the order that handed it out only.
    const byName = await call(`/api/projects/${p}/gallery?limit=2&sort=name`)
    const reused = await call(`/api/projects/${p}/gallery?limit=2&sort=largest&cursor=${byName.body.next}`)
    expect(reused.status).toBe(400)
    expect(reused.body.error).toMatch(/cursor/)
    expect((await tool('list_gallery', { projectId: p, sort: 'sideways' })).isError).toBe(true)

    for (const bad of [
      'type=bogus',
      'from=2026-13-45',
      'from=yesterday',
      'sort=sideways',
      'limit=0',
      'limit=201',
      'cursor=nope',
    ])
      expect((await call(`/api/projects/${p}/gallery?${bad}`)).status, bad).toBe(400)
  })

  it('refuses days the calendar does not have instead of rolling them into the next month', async () => {
    const p = newProject('impossible days')
    const post = newPost(newTicket(p, 'T').id)
    file('april.png', { updateId: post }, { createdAt: new Date('2026-04-30T12:00:00').toISOString() })
    file('may.png', { updateId: post }, { createdAt: new Date('2026-05-01T12:00:00').toISOString() })

    for (const bad of [
      'to=2026-02-30',
      'from=2026-04-01&to=2026-04-31',
      'from=2026-04-31',
      'to=2027-02-29',
    ]) {
      expect((await call(`/api/projects/${p}/gallery?${bad}`)).status, bad).toBe(400)
    }
    for (const bad of ['2026-02-30', '2026-04-31']) {
      expect(gallery.GalleryQuery.safeParse({ from: bad }).success, bad).toBe(false)
      expect(gallery.GalleryQuery.safeParse({ to: bad }).success, bad).toBe(false)
      expect((await tool('list_gallery', { projectId: p, to: bad })).isError, bad).toBe(true)
    }

    for (const good of ['2026-02-28', '2028-02-29', '2026-04-30']) {
      expect(gallery.GalleryQuery.safeParse({ from: good, to: good }).success, good).toBe(true)
      expect((await call(`/api/projects/${p}/gallery?from=${good}&to=${good}`)).status, good).toBe(200)
      expect((await tool('list_gallery', { projectId: p, from: good, to: good })).isError, good).toBeFalsy()
    }
    const april = await call(`/api/projects/${p}/gallery?from=2026-04-01&to=2026-04-30`)
    expect(april.body.items.map((i: { name: string }) => i.name)).toEqual(['april.png'])
  })
})
