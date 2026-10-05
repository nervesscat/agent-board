import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

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

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    apiIsNeverAnAsset(),
    nitro({ plugins: ['./src/server/plugins/uploadSweep.ts'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  ssr: { noExternal: ['react-markdown', 'remark-gfm'] },
})
