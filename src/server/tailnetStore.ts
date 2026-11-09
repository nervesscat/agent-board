import type { Database } from 'better-sqlite3'

import { entranceOfRow, type PublicEntrance, TAILNET_SETTING } from './config'

/**
 * The tailnet entrance Settings saved (config.ts TAILNET_SETTING), read with plain SQL on a better-sqlite3
 * handle: the board reads it through its own database, and `vite dev` reads it per request in its process
 * (devEntrance.ts), so a save reaches both without a restart.
 */
export function savedEntrance(sqlite: Database): PublicEntrance | null {
  const row = sqlite.prepare('select value from settings where key = ?').get(TAILNET_SETTING) as
    | { value: string }
    | undefined
  if (row === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(row.value)
  } catch {
    // Not JSON at all: entranceOfRow takes it as the invalid value it is.
    value = row.value
  }
  return entranceOfRow(value)
}
