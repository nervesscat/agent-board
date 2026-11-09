import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'

import { guardBoardRequest, refusalResponse } from '#/server/entrance'
import { servePreview } from '#/server/previewProxy'

const startHandler = createStartHandler(defaultStreamHandler)

// The guard (src/server/entrance.ts) before anything else, in every mode: the framework answers some
// requests ahead of the sign-in middleware of src/start.ts (a target starting with `//` gets a 308 to
// the URL it makes of it, Host and all), and none of them may be answered for a Host, a proxy or Funnel
// the guard refuses. What it lets through, src/start.ts guards again and signs in.
// A running preview's path (`/p/<w>/<r>/`) is the preview proxy's (previewProxy.ts), which signs its callers in
// itself and answers 401 JSON, not a login page: it goes before the framework's sign-in middleware.
export default createServerEntry({
  async fetch(request, opts) {
    const verdict = guardBoardRequest(request)
    if (!verdict.allow) return refusalResponse(verdict)
    return (await servePreview(request)) ?? startHandler(request, opts)
  },
})
