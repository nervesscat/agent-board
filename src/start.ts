import { createMiddleware, createStart } from '@tanstack/react-start'

import { authenticate, isBrowserNavigation, loginRedirect, rememberActor } from '#/server/auth'

const PUBLIC = new Set(['/api/health'])

// Every request, page or API, is answered by the gate before any handler runs.
const gateAuth = createMiddleware({ type: 'request' }).server(async ({ request, pathname, next }) => {
  if (PUBLIC.has(pathname)) return next()
  const actor = await authenticate(request)
  if (!actor) {
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
