import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import {
  authMode,
  config,
  entranceOf,
  publicOriginProblem,
  readPublicEntrance,
  resetServedEntrance,
  servedEntrance,
  setStoredEntrance,
  TAILNET_SETTING,
} from './config'
import { HttpError } from './http'
import { signOutOfOrigin } from './passkeys'
import { savedEntrance } from './tailnetStore'
import { funnelled, parseTailscaleJson, servedAt, tailscaleAsync } from './tailscale.mjs'

/**
 * The tailnet entrance Settings shows and saves (README: "Using it from other devices"). The human only:
 * api/authApi.ts refuses an agent. The board reads Tailscale with the reads of tailscale.mjs and never runs
 * `tailscale serve` or `funnel`: the command is shown, and the human runs it.
 *
 * The entrance saved here is the settings row TAILNET_SETTING, `{ "origin": ... }` (or none). PUBLIC_ORIGIN in
 * the environment wins over it (the section shows it read-only), and the production board alone serves it.
 */

/** This machine's Tailscale, as the board reads it. */
export interface TailnetStatus {
  /** The CLI is found on this machine (false: not installed, or TAILSCALE_BIN names nothing). */
  installed: boolean
  version: string | null
  /** Tailscale's BackendState: Running when up and signed in; NeedsLogin, Stopped and the rest otherwise. */
  backend: string | null
  signedIn: boolean
  /** This machine's tailnet name (MagicDNS), without the trailing dot; null without one. */
  name: string | null
  /** HTTPS certificates are on for the name. */
  https: boolean
  /** What `tailscale serve` sends https://<name>:443 to: the board, another target, or nothing. */
  serve: { state: 'board' | 'other' | 'none'; target: string | null }
  /** Tailscale Funnel is on for something this machine serves: the internet, which the board refuses. */
  funnel: boolean
  /** Whether Funnel's state could be read at all. When not, it is unknown and a save is refused. */
  funnelKnown: boolean
  /** What the CLI said when a read failed (the status is then partial). */
  error: string | null
}

type Json = Record<string, unknown>
const asObject = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

const reasonOf = (err: unknown) => {
  const e = err as { stderr?: unknown; message?: unknown }
  return String(e.stderr || e.message || err).trim()
}

const readJson = async (...args: string[]) => parseTailscaleJson(await tailscaleAsync(...args), args)

/** The command that sends https://<name>:443 to the board on `port`: the human runs it, the board never does. */
export const serveCommand = (port: number) => `tailscale serve --bg --https=443 http://127.0.0.1:${port}`

/** The Tailscale state of this machine, read with the reads only (tailscale.mjs). Never throws. */
export async function readTailnet(port: number): Promise<TailnetStatus> {
  const base: TailnetStatus = {
    installed: true,
    version: null,
    backend: null,
    signedIn: false,
    name: null,
    https: false,
    serve: { state: 'none', target: null },
    funnel: false,
    // Known off where there is no Tailscale to be on; otherwise known only once the funnel read answers.
    funnelKnown: false,
    error: null,
  }
  try {
    base.version = (await tailscaleAsync('version')).split(/\r?\n/)[0]!.trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ...base, installed: false, funnelKnown: true }
    return { ...base, error: reasonOf(err) }
  }
  // A status that will not read leaves the rest unknown, but the serve and Funnel reads still run: Funnel
  // on must show, and refuse a save, whatever the status said.
  let status: Json = {}
  let statusError: string | null = null
  try {
    status = await readJson('status', '--json')
  } catch (err) {
    statusError = reasonOf(err)
  }
  const backend = typeof status.BackendState === 'string' ? status.BackendState : null
  const dns = asObject(status.Self).DNSName
  const name = typeof dns === 'string' && dns.replace(/\.$/, '') ? dns.replace(/\.$/, '') : null
  const certs = Array.isArray(status.CertDomains) ? status.CertDomains : []
  const out: TailnetStatus = {
    ...base,
    backend,
    signedIn: backend === 'Running',
    name,
    https: name !== null && certs.includes(name),
    error: statusError,
  }
  let serveConfig: Json = {}
  try {
    serveConfig = await readJson('serve', 'status', '--json')
  } catch (err) {
    out.error = out.error ?? reasonOf(err)
  }
  // The funnel status is read too, though the serve config holds AllowFunnel as well: an older CLI has none.
  // Funnel's state is unknown when its own read fails: the save is then refused, not let through.
  let funnelConfig: Json = {}
  let funnelKnown = true
  try {
    funnelConfig = await readJson('funnel', 'status', '--json')
  } catch {
    funnelKnown = false
  }
  out.funnelKnown = funnelKnown
  if (name !== null) {
    const target = servedAt(serveConfig, name, 443)
    out.serve =
      target === null
        ? { state: 'none', target: null }
        : {
            state: target.replace(/\/$/, '') === `http://127.0.0.1:${port}` ? 'board' : 'other',
            target,
          }
  }
  out.funnel = funnelled(serveConfig).length > 0 || funnelled(funnelConfig).length > 0
  return out
}

