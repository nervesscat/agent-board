import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from './http'
import { fileStore } from './storage'

const MAX_BYTES = 200 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.log': 'text/plain',
}

export function mimeFor(name: string, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? fallback
}

/** The bytes go to the file store first: if it cannot take them, no attachment row is left behind. */
async function store(name: string, mime: string, bytes: Buffer, actor: string) {
  if (bytes.length > MAX_BYTES) throw new HttpError(413, `file exceeds ${MAX_BYTES / 1024 / 1024} MB`)
  const storedAs = `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`
  await fileStore.put(storedAs, bytes, mime)
  return db
    .insert(schema.attachments)
    .values({ name: path.basename(name), mime, size: bytes.length, storedAs, uploadedBy: actor })
    .returning()
    .get()
}

export async function saveUpload(file: File, actor: string) {
  return store(file.name, file.type || mimeFor(file.name), Buffer.from(await file.arrayBuffer()), actor)
}

/**
 * An agent on Windows hands over `C:\…` paths; a board running inside WSL reads that file at
 * `/mnt/c/…`. Other paths pass through unchanged.
 */
export function localPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p)
  if (platform === 'win32' || !m) return p
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`
}

/** Agents run on this machine, so they can hand over a path instead of streaming the bytes. */
export async function saveFromPath(given: string, actor: string) {
  const filePath = localPath(given)
  if (!path.isAbsolute(filePath)) throw new HttpError(400, 'path must be absolute')
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
    throw new HttpError(400, `${filePath} is not a file`)
  return store(filePath, mimeFor(filePath), fs.readFileSync(filePath), actor)
}

export function saveBase64(name: string, data: string, actor: string, mime?: string) {
  return store(name, mime || mimeFor(name), Buffer.from(data, 'base64'), actor)
}

export function getAttachment(id: number) {
  const a = db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()
  if (!a) throw notFound('attachment')
  return a
}

/** Where the file is on this machine (with STORAGE=s3, its cached copy: see ensureLocalFiles). */
export function attachmentPath(a: schema.Attachment) {
  return fileStore.localPath(a.storedAs)
}

export const attachmentUrl = (a: Pick<schema.Attachment, 'id'>) => `/api/uploads/${a.id}`

/**
 * An attachment as the board hands it out: the URL for the browser and the file on this machine for
 * agents, which cannot fetch the URL without the gate. A board inside WSL also gives the path a
 * Windows agent can open.
 */
export function attachmentView(a: schema.Attachment, distro = process.env.WSL_DISTRO_NAME) {
  const file = attachmentPath(a)
  return {
    ...a,
    url: attachmentUrl(a),
    path: file,
    ...(distro ? { windowsPath: `\\\\wsl.localhost\\${distro}${file.replace(/\//g, '\\')}` } : {}),
  }
}

/**
 * Make sure every attachment found in `value` (anything with `storedAs` and `path`, at any depth) is a
 * file on this machine before an agent is handed its path. A no-op for local storage; with s3 it
 * fetches the copies the cache no longer has.
 */
export async function ensureLocalFiles<T>(value: T): Promise<T> {
  if (fileStore.kind === 'local') return value
  const keys = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.storedAs === 'string' && typeof o.path === 'string') keys.add(o.storedAs)
    Object.values(o).forEach(walk)
  }
  walk(value)
  await Promise.all([...keys].map((k) => fileStore.ensureLocal(k)))
  return value
}

/** Throws unless every one of `ids` is an upload not yet bound to anything. */
export function assertUnattached(ids: number[]) {
  for (const id of ids) {
    const a = getAttachment(id)
    if (a.updateId || a.commentId || a.ticketId)
      throw new HttpError(409, `attachment ${id} is already attached`)
  }
}

/** Bind previously uploaded files to the update or comment that references them. */
export function attachTo(ids: number[], owner: { updateId?: number; commentId?: number; ticketId?: number }) {
  assertUnattached(ids)
  for (const id of ids) db.update(schema.attachments).set(owner).where(eq(schema.attachments.id, id)).run()
}
