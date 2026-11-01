import { definePlugin } from 'nitro'

import {
  authMode,
  authOffBanner,
  builtServerBind,
  checkBind,
  entranceIgnored,
  readPublicEntrance,
  StartupError,
} from './config'

/**
 * Runs once as the server starts, before it accepts a request: refuses a BOARD_ENV / AUTH it cannot
 * honour safely, a board without sign-in on anything but loopback or on the live board's port, and a
 * PUBLIC_ORIGIN it cannot trust, then says loudly when sign-in is off, and that such a board ignores the
 * entrance. Under `vite dev` Vite owns the address, so vite.config.ts checks it before it listens; this
 * still refuses a bad BOARD_ENV / AUTH or entrance there and prints the banner. There, BOARD_ENV, AUTH and
 * PUBLIC_ORIGIN are in process.env as Vite's loadEnv reads .env (src/server/devEnv.ts), so this, the
 * checks of vite.config.ts and the request guard see one value; the built server reads no .env.
 */
export default definePlugin(() => {
  try {
    const auth = authMode()
    if (!import.meta.env.DEV) checkBind(auth, builtServerBind(process.env))
    const entrance = readPublicEntrance(process.env)
    if (!auth.off) return
    // auth.ts opens the database for the human's name: only once the checks have passed.
    void import('./auth').then(({ offHuman }) => {
      console.error(`\n  ${authOffBanner(auth, offHuman(auth))}\n`)
      if (entrance) console.error(`  ${entranceIgnored(auth)}\n`)
    })
  } catch (err) {
    if (!(err instanceof StartupError)) throw err
    console.error(`agent-board refuses to start: ${err.message}`)
    process.exit(1)
  }
})
