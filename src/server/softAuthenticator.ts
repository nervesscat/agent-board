import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

/**
 * A passkey authenticator in software, for the tests: ES256 keys from node:crypto, and the bytes a real
 * one returns (CBOR attestation object, authenticator data, DER signature) built by hand here, so the
 * board's WebAuthn verification runs on them for real. Like a real authenticator it keeps each passkey
 * with the RP ID it was made for and signs with that RP ID; the origin is whatever the caller says the
 * browser was on, so a test can play a page on another origin.
 */

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url')

// --- the little CBOR the attestation object needs: integers, byte and text strings, maps ---

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value])
  const parts = [head(5, value.size)]
  for (const [k, v] of value) parts.push(cbor(k), cbor(v))
  return Buffer.concat(parts)
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

const counterBytes = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

interface Stored {
  id: string
  rpId: string
  privateKey: KeyObject
  userHandle: string
  counter: number
}

export class SoftAuthenticator {
  readonly passkeys = new Map<string, Stored>()

  /** navigator.credentials.create(): a new passkey for the options' RP, as the browser on `origin` returns it. */
  register(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    const rpId = options.rp.id!
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const coseKey = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    )
    const credentialId = randomBytes(16)
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      counterBytes(0),
      Buffer.alloc(16), // AAGUID: none
      Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      coseKey,
    ])
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    })
    const id = b64url(credentialId)
    this.passkeys.set(id, { id, rpId, privateKey, userHandle: options.user.id, counter: 0 })
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    }
  }

  /**
   * navigator.credentials.get(): an assertion by one of its passkeys (`credentialId`, else the first one
   * the options allow, else the first for their RP ID), signed with the RP ID it was made for.
   */
  assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
    credentialId?: string,
  ): AuthenticationResponseJSON {
    const allowed = new Set(options.allowCredentials?.map((c) => c.id))
    const passkey = credentialId
      ? this.passkeys.get(credentialId)
      : ([...this.passkeys.values()].find((p) => allowed.has(p.id)) ??
        [...this.passkeys.values()].find((p) => p.rpId === options.rpId))
    if (!passkey) throw new Error('no passkey for this RP')
    passkey.counter += 1
    const authenticatorData = Buffer.concat([
      sha256(passkey.rpId),
      Buffer.from([FLAG_UP | FLAG_UV]),
      counterBytes(passkey.counter),
    ])
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }),
    )
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      passkey.privateKey,
    )
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: passkey.userHandle,
      },
    }
  }
}
