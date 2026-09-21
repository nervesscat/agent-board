import { defineConfig } from 'drizzle-kit'

// Only used by `drizzle-kit generate`; the app applies ./drizzle at boot (src/db/index.ts).
export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: { url: './data/board.db' },
})
