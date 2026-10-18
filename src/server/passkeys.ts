import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'

import { db, schema } from '#/db'
import { hashSecret, newSecret, SESSION_COOKIE, sessionOf } from './credentials'
import { LOCAL_RP_ID, type SignInSite } from './entrance'
import { HttpError } from './http'

/**
 * The board's own passkey sign-in (WebAuthn, @simplewebauthn/server). README: "Signing in".
 *
 * - One account, the human: made by /setup on this machine at first boot, with its first passkey on the
 *   localhost RP, and never again.
 * - A passkey signs in on the origin it was made on and no other: localhost on this machine, the
 *   tailnet name through the entrance. Another device gets one through a one-time link the signed-in
 *   human makes (15 minutes, used once).
 * - A sign-in is a session: a random cookie, kept as its hash, for 90 days. Revoking its passkey ends it.
 *
 * Each ceremony's challenge is kept here, in memory, for five minutes, and taken (gone) the moment a
 * response names it, whether or not the rest of the response holds.
 */

export const RP_NAME = 'CrossBoard'
export const SESSION_DAYS = 90
export const ENROL_MINUTES = 15
const CHALLENGE_MS = 5 * 60_000
/** Challenges kept at most: expired ones go first, then the oldest, so made-up calls cannot grow it. */
export const CHALLENGES_MAX = 1000

const DAY_MS = 24 * 60 * 60_000
// EdDSA, ES256, RS256: what passkeys use. Named here, the library does not probe the runtime for
// post-quantum ones (an experimental Web Crypto call that warns on every start).
const ALGORITHMS = [-8, -7, -257]

type Purpose = 'setup' | 'login' | 'enrol'
interface Pending {
  purpose: Purpose
  rpId: string
  until: number
  /** setup: the account's name and WebAuthn user handle, as the options gave them. */
  name?: string
  userHandle?: string
  /** enrol: the one-time code the options were given for. */
  codeHash?: string
}
const pending = new Map<string, Pending>()

function remember(challenge: string, entry: Omit<Pending, 'until'>) {
  const now = Date.now()
  if (pending.size >= CHALLENGES_MAX) {
    for (const [k, p] of pending) if (p.until <= now) pending.delete(k)
    // A Map keeps insertion order: the first key is the oldest challenge.
    while (pending.size >= CHALLENGES_MAX) pending.delete(pending.keys().next().value!)
  }
  pending.set(challenge, { ...entry, until: now + CHALLENGE_MS })
}

/**
 * The expectedChallenge check of a verify: the challenge must be one this board gave for `purpose` on
 * this RP ID, still fresh. It is taken either way; what it was given with lands in `got`.
 */
function take(purpose: Purpose, rpId: string, got: { entry?: Pending }) {
  return (challenge: string) => {
    const entry = pending.get(challenge)
    pending.delete(challenge)
    if (!entry || entry.purpose !== purpose || entry.rpId !== rpId || entry.until <= Date.now()) return false
    got.entry = entry
    return true
  }
}

const nowIso = () => new Date().toISOString()
const sqlite = () => db.$client

// --- the account ---

export interface Account {
  name: string
  userHandle: string
  createdAt: string
}

export function getAccount(): Account | null {
  return (
    db
      .select({
        name: schema.account.name,
        userHandle: schema.account.userHandle,
        createdAt: schema.account.createdAt,
      })
      .from(schema.account)
      .get() ?? null
  )
}

export const hasAccount = () => getAccount() !== null

const SETUP_DONE = () => new HttpError(409, 'the board is set up already: sign in instead', 'set-up')
const SETUP_FIRST = () => new HttpError(409, 'setup required: create the account on the host first', 'setup')

// --- sessions ---

export interface NewSession {
  token: string
  expiresAt: string
}

function createSession(passkeyId: number): NewSession {
  const token = newSecret()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString()
  db.insert(schema.sessions)
    .values({
      tokenHash: hashSecret(token),
      passkeyId,
      createdAt: now.toISOString(),
      expiresAt,
      lastSeenAt: now.toISOString(),
    })
    .run()
  return { token, expiresAt }
}

/** The Set-Cookie of a new session: HttpOnly, SameSite=Lax, Secure on an https origin. */
export function sessionCookie(site: SignInSite, session: NewSession): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000))
  const secure = site.origin.startsWith('https:') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

