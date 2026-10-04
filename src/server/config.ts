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
}

export const uploadsDir = path.join(config.dataDir, 'uploads')
export const logsDir = path.join(config.dataDir, 'logs')
