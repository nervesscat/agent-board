import fs from 'node:fs'

import { e2eEnv } from './env'

/** The run's throwaway folder. The board may still hold its database open (Windows): then it stays in tmp. */
export default function globalTeardown() {
  try {
    fs.rmSync(e2eEnv().root, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}
