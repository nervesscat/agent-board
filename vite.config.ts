import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

import { checkBind, readAuthMode, StartupError } from './src/server/config.ts'
import { endConnectionGone } from './src/server/connectionGone.ts'

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
 * `vite dev` listens before Nitro's plugins run, so the gate-off checks of src/server/startup.ts on
 * where it listens happen here, on Vite's own host and port: loopback only, never the live port.
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

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    refuseUnsafeAuth(),
    apiIsNeverAnAsset(),
    nitro({
      plugins: ['./src/server/startup.ts', './src/server/plugins/uploadSweep.ts'],
      // The e2e suite builds into its own folder, so the live board's .output is never touched.
      ...(process.env.BOARD_BUILD_DIR && { output: { dir: process.env.BOARD_BUILD_DIR } }),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    connectionGoneIsNotAnError(),
  ],
  ssr: { noExternal: ['react-markdown', 'remark-gfm'] },
  // The board writes its database, uploads and logs under data/ all the time; none of it is code. Nor
  // is what the benchmark keeps in .bench/ (its builds, copies of the data and results).
  server: { watch: { ignored: ['**/data/**', '**/.output*/**', '**/.bench/**'] } },
})
