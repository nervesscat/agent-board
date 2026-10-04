import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-storage-'))
process.env.DATA_DIR = tmp

let storage: typeof import('./storage')
beforeAll(async () => {
  storage = await import('./storage')
})

const text = async (stream: Readable) => {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString()
}

describe('parseRange', () => {
  it('reads one byte range, open-ended or from the end, and refuses what the file cannot give', () => {
    expect(storage.parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(storage.parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(storage.parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(storage.parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 })
    expect(storage.parseRange('bytes=1000-', 1000)).toBeNull()
    expect(storage.parseRange('bytes=5-1', 1000)).toBeNull()
    expect(storage.parseRange('bytes=0-1,5-9', 1000)).toBeNull()
    expect(storage.parseRange(null, 1000)).toBeNull()
    expect(storage.parseRange('bytes=0-1', 0)).toBeNull()
  })
})

describe('local storage', () => {
  it('writes, reads all or a range, and is its own local copy', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'uploads-'))
    const store = storage.localStore(dir)
    await store.put('a.txt', Buffer.from('hello world'), 'text/plain')
    expect(await text(await store.read('a.txt'))).toBe('hello world')
    expect(await text(await store.read('a.txt', { start: 6, end: 10 }))).toBe('world')
    expect(await store.ensureLocal('a.txt')).toBe(path.join(dir, 'a.txt'))
    await expect(store.read('missing.txt')).rejects.toThrow(/gone/)
  })
})

// Against a real MinIO (or any S3): S3_TEST_ENDPOINT=http://127.0.0.1:47120 with S3_TEST_ACCESS_KEY,
// S3_TEST_SECRET_KEY. Skipped otherwise.
const endpoint = process.env.S3_TEST_ENDPOINT
describe.skipIf(!endpoint)('s3 storage', () => {
  const s3 = {
    endpoint: endpoint ?? '',
    region: 'us-east-1',
    bucket: `agent-board-test-${Date.now()}`,
    accessKey: process.env.S3_TEST_ACCESS_KEY ?? '',
    secretKey: process.env.S3_TEST_SECRET_KEY ?? '',
  }

  it('creates its bucket, writes through to the cache, serves ranges, and fetches evicted copies', async () => {
    const cache = fs.mkdtempSync(path.join(tmp, 'cache-'))
    const store = storage.s3Store(s3, cache)
    await store.put('clip.txt', Buffer.from('0123456789'), 'text/plain')
    // Written through: an agent can open it at once.
    expect(fs.readFileSync(store.localPath('clip.txt'), 'utf8')).toBe('0123456789')
    // From the bucket itself once the copy is gone, whole and in part.
    fs.rmSync(store.localPath('clip.txt'))
    expect(await text(await store.read('clip.txt'))).toBe('0123456789')
    expect(await text(await store.read('clip.txt', { start: 2, end: 4 }))).toBe('234')
    // An agent asking for it brings the copy back.
    const p = await store.ensureLocal('clip.txt')
    expect(fs.readFileSync(p, 'utf8')).toBe('0123456789')
    await expect(store.read('nope.txt')).rejects.toThrow(/gone/)
  })

  it('says the store is unreachable instead of writing to disk', async () => {
    const down = storage.s3Store(
      { ...s3, endpoint: 'http://127.0.0.1:9' },
      fs.mkdtempSync(path.join(tmp, 'c-')),
    )
    await expect(down.put('x.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/unreachable/)
  })
})
