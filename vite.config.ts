import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

import {
  checkBind,
  readAuthMode,
  readPublicEntrance,
  readServedEntrance,
  StartupError,
} from './src/server/config.ts'
import { endConnectionGone } from './src/server/connectionGone.ts'
import { adoptCheckedEnv } from './src/server/devEnv.ts'
import { entranceGuard } from './src/server/devEntrance.ts'

/**
 * In dev, Nitro hands a request the browser marks as an image, video or embed (`Sec-Fetch-Dest`) to
 * Vite's static files unless one of its own routes matches, and the API is a single catch-all, so
 * `/api/uploads/:id` 404ed in `<img>` and `<video>`. Nothing under /api is a Vite file.
 */
const apiIsNeverAnAsset = (): Plugin => ({
  name: 'agent-board:api-is-never-an-asset',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/api/')) req.headers['sec-fetch-dest'] = 'empty'
      next()
    })
  },
})

/**
 * `vite dev` listens before Nitro's plugins run, so the sign-in-off checks of src/server/startup.ts on
 * where it listens happen here, on Vite's own host and port: loopback only, never the live port. So does
 * its refusal of a PUBLIC_ORIGIN it cannot trust (README: "Using it from other devices"). BOARD_ENV, AUTH
 * and PUBLIC_ORIGIN are in process.env as Vite's loadEnv reads them (adoptCheckedEnv, below).
 */
const refuseUnsafeAuth = (): Plugin => ({
  name: 'agent-board:refuse-unsafe-auth',
  apply: 'serve',
  configureServer(server) {
    const { host, port } = server.config.server
    try {
      // Vite's default host is localhost; `true` is every interface.
      const bind = { host: host === true ? undefined : host || 'localhost', port }
      checkBind(readAuthMode(process.env), bind)
      readPublicEntrance(process.env)
    } catch (err) {
      if (err instanceof StartupError) throw new Error(`agent-board refuses to start: ${err.message}`)
      throw err
    }
  },
})

/**
 * A reset connection between `vite dev` and Nitro's worker reached Vite's error middleware as a bare
 * `read ECONNRESET` and opened the error overlay over whatever the human was doing. The
 * handler ends such a request and lets every other error through to the overlay. Connect passes an
 * error to the next error handler after the middleware that raised it, so this one goes in after
 * Nitro's (pre and post) and before Vite's own: `order: 'post'` runs this hook after Nitro's, and the
 * function it returns runs after the one Nitro's returns, once Vite's internal middlewares are in.
 */
const connectionGoneIsNotAnError = (): Plugin => ({
  name: 'agent-board:connection-gone-is-not-an-error',
  apply: 'serve',
  configureServer: {
    order: 'post',
    handler(server) {
      return () => {
        server.middlewares.use(
          endConnectionGone((line) => server.config.logger.warn(line, { timestamp: true })),
        )
      }
    },
  },
})

/**
 * The host `vite dev` answers besides loopback: the tailnet entrance's public host, once PUBLIC_ORIGIN
 * is valid and sign-in is on; otherwise none. Never `true`, never a wildcard.
 */
function allowedHosts(): string[] {
  try {
    const entrance = readServedEntrance(process.env)
    return entrance ? [entrance.host] : []
  } catch (err) {
    // A PUBLIC_ORIGIN it cannot trust: refuseUnsafeAuth stops the start and says why.
    if (err instanceof StartupError) return []
    throw err
  }
}

export default defineConfig(({ mode }) => {
  // Before Nitro's plugin loads .env (its config hook): from here on the startup checks, the request
  // guard and the board's runtime read BOARD_ENV, AUTH and PUBLIC_ORIGIN as loadEnv gives them
  // (src/server/devEnv.ts says why, and what still comes from Nitro's loader).
  adoptCheckedEnv(mode, process.cwd())
  return {
    resolve: { tsconfigPaths: true },
    // A preview run is built for the path the board proxies it at (runs.ts sets BOARD_PREVIEW_BASE); the board
    // itself, run from this checkout, keeps '/'.
    base: process.env.BOARD_PREVIEW_BASE || '/',
    plugins: [
      refuseUnsafeAuth(),
      // Ahead of Nitro's and Vite's own middlewares: Vite's files and its WebSocket are behind it too.
      entranceGuard(),
      apiIsNeverAnAsset(),
      nitro({
        plugins: [
          // First, so that even a refusal to start (startup.ts) leaves its exit line.
          './src/server/plugins/processLog.ts',
          './src/server/startup.ts',
          './src/server/plugins/previewUpgrade.ts',
          './src/server/plugins/uploadSweep.ts',
          './src/server/plugins/hostTools.ts',
          './src/server/plugins/seedRuns.ts',
          './src/server/plugins/desktopBridge.ts',
        ],
        // Loaded from node_modules, not bundled: its certificate code (@peculiar/x509, tsyringe) needs
        // reflect-metadata to run first, an order bundling breaks.
        traceDeps: ['@simplewebauthn/server'],
        // The e2e suite builds into its own folder, so the live board's .output is never touched.
        ...(process.env.BOARD_BUILD_DIR && { output: { dir: process.env.BOARD_BUILD_DIR } }),
      }),
      tailwindcss(),
      // No dev stylesheet of TanStack Start's (/@tanstack-start/styles.css): it is given a precedence, so
      // React puts it at the top of the head, and the inline KEY_ENTRIES after it (src/lib/reveal.ts) would
      // not run until it had loaded. It holds the CSS that routes import as modules, and none does: the
      // app's CSS is the link in src/routes/__root.tsx, which Vite serves and hot-reloads as it is. Builds
      // never had it.
      tanstackStart({ dev: { ssrStyles: { enabled: false } } }),
      viteReact(),
      connectionGoneIsNotAnError(),
    ],
    ssr: { noExternal: ['react-markdown', 'remark-gfm'] },
    server: {
      // The board writes its database, uploads and logs under data/ all the time; none of it is code. Nor
      // is what the benchmark keeps in .bench/ (its builds, copies of the data and results), nor the desktop
      // app's staged board and installer (desktop/.stage, desktop/dist).
      watch: {
        ignored: [
          '**/data/**',
          '**/.output*/**',
          '**/.bench/**',
          '**/desktop/.stage/**',
          '**/desktop/dist/**',
        ],
      },
      allowedHosts: allowedHosts(),
    },
  }
})
