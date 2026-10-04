import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

import { checkBind, readAuthMode, StartupError } from './src/server/config.ts'

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

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    refuseUnsafeAuth(),
    apiIsNeverAnAsset(),
    nitro({
      plugins: ['./src/server/startup.ts'],
      // The e2e suite builds into its own folder, so the live board's .output is never touched.
      ...(process.env.BOARD_BUILD_DIR && { output: { dir: process.env.BOARD_BUILD_DIR } }),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  ssr: { noExternal: ['react-markdown', 'remark-gfm'] },
})
