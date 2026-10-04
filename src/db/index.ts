import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { config, logsDir, uploadsDir } from '#/server/config'
import * as schema from './schema'

for (const dir of [config.dataDir, uploadsDir, logsDir]) fs.mkdirSync(dir, { recursive: true })

const sqlite = new Database(path.join(config.dataDir, 'board.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

// Migrations are committed in ./drizzle (drizzle-kit generate); applying them at boot keeps `pnpm dev` zero-setup.
migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })

export { schema }
