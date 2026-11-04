import { createMiddleware, createStart } from '@tanstack/react-start'

import { admit, rememberActor } from '#/server/auth'
import { signInPage } from '#/server/authPages'

// Every request, page or API, passes the guard first (Funnel, Host, proxied requests, writes from another
// origin: src/server/entrance.ts; src/server.ts has run it once already, ahead of the framework), then
// must be signed in before any handler runs: a passkey session of the origin it came through (this
// machine's localhost, or the tailnet name), or an agent token. Before the account exists everything
// but /setup is refused; the sign-in pages and their endpoints are open. With sign-in off (outside
// production only, see config.ts) nothing comes through a proxy, and nobody is turned away but a
// malformed X-Test-Actor. src/server/auth.ts `admit` says which.
const signIn = createMiddleware({ type: 'request' }).server(async ({ request, pathname, next }) => {
  const admission = await admit(request, pathname)
  if (admission.kind === 'refuse') return admission.response
  if (admission.kind === 'page') return signInPage(request, pathname, admission.site)
  if (admission.kind === 'open') return next()
  rememberActor(request, admission.caller)
  return next({ context: { actor: admission.actor } })
})

export const startInstance = createStart(() => ({
  requestMiddleware: [signIn],
}))

declare module '@tanstack/react-start' {
  interface Register {
    start: typeof startInstance
  }
}
