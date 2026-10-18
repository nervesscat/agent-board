import { createMiddleware, createStart } from '@tanstack/react-start'

import {
  authenticate,
  isBrowserNavigation,
  localRoute,
  loginRedirect,
  peerOf,
  rememberActor,
} from '#/server/auth'
import { authMode, config, servedEntrance } from '#/server/config'
import { guardRequest, publicRoute } from '#/server/entrance'

// Answered without a session on this machine only: through the tailnet entrance it needs one too.
const PUBLIC = new Set(['/api/health'])

// Every request, page or API, passes the guard first (Funnel, Host, proxied requests, writes from another
// origin: src/server/entrance.ts), then is answered by the gate before any handler runs: the public gate
// when it came through the tailnet entrance, else the localhost gate. With the gate off (outside
// production only, see config.ts) nothing comes through a proxy, and nobody is turned away but a
// malformed X-Test-Actor.
const gateAuth = createMiddleware({ type: 'request' }).server(async ({ request, pathname, next }) => {
  const auth = authMode()
  const verdict = guardRequest(
    { method: request.method, headers: request.headers, peer: peerOf(request) },
    { gateOff: auth.off, port: config.port, entrance: servedEntrance() },
  )
  if (!verdict.allow) return Response.json({ error: verdict.error }, { status: verdict.status })
  if (PUBLIC.has(pathname) && !verdict.entrance) return next()
  const route = verdict.entrance ? publicRoute(verdict.entrance) : localRoute()
  const actor = await authenticate(request, route)
  if (!actor) {
    if (auth.off)
      return Response.json({ error: 'X-Test-Actor must be human:<name> or agent:<name>' }, { status: 401 })
    if (isBrowserNavigation(request)) return loginRedirect(request, route)
    return Response.json({ error: 'sign in' }, { status: 401 })
  }
  rememberActor(request, actor)
  return next({ context: { actor } })
})

export const startInstance = createStart(() => ({
  requestMiddleware: [gateAuth],
}))

declare module '@tanstack/react-start' {
  interface Register {
    start: typeof startInstance
  }
}