/** What Settings shows: the entrance, where it comes from, and this machine's Tailscale. */
export interface EntranceState {
  boardEnv: string
  signInOff: boolean
  port: number
  command: string
  /** PUBLIC_ORIGIN from the environment, when set: it wins, and the section shows it read-only. */
  fromEnv: string | null
  /** The entrance Settings saved, if any. */
  saved: string | null
  /** Why a saved entrance is not served by this board (sign-in off, or not the production board); null if it is. */
  unserved: string | null
  /** The entrance this board serves now, and where it comes from. */
  served: { origin: string; from: 'config' | 'settings' } | null
  tailscale: TailnetStatus
}

/** PUBLIC_ORIGIN from the environment as the board reads it (config.env, .env or the shell), or null. */
const envEntrance = () => readPublicEntrance(process.env)

export async function entranceState(): Promise<EntranceState> {
  const auth = authMode()
  const fromEnv = envEntrance()
  const saved = savedEntrance(db.$client)
  const served = servedEntrance()
  let unserved: string | null = null
  if (saved && !served && !fromEnv) {
    if (auth.off) unserved = `sign-in is off (BOARD_ENV=${auth.boardEnv}): the entrance is not served`
    else if (auth.boardEnv !== 'production')
      unserved = `this is a ${auth.boardEnv} board: only the production board serves the entrance`
  }
  return {
    boardEnv: auth.boardEnv,
    signInOff: auth.off,
    port: config.port,
    command: serveCommand(config.port),
    fromEnv: fromEnv?.origin ?? null,
    saved: saved?.origin ?? null,
    unserved,
    served: served ? { origin: served.origin, from: fromEnv ? 'config' : 'settings' } : null,
    tailscale: await readTailnet(config.port),
  }
}

/**
 * Saves the entrance (`origin`), or turns it off (null), as the human `actor`. Refused (HttpError) when the
 * origin is not one the board takes, sign-in is off, this is not the production board, PUBLIC_ORIGIN is set in
 * the environment, or Tailscale Funnel is on. Each save or clear writes one activity row; the sessions made on
 * the origin it changes from are signed out, and its passkeys stay listed.
 */
export async function setEntrance(origin: string | null, actor: string): Promise<EntranceState> {
  const next = origin === null ? null : origin.trim().replace(/\/$/, '')
  const problem = next === null ? null : publicOriginProblem(next)
  if (problem !== null) throw new HttpError(400, problem)
  const auth = authMode()
  if (auth.off)
    throw new HttpError(
      409,
      `sign-in is off (BOARD_ENV=${auth.boardEnv}): the entrance is not served here, so it cannot be saved here`,
      'auth-off',
    )
  if (auth.boardEnv !== 'production')
    throw new HttpError(
      409,
      `this is a ${auth.boardEnv} board: the entrance is set on the live board only`,
      'not-live',
    )
  if (envEntrance())
    throw new HttpError(
      409,
      'PUBLIC_ORIGIN is set in config.env (or in .env, or the environment), and it wins over this setting: ' +
        'remove it there to set the entrance here',
      'env-set',
    )
  const tailnet = await readTailnet(config.port)
  if (!tailnet.funnelKnown)
    throw new HttpError(
      409,
      'could not read Funnel: Tailscale did not say whether Funnel is on, so the save is refused. ' +
        'Check that `tailscale funnel status --json` answers, then save again',
      'funnel-unknown',
    )
  if (tailnet.funnel)
    throw new HttpError(
      409,
      'Tailscale Funnel is on: it puts the board on the internet, and the board answers on your tailnet only. ' +
        'Turn it off first (tailscale funnel off, or tailscale serve reset), then save',
      'funnel',
    )

  const before = savedEntrance(db.$client)
  const after = next === null ? null : entranceOf(next)
  db.transaction(() => {
    if (after)
      db.insert(schema.settings)
        .values({ key: TAILNET_SETTING, value: { origin: after.origin } })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: { origin: after.origin } } })
        .run()
    else db.delete(schema.settings).where(eq(schema.settings.key, TAILNET_SETTING)).run()
    // The sessions made on the origin it changes from end; its passkeys stay listed (Devices).
    if (before && before.host !== after?.host) signOutOfOrigin(before.host)
    logActivity({
      projectId: null,
      actor,
      kind: 'tailnet.entrance',
      text: `tailnet entrance ${before?.origin ?? 'none'} -> ${after?.origin ?? 'none'}`,
    })
  })
  resetServedEntrance()
  return entranceState()
}

