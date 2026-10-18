import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { z } from 'zod'

import { isAgent, onThisMachine, siteOf } from './auth'
import { authMode, config, servedEntrance } from './config'
import { readCookie, SESSION_COOKIE } from './credentials'
import { localSite, type SignInSite } from './entrance'
import { HttpError, intParam, readJson } from './http'
import * as passkeys from './passkeys'
import type { ApiRouter } from './router'

/**
 * /api/auth/*: the passkey ceremonies of the sign-in pages (authPages.ts), signing out, and the devices
 * section of Settings. README: "Signing in".
 *
 * The ceremonies (setup, login, enrol) and logout are answered without a session (entrance.ts
 * SIGN_IN_API); setup only straight from this machine. The rest is the signed-in human's alone.
 */

// A WebAuthn response as the browser's credential serialises it; @simplewebauthn checks the rest.
const Credential = z.custom<object>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), {
  message: 'response must be the passkey response object',
})
const Name = z.string().trim().min(1).max(80)
const Device = z.string().trim().min(1).max(60)
const Code = z.string().min(1).max(200)

function siteOrRefuse(request: Request): SignInSite {
  if (authMode().off)
    throw new HttpError(409, `sign-in is off on this board (BOARD_ENV=${authMode().boardEnv})`, 'auth-off')
  const site = siteOf(request)
  if (!site) throw new HttpError(403, 'no tailnet entrance is configured (PUBLIC_ORIGIN)')
  return site
}

function humanOnly(request: Request, what: string): SignInSite {
  const site = siteOrRefuse(request)
  if (isAgent(request)) throw new HttpError(403, `only the human ${what}`)
  return site
}

/** Setup is done on the host itself: never through the tailnet entrance or from another machine. */
function hostOnly(request: Request): SignInSite {
  const site = siteOrRefuse(request)
  if (!onThisMachine(request))
    throw new HttpError(
      403,
      `setup is done on the host: open ${localSite(config.port).origin}/setup on the machine the board runs on`,
    )
  return site
}

const signedIn = (site: SignInSite, session: passkeys.NewSession) =>
  Response.json(
    { ok: true, expiresAt: session.expiresAt },
    { headers: { 'set-cookie': passkeys.sessionCookie(site, session) } },
  )

export function authRoutes(api: ApiRouter) {
  // --- first boot: the account and its first passkey ---
  api.post('/api/auth/setup/options', async ({ request }) => {
    const site = hostOnly(request)
    const { name } = await readJson(request, z.object({ name: Name }))
    return Response.json(await passkeys.setupOptions(site, name))
  })
  api.post('/api/auth/setup/verify', async ({ request }) => {
    const site = hostOnly(request)
    const body = await readJson(request, z.object({ device: Device, response: Credential }))
    return signedIn(
      site,
      await passkeys.setupVerify(site, body.device, body.response as RegistrationResponseJSON),
    )
  })

  // --- signing in and out ---
  api.post('/api/auth/login/options', async ({ request }) =>
    Response.json(await passkeys.loginOptions(siteOrRefuse(request))),
  )
  api.post('/api/auth/login/verify', async ({ request }) => {
    const site = siteOrRefuse(request)
    const body = await readJson(request, z.object({ response: Credential }))
    return signedIn(site, await passkeys.loginVerify(site, body.response as AuthenticationResponseJSON))
  })
  api.post('/api/auth/logout', ({ request }) => {
    const site = siteOrRefuse(request)
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
    if (token) passkeys.endSession(token)
    return Response.json({ ok: true }, { headers: { 'set-cookie': passkeys.clearedCookie(site) } })
  })

  // --- another device: the human makes a one-time link, the device enrols its passkey with it ---
  api.post('/api/auth/enrol-links', ({ request }) => {
    humanOnly(request, 'adds a device')
    const { code, expiresAt } = passkeys.createEnrolCode()
    const entrance = servedEntrance()
    const at = (origin: string) => `${origin}/enroll?code=${encodeURIComponent(code)}`
    const links = [
      ...(entrance ? [{ where: 'tailnet' as const, url: at(entrance.origin) }] : []),
      { where: 'this machine' as const, url: at(localSite(config.port).origin) },
    ]
    return Response.json({ expiresAt, links }, { status: 201 })
  })
  api.post('/api/auth/enrol/options', async ({ request }) => {
    const site = siteOrRefuse(request)
    const { code } = await readJson(request, z.object({ code: Code }))
    return Response.json(await passkeys.enrolOptions(site, code))
  })
  api.post('/api/auth/enrol/verify', async ({ request }) => {
    const site = siteOrRefuse(request)
    const body = await readJson(request, z.object({ code: Code, device: Device, response: Credential }))
    return signedIn(
      site,
      await passkeys.enrolVerify(site, body.code, body.device, body.response as RegistrationResponseJSON),
    )
  })

  // --- the devices section: passkeys and sessions ---
  api.get('/api/auth/passkeys', ({ request }) => {
    humanOnly(request, 'lists passkeys')
    return Response.json(passkeys.listPasskeys())
  })
  api.delete('/api/auth/passkeys/:id', ({ request, params }) => {
    humanOnly(request, 'revokes passkeys')
    passkeys.revokePasskey(intParam(params.id!))
    return new Response(null, { status: 204 })
  })
  api.get('/api/auth/sessions', ({ request }) => {
    humanOnly(request, 'lists sessions')
    return Response.json(passkeys.listSessions(readCookie(request.headers.get('cookie'), SESSION_COOKIE)))
  })
  api.delete('/api/auth/sessions/:id', ({ request, params }) => {
    humanOnly(request, 'ends sessions')
    passkeys.revokeSession(intParam(params.id!))
    return new Response(null, { status: 204 })
  })
}
