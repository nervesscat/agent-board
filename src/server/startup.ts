import { definePlugin } from 'nitro'

import { authMode, authOffBanner, builtServerBind, checkBind, StartupError } from './config'

/**
 * Runs once as the server starts, before it accepts a request: refuses a BOARD_ENV / AUTH it cannot
 * honour safely, and a gate-off board on anything but loopback or on the live board's port, then
 * says loudly when the gate is off. Under `vite dev` Vite owns the address, so vite.config.ts checks
 * it before it listens; this still refuses a bad BOARD_ENV / AUTH there and prints the banner.
 */
export default definePlugin(() => {
  try {
    const auth = authMode()
    if (!import.meta.env.DEV) checkBind(auth, builtServerBind(process.env))
    if (!auth.off) return
    // auth.ts opens the database for the human's name: only once the checks have passed.
    void import('./auth').then(({ offHuman }) =>
      console.error(`\n  ${authOffBanner(auth, offHuman(auth))}\n`),
    )
  } catch (err) {
    if (!(err instanceof StartupError)) throw err
    console.error(`agent-board refuses to start: ${err.message}`)
    process.exit(1)
  }
})
