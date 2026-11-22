import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The person's language through the API router in test mode: who calls is X-Test-Actor.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf
beforeAll(async () => {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  callerOf = (await import('./auth')).callerOf
})

async function call(method: string, testActor: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json', 'x-test-actor': testActor }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request('http://localhost/api/me', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}
const languageOf = async (actor: string) =>
  ((await (await call('GET', actor)).json()) as { language: unknown }).language

describe('the language of the interface, per person', () => {
  it('is none until the person picks one, and is kept for them alone', async () => {
    expect(await languageOf('human:lucia')).toBeNull()
    const set = await call('PATCH', 'human:lucia', { language: 'es' })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ language: 'es' })
    expect(await languageOf('human:lucia')).toBe('es')
    // Another person's choice is theirs: Lucia's does not reach them.
    expect(await languageOf('human:enrique')).toBeNull()
    await call('PATCH', 'human:enrique', { language: 'en' })
    expect(await languageOf('human:enrique')).toBe('en')
    expect(await languageOf('human:lucia')).toBe('es')
  })

  it('follows the person, not the device: the next call, from anywhere, reads it', async () => {
    await call('PATCH', 'human:marta', { language: 'es' })
    for (let device = 0; device < 3; device++) expect(await languageOf('human:marta')).toBe('es')
  })

  it('is replaced by a second pick, and forgotten with null (the browser decides again)', async () => {
    await call('PATCH', 'human:ana', { language: 'es' })
    await call('PATCH', 'human:ana', { language: 'en' })
    expect(await languageOf('human:ana')).toBe('en')
    await call('PATCH', 'human:ana', { language: null })
    expect(await languageOf('human:ana')).toBeNull()
  })

  it('takes a supported language only', async () => {
    for (const bad of ['ar', '', 'ES', 1, undefined]) {
      const res = await call('PATCH', 'human:luis', { language: bad })
      expect(res.status, String(bad)).toBe(400)
    }
    expect(await languageOf('human:luis')).toBeNull()
  })

  it('reads as none when what is stored is not a language, and is the human alone: an agent is refused', async () => {
    const { db, schema } = await import('#/db')
    db.insert(schema.settings).values({ key: 'language:pablo', value: 'klingon' }).run()
    expect(await languageOf('human:pablo')).toBeNull()
    const refused = await call('PATCH', 'agent:builder', { language: 'es' })
    expect(refused.status).toBe(403)
    expect(await languageOf('agent:builder')).toBeNull()
  })
})