/** The Set-Cookie that drops the session cookie. */
export function clearedCookie(site: SignInSite): string {
  const secure = site.origin.startsWith('https:') ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`
}

/** Ends the session of this cookie value, if there is one. */
export function endSession(token: string) {
  db.delete(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashSecret(token)))
    .run()
}

/** The human's live session for this cookie value on `site`'s origin; its last seen is kept to the minute. */
export function liveSession(token: string, site: SignInSite) {
  const hit = sessionOf(sqlite(), token, site.rpId)
  if (!hit) return null
  if (Date.now() - Date.parse(hit.lastSeenAt) > 60_000)
    db.update(schema.sessions).set({ lastSeenAt: nowIso() }).where(eq(schema.sessions.id, hit.id)).run()
  return hit
}

// --- passkeys ---

function addPasskey(
  site: SignInSite,
  name: string,
  credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] },
): number {
  return db
    .insert(schema.passkeys)
    .values({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
      rpId: site.rpId,
      name,
      createdAt: nowIso(),
    })
    .returning({ id: schema.passkeys.id })
    .get().id
}

const passkeysOf = (rpId: string) =>
  db
    .select({ credentialId: schema.passkeys.credentialId, transports: schema.passkeys.transports })
    .from(schema.passkeys)
    .where(eq(schema.passkeys.rpId, rpId))
    .all()
    .map((p) => ({ id: p.credentialId, transports: p.transports }))

const registration = (site: SignInSite, account: { name: string; userHandle: string }, exclude: boolean) =>
  generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: site.rpId,
    userName: account.name,
    userDisplayName: account.name,
    userID: Buffer.from(account.userHandle, 'base64url'),
    attestationType: 'none',
    excludeCredentials: exclude ? passkeysOf(site.rpId) : [],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    supportedAlgorithmIDs: ALGORITHMS,
  })

async function verifyNewPasskey(
  site: SignInSite,
  purpose: Purpose,
  response: RegistrationResponseJSON,
): Promise<{ entry: Pending; credential: Parameters<typeof addPasskey>[2] }> {
  const got: { entry?: Pending } = {}
  let verified
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: take(purpose, site.rpId, got),
      expectedOrigin: site.origin,
      expectedRPID: site.rpId,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    })
  } catch (err) {
    throw new HttpError(400, `the passkey was not accepted: ${err instanceof Error ? err.message : err}`)
  }
  if (!verified.verified || !got.entry) throw new HttpError(400, 'the passkey was not accepted')
  return { entry: got.entry, credential: verified.registrationInfo.credential }
}

// --- first boot: the account and its first passkey, on this machine only (authApi.ts checks where) ---

export async function setupOptions(site: SignInSite, name: string) {
  if (hasAccount()) throw SETUP_DONE()
  if (site.rpId !== LOCAL_RP_ID) throw new HttpError(403, 'setup is done on the host, on localhost')
  const account = { name, userHandle: newSecret() }
  const options = await registration(site, account, false)
  remember(options.challenge, { purpose: 'setup', rpId: site.rpId, ...account })
  return options
}

/** Creates the account with its first passkey, and signs this browser in. Once: then always 409. */
export async function setupVerify(
  site: SignInSite,
  device: string,
  response: RegistrationResponseJSON,
): Promise<NewSession> {
  if (hasAccount()) throw SETUP_DONE()
  const { entry, credential } = await verifyNewPasskey(site, 'setup', response)
  return db.transaction(() => {
    // The primary key is 1, and only 1: a second setup racing this one fails here, storing nothing.
    const created = db
      .insert(schema.account)
      .values({ id: 1, name: entry.name!, userHandle: entry.userHandle!, createdAt: nowIso() })
      .onConflictDoNothing()
      .run()
    if (created.changes !== 1) throw SETUP_DONE()
    return createSession(addPasskey(site, device, credential))
  })
}

// --- signing in ---

export async function loginOptions(site: SignInSite) {
  if (!hasAccount()) throw SETUP_FIRST()
  const options = await generateAuthenticationOptions({
    rpID: site.rpId,
    allowCredentials: passkeysOf(site.rpId),
    userVerification: 'preferred',
  })
  remember(options.challenge, { purpose: 'login', rpId: site.rpId })
  return options
}

/** Checks a passkey's assertion on `site`'s origin and signs the browser in. */
export async function loginVerify(
  site: SignInSite,
  response: AuthenticationResponseJSON,
): Promise<NewSession> {
  if (!hasAccount()) throw SETUP_FIRST()
  // A passkey of the other origin is not one here, whatever the response says.
  const passkey = db
    .select()
    .from(schema.passkeys)
    .where(and(eq(schema.passkeys.credentialId, String(response?.id)), eq(schema.passkeys.rpId, site.rpId)))
    .get()
  if (!passkey) throw new HttpError(401, 'this passkey is not known on this origin')
  const got: { entry?: Pending } = {}
  let verified
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: take('login', site.rpId, got),
      expectedOrigin: site.origin,
      expectedRPID: site.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    })
  } catch (err) {
    throw new HttpError(401, `the passkey was not accepted: ${err instanceof Error ? err.message : err}`)
  }
  if (!verified.verified) throw new HttpError(401, 'the passkey was not accepted')
  db.update(schema.passkeys)
    .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: nowIso() })
    .where(eq(schema.passkeys.id, passkey.id))
    .run()
  return createSession(passkey.id)
}

// --- another device: a one-time link from the signed-in human ---

const ENROL_GONE = () => new HttpError(403, 'this link is used or expired: make a new one on the board')

/** A new one-time code, valid ENROL_MINUTES. Only the signed-in human calls this (authApi.ts). */
export function createEnrolCode(): { code: string; expiresAt: string } {
  const code = newSecret()
  const expiresAt = new Date(Date.now() + ENROL_MINUTES * 60_000).toISOString()
  db.insert(schema.enrolCodes)
    .values({ codeHash: hashSecret(code), createdAt: nowIso(), expiresAt })
    .run()
  return { code, expiresAt }
}

const liveCode = (codeHash: string) =>
  and(
    eq(schema.enrolCodes.codeHash, codeHash),
    isNull(schema.enrolCodes.usedAt),
    gt(schema.enrolCodes.expiresAt, nowIso()),
  )

export async function enrolOptions(site: SignInSite, code: string) {
  const account = getAccount()
  if (!account) throw SETUP_FIRST()
  const codeHash = hashSecret(code)
  if (!db.select({ id: schema.enrolCodes.id }).from(schema.enrolCodes).where(liveCode(codeHash)).get())
    throw ENROL_GONE()
  const options = await registration(site, account, true)
  remember(options.challenge, { purpose: 'enrol', rpId: site.rpId, codeHash })
  return options
}

/** Adds the device's passkey on `site`'s RP ID and signs it in, using up the code. */
export async function enrolVerify(
  site: SignInSite,
  code: string,
  device: string,
  response: RegistrationResponseJSON,
): Promise<NewSession> {
  if (!hasAccount()) throw SETUP_FIRST()
  const codeHash = hashSecret(code)
  const { entry, credential } = await verifyNewPasskey(site, 'enrol', response)
  if (entry.codeHash !== codeHash) throw new HttpError(400, 'the passkey was not made for this link')
  return db.transaction(() => {
    const used = db.update(schema.enrolCodes).set({ usedAt: nowIso() }).where(liveCode(codeHash)).run()
    if (used.changes !== 1) throw ENROL_GONE()
    return createSession(addPasskey(site, device, credential))
  })
}

// --- the devices section: passkeys and sessions, listed and revoked by the human ---

export function listPasskeys() {
  return db
    .select({
      id: schema.passkeys.id,
      name: schema.passkeys.name,
      rpId: schema.passkeys.rpId,
      createdAt: schema.passkeys.createdAt,
      lastUsedAt: schema.passkeys.lastUsedAt,
      sessions: sql<number>`(select count(*) from ${schema.sessions} where ${schema.sessions.passkeyId} = ${schema.passkeys.id} and ${schema.sessions.expiresAt} > ${nowIso()})`,
    })
    .from(schema.passkeys)
    .orderBy(asc(schema.passkeys.id))
    .all()
}

/** Removes a passkey and ends its sessions; never the last one of this machine (no lock-out). */
export function revokePasskey(id: number) {
  db.transaction(() => {
    const passkey = db.select().from(schema.passkeys).where(eq(schema.passkeys.id, id)).get()
    if (!passkey) throw new HttpError(404, 'passkey not found')
    if (passkey.rpId === LOCAL_RP_ID) {
      const local = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.passkeys)
        .where(eq(schema.passkeys.rpId, LOCAL_RP_ID))
        .get()!.n
      if (local <= 1)
        throw new HttpError(
          409,
          'this is the last passkey of this machine: add another before revoking it, or you are locked out',
          'last-passkey',
        )
    }
    // Its sessions go with it (ON DELETE CASCADE).
    db.delete(schema.passkeys).where(eq(schema.passkeys.id, id)).run()
  })
}

/** The live sessions, with the passkey each signed in with; `current` is the caller's own. */
export function listSessions(currentToken: string | null) {
  const current = currentToken ? hashSecret(currentToken) : null
  return db
    .select({
      id: schema.sessions.id,
      passkey: schema.passkeys.name,
      rpId: schema.passkeys.rpId,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
      tokenHash: schema.sessions.tokenHash,
    })
    .from(schema.sessions)
    .innerJoin(schema.passkeys, eq(schema.passkeys.id, schema.sessions.passkeyId))
    .where(gt(schema.sessions.expiresAt, nowIso()))
    .orderBy(asc(schema.sessions.id))
    .all()
    .map(({ tokenHash, ...s }) => ({ ...s, current: tokenHash === current }))
}

export type PasskeyRow = ReturnType<typeof listPasskeys>[number]
export type SessionRow = ReturnType<typeof listSessions>[number]

/** A new one-time link to enrol another device: on the tailnet name when the entrance is on, and here. */
export interface EnrolLink {
  expiresAt: string
  links: { where: 'tailnet' | 'this machine'; url: string }[]
}

export function revokeSession(id: number) {
  const gone = db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run()
  if (gone.changes !== 1) throw new HttpError(404, 'session not found')
}
