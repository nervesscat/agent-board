import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { uploadsDir } from './config'
import { HttpError, notFound } from './http'

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

function store(name: string, mime: string, bytes: Buffer, actor: string) {
  if (bytes.length > MAX_BYTES) throw new HttpError(413, `file exceeds ${MAX_BYTES / 1024 / 1024} MB`)
  const storedAs = `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`
  fs.writeFileSync(path.join(uploadsDir, storedAs), bytes)
  return db
    .insert(schema.attachments)
    .values({ name: path.basename(name), mime, size: bytes.length, storedAs, uploadedBy: actor })
    .returning()
    .get()
}

export function saveUpload(file: File, actor: string) {
  return file
    .arrayBuffer()
    .then((buf) => store(file.name, file.type || mimeFor(file.name), Buffer.from(buf), actor))
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
export function saveFromPath(given: string, actor: string) {
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

export function attachmentPath(a: schema.Attachment) {
  return path.join(uploadsDir, a.storedAs)
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

/** Bind previously uploaded files to the update or comment that references them. */
export function attachTo(ids: number[], owner: { updateId?: number; commentId?: number; ticketId?: number }) {
  for (const id of ids) {
    const a = getAttachment(id)
    if (a.updateId || a.commentId || a.ticketId)
      throw new HttpError(409, `attachment ${id} is already attached`)
    db.update(schema.attachments).set(owner).where(eq(schema.attachments.id, id)).run()
  }
}