export interface EntranceCheck {
  ok: boolean
  message: string
}

const failed = (message: string): EntranceCheck => ({ ok: false, message })

/**
 * What answering `<origin>/api/health` says of the board's entrance: 401 (the board, asking for sign-in) is
 * ok; 403 is a host it does not take (the name does not reach the board); 200 is a board with no sign-in.
 */
export async function probeHealth(origin: string, fetcher: typeof fetch = fetch): Promise<EntranceCheck> {
  const url = `${origin}/api/health`
  let res: Response
  try {
    res = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
  } catch (err) {
    const cause =
      (err as { cause?: { code?: string } }).cause?.code ?? (err instanceof Error ? err.message : String(err))
    return failed(`could not reach ${url} from this board (${cause})`)
  }
  await res.body?.cancel()
  if (res.status === 401)
    return { ok: true, message: `${url} answers 401: the board is on your tailnet and asks for sign-in` }
  if (res.status === 403)
    return failed(
      `${url} answers 403: the board refuses the name, so the request did not come through the entrance ` +
        `${origin}. Check that tailscale serve sends https://${new URL(origin).host}:443 to the board`,
    )
  if (res.status === 200)
    return failed(`${url} answers 200 without signing in: that is not the board with its sign-in on`)
  return failed(`${url} answers ${res.status}`)
}

/**
 * The Test button: the board asks itself over its tailnet name, after the Tailscale state that would make
 * that fail is named (not installed, signed out, no MagicDNS name, no HTTPS certificate, serve not set).
 */
export async function checkEntrance(port: number = config.port): Promise<EntranceCheck> {
  const auth = authMode()
  if (auth.off)
    return failed(
      `sign-in is off (BOARD_ENV=${auth.boardEnv}): the board does not answer through the tailnet here, so there is nothing to check`,
    )
  const s = await readTailnet(port)
  if (!s.installed) return failed('Tailscale is not installed on this machine')
  if (!s.funnelKnown)
    return failed('could not read Funnel: check that tailscale funnel status --json answers')
  if (s.funnel)
    return failed('Tailscale Funnel is on: turn it off first; the board answers on the tailnet only')
  if (!s.signedIn) return failed(`Tailscale is ${s.backend ?? 'not running'} on this machine: sign in first`)
  if (s.name === null)
    return failed('This machine has no tailnet name: turn on MagicDNS in the admin console')
  if (!s.https) return failed(`There is no HTTPS certificate for ${s.name}: turn on HTTPS certificates`)
  if (s.serve.state === 'other')
    return failed(
      `tailscale serve sends https://${s.name} to ${s.serve.target}, not to the board: run ${serveCommand(port)} ` +
        'on this machine (it replaces that), then check again',
    )
  if (s.serve.state === 'none')
    return failed(
      `tailscale serve does not send https://${s.name} to the board yet: run ${serveCommand(port)} on this ` +
        'machine, then check again',
    )
  const served = servedEntrance()
  if (!served) return failed('Save the entrance first: until it is saved, the board refuses this name')
  if (served.host !== s.name)
    return failed(`The entrance is ${served.origin}, but this machine is ${s.name}: save https://${s.name}`)
  return probeHealth(served.origin)
}

// The entrance the board serves is the one Settings saved, read from its database (config.ts servedEntrance).
setStoredEntrance(() => {
  try {
    return savedEntrance(db.$client)
  } catch (err) {
    console.error('agent-board: cannot read the tailnet entrance from the database:', reasonOf(err))
    return null
  }
})
