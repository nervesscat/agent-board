import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { cacheDir, config, uploadsDir } from './config'
import { HttpError } from './http'

/**
 * Where attachment bytes live: this machine's data/uploads (the default), or an S3-compatible bucket
 * such as MinIO (STORAGE=s3). Either way an agent gets a file on this machine to open: with s3 a
 * copy is kept in data/cache, written as files come in and fetched again when it has gone.
 */
export interface FileStore {
  kind: 'local' | 's3'
  put(key: string, bytes: Buffer, mime: string): Promise<void>
  /** The bytes for the browser: all of them, or the inclusive range asked for. */
  read(key: string, range?: ByteRange): Promise<Readable>
  /** Where the file is (or will be, see ensureLocal) on this machine. */
  localPath(key: string): string
  /** The file on this machine, fetched first if it is not there. */
  ensureLocal(key: string): Promise<string>
}

export type ByteRange = { start: number; end: number }

/**
 * The single range of a `Range: bytes=…` header within a file of `size` bytes; null for none, one the
 * file cannot satisfy, or several ranges (served whole instead).
 */
export function parseRange(header: string | null, size: number): ByteRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!m || (!m[1] && !m[2]) || size === 0) return null
  let start: number
  let end: number
  if (!m[1]) {
    // bytes=-500: the last 500 bytes
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  return start <= end && start < size ? { start, end } : null
}

export function localStore(dir = uploadsDir): FileStore {
  const file = (key: string) => path.join(dir, key)
  return {
    kind: 'local',
    put: async (key, bytes) => fs.writeFileSync(file(key), bytes),
    read: async (key, range) => {
      if (!fs.existsSync(file(key))) throw new HttpError(404, 'file is gone')
      return fs.createReadStream(file(key), range)
    },
    localPath: file,
    ensureLocal: async (key) => file(key),
  }
}

const CACHE_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

export function s3Store(s3: typeof config.s3 = config.s3, cache = cacheDir): FileStore {
  const { endpoint, region, bucket, accessKey, secretKey } = s3
  if (!bucket) throw new Error('STORAGE=s3 needs S3_BUCKET')
  const client = new S3Client({
    endpoint: endpoint || undefined,
    region,
    // MinIO and most self-hosted stores want bucket/key paths, not bucket subdomains.
    forcePathStyle: true,
    credentials: accessKey ? { accessKeyId: accessKey, secretAccessKey: secretKey } : undefined,
  })
  const cached = (key: string) => path.join(cache, key)
  const unreachable = (err: unknown) =>
    new HttpError(
      503,
      `file storage unreachable (${endpoint || 's3'}): ${err instanceof Error ? err.message : err}`,
    )

  let bucketReady: Promise<void> | null = null
  const ensureBucket = () =>
    (bucketReady ??= client
      .send(new HeadBucketCommand({ Bucket: bucket }))
      .then(() => undefined)
      .catch(async (err: { $metadata?: { httpStatusCode?: number } }) => {
        if (err.$metadata?.httpStatusCode !== 404) throw err
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      })
      .catch((err) => {
        bucketReady = null
        throw unreachable(err)
      }))

  // Files nobody opened for CACHE_DAYS leave the cache; the bucket still has them. At most hourly.
  let prunedAt = 0
  const prune = () => {
    if (Date.now() - prunedAt < 60 * 60 * 1000) return
    prunedAt = Date.now()
    for (const name of fs.readdirSync(cache)) {
      const p = path.join(cache, name)
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > CACHE_DAYS * DAY) fs.rmSync(p)
      } catch {
        // gone already, or in use: next time
      }
    }
  }

  const get = async (key: string, range?: ByteRange) => {
    try {
      const out = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      )
      return out.Body as Readable
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') throw new HttpError(404, 'file is gone')
      throw unreachable(err)
    }
  }

  return {
    kind: 's3',
    put: async (key, bytes, mime) => {
      await ensureBucket()
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }))
      } catch (err) {
        throw unreachable(err)
      }
      // Written through to the cache, so the agent that just attached it can open it at once.
      fs.writeFileSync(cached(key), bytes)
      prune()
    },
    read: async (key, range) => {
      // A cached copy is served from disk: no round trip, and it works while the store is down.
      if (fs.existsSync(cached(key))) return fs.createReadStream(cached(key), range)
      return get(key, range)
    },
    localPath: cached,
    ensureLocal: async (key) => {
      const p = cached(key)
      if (fs.existsSync(p)) {
        const now = new Date()
        fs.utimesSync(p, now, now)
        return p
      }
      const body = await get(key)
      const part = `${p}.part`
      await new Promise<void>((resolve, reject) =>
        body.pipe(fs.createWriteStream(part)).on('finish', resolve).on('error', reject),
      )
      fs.renameSync(part, p)
      return p
    },
  }
}

export const fileStore: FileStore = config.storage === 's3' ? s3Store() : localStore()
