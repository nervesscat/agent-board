import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` and make the path absolute (relative to the process cwd). */
export function expandPath(p: string): string {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(p)
}

const env = (key: string, fallback: string) => process.env[key] || fallback

export const config = {
  port: Number(env('PORT', '47100')),
  boardUrl: env('BOARD_URL', 'http://localhost:47100').replace(/\/$/, ''),
  gateUrl: env('GATE_URL', 'http://localhost:47110').replace(/\/$/, ''),
  dataDir: expandPath(env('DATA_DIR', './data')),
  claudeBin: env('CLAUDE_BIN', 'claude'),
  // Where attachment files live: 'local' (data/uploads) or 's3' (MinIO or any S3-compatible store).
  storage: env('STORAGE', 'local') === 's3' ? ('s3' as const) : ('local' as const),
  s3: {
    endpoint: env('S3_ENDPOINT', ''),
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', ''),
    accessKey: env('S3_ACCESS_KEY', ''),
    secretKey: env('S3_SECRET_KEY', ''),
  },
}

export const uploadsDir = path.join(config.dataDir, 'uploads')
// With STORAGE=s3, the local copies agents open (written as files come in, fetched again when gone).
export const cacheDir = path.join(config.dataDir, 'cache')
export const logsDir = path.join(config.dataDir, 'logs')
