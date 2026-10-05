import { createMiddleware, createStart } from '@tanstack/react-start'

import { authenticate, isBrowserNavigation, loginRedirect, rememberActor } from '#/server/auth'
import { authMode } from '#/server/config'

const PUBLIC = new Set(['/api/health'])

// Every request, page or API, is answered by the gate before any handler runs. With the gate off
// (outside production only, see config.ts) nobody is turned away but a malformed X-Test-Actor.
const gateAuth = createMiddleware({ type: 'request' }).server(async ({ request, pathname, next }) => {
  if (PUBLIC.has(pathname)) return next()
  const actor = await authenticate(request)
  if (!actor) {
    if (authMode().off)
      return Response.json({ error: 'X-Test-Actor must be human:<name> or agent:<name>' }, { status: 401 })
    if (isBrowserNavigation(request)) return loginRedirect(request)
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
