import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'

import { guardBoardRequest, refusalResponse } from '#/server/entrance'

const startHandler = createStartHandler(defaultStreamHandler)

// The guard (src/server/entrance.ts) before anything else, in every mode: the framework answers some
// requests ahead of the sign-in middleware of src/start.ts (a target starting with `//` gets a 308 to
// the URL it makes of it, Host and all), and none of them may be answered for a Host, a proxy or Funnel
// the guard refuses. What it lets through, src/start.ts guards again and signs in.
export default createServerEntry({
  fetch(request, opts) {
    const verdict = guardBoardRequest(request)
    return verdict.allow ? startHandler(request, opts) : refusalResponse(verdict)
  },
})
