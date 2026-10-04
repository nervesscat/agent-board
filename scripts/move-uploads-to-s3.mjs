#!/usr/bin/env node
// Copy the attachment files in data/uploads into the bucket STORAGE=s3 uses, under the same keys, so
// switching storage keeps every existing file. Each copy is checked (the object's size against the
// file's) before anything else happens to it; with --delete-local the checked local file is then
// removed. Files already in the bucket at the same size are skipped, so it can run again safely.
//
//   pnpm move-uploads                 # copy, keep the local files
//   pnpm move-uploads --delete-local  # copy, then remove each checked local file
//   pnpm move-uploads --dry-run       # say what would happen
//
// Reads S3_* and DATA_DIR from the environment or .env, like the board.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const deleteLocal = args.has('--delete-local')

function env(key, fallback = '') {
  if (process.env[key]) return process.env[key]
  const line = fs.existsSync('.env')
    ? fs
        .readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .find((l) => l.startsWith(`${key}=`))
    : undefined
  return line?.slice(key.length + 1).trim() || fallback
}

const dataDir = path.resolve(env('DATA_DIR', './data'))
const bucket = env('S3_BUCKET')
if (!bucket) {
  console.error(
    'Set S3_BUCKET (and S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY) first, in .env or the environment.',
  )
  process.exit(1)
}
const client = new S3Client({
  endpoint: env('S3_ENDPOINT') || undefined,
  region: env('S3_REGION', 'us-east-1'),
  forcePathStyle: true,
  credentials: env('S3_ACCESS_KEY')
    ? { accessKeyId: env('S3_ACCESS_KEY'), secretAccessKey: env('S3_SECRET_KEY') }
    : undefined,
})

const sizeInBucket = (key) =>
  client
    .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    .then((o) => o.ContentLength ?? -1)
    .catch((err) => {
      if (err.$metadata?.httpStatusCode === 404) return null
      throw err
    })

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }))
} catch (err) {
  if (err.$metadata?.httpStatusCode !== 404) {
    console.error(`Cannot reach the bucket ${bucket}: ${err.message}`)
    process.exit(1)
  }
  if (!dryRun) await client.send(new CreateBucketCommand({ Bucket: bucket }))
  console.log(`${dryRun ? 'Would create' : 'Created'} the bucket ${bucket}.`)
}

const db = new Database(path.join(dataDir, 'board.db'), { readonly: true })
const rows = db.prepare('select stored_as as key, size, mime from attachments order by id').all()
db.close()

const counts = { copied: 0, alreadyThere: 0, noLocalFile: 0, deleted: 0, failed: 0 }
for (const { key, size, mime } of rows) {
  const file = path.join(dataDir, 'uploads', key)
  if (!fs.existsSync(file)) {
    counts.noLocalFile++
    continue
  }
  try {
    if ((await sizeInBucket(key)) === size) counts.alreadyThere++
    else if (dryRun) counts.copied++
    else {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(file), ContentType: mime }),
      )
      const there = await sizeInBucket(key)
      if (there !== size) throw new Error(`the bucket has ${there} bytes, the file ${size}`)
      counts.copied++
    }
    if (deleteLocal && !dryRun) {
      fs.rmSync(file)
      counts.deleted++
    }
  } catch (err) {
    counts.failed++
    console.error(`${key}: ${err.message}`)
  }
}

const verb = dryRun ? 'would copy' : 'copied'
console.log(
  `${rows.length} attachments: ${counts.copied} ${verb}, ${counts.alreadyThere} already in ${bucket}, ` +
    `${counts.noLocalFile} with no local file, ${counts.failed} failed` +
    (deleteLocal ? `, ${counts.deleted} local files deleted` : '') +
    '.',
)
if (counts.failed) process.exit(1)
