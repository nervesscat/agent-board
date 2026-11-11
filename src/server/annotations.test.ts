import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-annotations-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let features: typeof import('./features')
let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf
let dbm: typeof import('#/db')
let uploadsDir: string

/** A real 1x1 PNG: what a browser hands over once it has drawn on a picture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

const NOTE = 'the button is cut off'

const DOC = {
  version: 1,
  width: 8,
  height: 8,
  items: [
    {
      id: 'box-1',
      kind: 'rect',
      color: '#e11d48',
      width: 4,
      rect: { x: 1, y: 1, w: 5, h: 4 },
      note: NOTE,
    },
  ],
}

beforeAll(async () => {
  features = await import('./features')
  dbm = await import('#/db')
  uploadsDir = (await import('./config')).uploadsDir
  // As src/routes/api/$.ts serves it: HttpErrors become their JSON answer.
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  callerOf = (await import('./auth')).callerOf
})

async function call(method: string, pathname: string, testActor: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json', 'x-test-actor': testActor }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

/** A multipart upload as the browser's canvas sends it: the flattened picture and its document. */
async function uploadMultipart(name: string, bytes: Buffer, annotations: string, mime = 'image/png') {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name, { type: mime }))
  form.append('annotations', annotations)
  const request = new Request('http://localhost/api/uploads', {
    method: 'POST',
    headers: { accept: 'application/json', 'x-test-actor': 'human:enrique' },
    body: form,
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

async function json<T>(res: Response): Promise<T> {
  expect(res.ok, `answered ${res.status}: ${await res.clone().text()}`).toBe(true)
  return (await res.json()) as T
}

async function mcp(method: string, params: Record<string, unknown>) {
  const request = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-test-actor': 'agent:claude',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const caller = await callerOf(request)
  const res = await handle({ request, actor: caller!.name })
  return (await res.json()) as { result: Record<string, unknown> & { content?: { text: string }[] } }
}

const tool = async (name: string, args: Record<string, unknown>) => {
  const { result } = await mcp('tools/call', { name, arguments: args })
  expect(result.isError, result.content?.[0]?.text).toBeFalsy()
  return JSON.parse(result.content![0]!.text)
}

const attachmentRows = () => dbm.db.select().from(dbm.schema.attachments).all().length
const storedFiles = () => fs.readdirSync(uploadsDir).length

describe('annotations on an attachment', () => {
  let pid: number
  beforeAll(async () => {
    pid = dbm.db.insert(dbm.schema.projects).values({ name: 'pictures' }).returning().get().id
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'api', repoPath: '/r/api', baseBranch: 'main' })
      .run()
  })

  it('keeps the document beside the picture and hands both to an agent', async () => {
    const created = await json<{ id: number; annotations: unknown }>(
      await uploadMultipart('shot.png', PNG, JSON.stringify(DOC)),
    )
    expect(created.annotations).toEqual(DOC)

    // What an agent reads: the file on this machine, and the notes with it.
    const info = await json<{
      url: string
      path: string
      annotations: typeof DOC
      name: string
      mime: string
    }>(await call('GET', `/api/uploads/${created.id}/info`, 'agent:claude'))
    expect(info.url).toBe(`/api/uploads/${created.id}`)
    expect(info.mime).toBe('image/png')
    expect(info.annotations).toEqual(DOC)
    const bytes = fs.readFileSync(info.path)
    expect(bytes.equals(PNG)).toBe(true)
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')

    // The same view feeds the ticket, its posts and the MCP tool.
    const t = features.createTicket(pid, { title: 'a marked picture' }, 'enrique')
    features.attachToTicket(t.id, [created.id], 'enrique')
    expect(features.getTicketFull(t.id).attachments[0]!.annotations).toEqual(DOC)
    const got = await tool('get_attachment', { attachmentId: created.id })
    expect(got.annotations.items[0].note).toBe(NOTE)
    expect(got.path).toBe(info.path)
  })

  it('leaves annotations null for the uploads agents make by path or base64', async () => {
    const created = await json<{ id: number; annotations: unknown }>(
      await call('POST', '/api/uploads', 'agent:claude', {
        name: 'plain.png',
        base64: PNG.toString('base64'),
        mime: 'image/png',
      }),
    )
    expect(created.annotations).toBeNull()
    const info = await json<{ url: string; path: string; annotations: unknown }>(
      await call('GET', `/api/uploads/${created.id}/info`, 'agent:claude'),
    )
    expect(info.url).toBe(`/api/uploads/${created.id}`)
    expect(fs.readFileSync(info.path).equals(PNG)).toBe(true)
    expect(info.annotations).toBeNull()
  })

  it('refuses a malformed document and stores nothing', async () => {
    const rows = attachmentRows()
    const files = storedFiles()

    const notJson = await uploadMultipart('shot.png', PNG, 'not json')
    expect(notJson.status).toBe(400)
    expect(((await notJson.json()) as { error: string }).error).toMatch(/annotations/)

    // JSON, but not the shape the canvas writes: items is not a list.
    const wrong = await uploadMultipart('shot.png', PNG, JSON.stringify({ version: 1, items: 'no' }))
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toMatch(/annotations/)

    expect(attachmentRows()).toBe(rows)
    expect(storedFiles()).toBe(files)
  })

  it('tells agents in the MCP tools what comes with an annotated picture', async () => {
    const { result } = await mcp('tools/list', {})
    const tools = result.tools as { name: string; description: string }[]
    const attachment = tools.find((t) => t.name === 'get_attachment')!
    expect(attachment.description).toMatch(/annotations/)
    expect(attachment.description).toMatch(/notes/)
    expect(tools.find((t) => t.name === 'get_ticket')!.description).toMatch(/annotations/)
    expect(tools.find((t) => t.name === 'list_gallery')!.description).toMatch(/annotations/)
  })

  it('documents the field where the README describes uploads', () => {
    const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8')
    // The attachments section, and the row of the REST table that lists POST /api/uploads.
    expect(readme).toMatch(/## Attaching files[\s\S]*annotations/)
    const row = readme.split('\n').find((line) => line.includes('multipart `file`'))
    expect(row).toContain('`annotations`')
  })
})
