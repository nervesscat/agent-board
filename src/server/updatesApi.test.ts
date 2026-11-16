import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdates } from '#/lib/updates'

// The update routes through the whole API router in test mode, the way Playwright or CI drive it: who
// calls is X-Test-Actor. First as a board run from a checkout (no desktop app: no IPC channel), then
// under the app, its side of the IPC channel stood in for by `app` below, which answers as
// desktop/app/updates.mjs does and records what it was asked.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-updates-api-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let handle: (ctx: { request: Request; actor: string }) => Promise<Response>
let callerOf: typeof import('./auth').callerOf
let updates: typeof import('./updates')
beforeAll(async () => {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  handle = guard(({ request, actor }: { request: Request; actor: string }) => api.handle(request, actor))
  callerOf = (await import('./auth')).callerOf
  updates = await import('./updates')
})

async function call(method: string, pathname: string, testActor?: string, body?: unknown) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (testActor !== undefined) headers['x-test-actor'] = testActor
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const caller = await callerOf(request)
  return handle({ request, actor: caller!.name })
}

const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/updates'],
  ['POST', '/api/updates/check'],
  ['POST', '/api/updates/install'],
  ['PATCH', '/api/updates/settings', { autoCheck: false }],
]

const desktopState = (over: Partial<DesktopUpdates> = {}): DesktopUpdates => ({
  mode: 'desktop',
  installed: '0.2.0',
  packageType: 'deb',
  status: 'available',
  newest: { version: '0.3.0', notes: 'Fixes', notesMarkdown: 'Fixes', date: null },
  progress: null,
  error: null,
  manual: null,
  checkedAt: '2026-11-08T10:00:00.000Z',
  settings: { autoCheck: true, prereleases: false },
  ...over,
})

/** The app's end of the channel: the server's process.send lands here, its answers go back as messages. */
function fakeApp() {
  const asked: { op: string; body: unknown }[] = []
  const channel = new EventEmitter() as EventEmitter & {
    send: (message: unknown, callback?: (err: Error | null) => void) => boolean
  }
  let state = desktopState()
  channel.send = (message, callback) => {
    callback?.(null)
    const m = message as { channel: string; id: string; op: string; body?: unknown }
    asked.push({ op: m.op, body: m.body })
    queueMicrotask(() => {
      if (m.op === 'install' && state.status !== 'available') {
        channel.emit('message', {
          channel: m.channel,
          id: m.id,
          ok: false,
          status: 409,
          error: 'nothing to install',
        })
        return
      }
      if (m.op === 'install')
        state = desktopState({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0 } })
      if (m.op === 'settings') state = { ...state, settings: { ...state.settings, ...(m.body as object) } }
      channel.emit('message', { channel: m.channel, id: m.id, ok: true, state })
    })
    return true
  }
  return { channel, asked }
}

describe('the update routes on a board run from a checkout', () => {
  it('tell the human how a checkout updates, and have nothing to check or install', async () => {
    // With no channel to an app, nothing to wait for: the answer comes at once.
    const res = await Promise.race([
      call('GET', '/api/updates', 'human:qa'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it waited')), 500)),
    ])
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ mode: 'checkout' })
    for (const [method, route, body] of ROUTES.slice(1)) {
      const refused = await call(method, route, 'human:qa', body)
      expect(refused.status, route).toBe(409)
      expect((await refused.json()).error).toMatch(
        /runs from a checkout, which has no updater: git pull on main there, then pnpm start/,
      )
    }
  })

  it('refuse an agent every one of them, reading the state included', async () => {
    for (const [method, route, body] of ROUTES) {
      const res = await call(method, route, 'agent:builder', body)
      expect(res.status, route).toBe(403)
      expect((await res.json()).error, route).toMatch(/^only the human /)
    }
  })
})

describe('the update routes before the desktop app says hello', () => {
  it("wait for the hello, as the page's poll does when it reaches a restarted server first, then pass the app's answer on", async () => {
    const app = fakeApp()
    updates.listenForDesktop(app.channel)
    let answered = false
    const state = call('GET', '/api/updates', 'human:qa').then((res) => {
      answered = true
      return res
    })
    const check = call('POST', '/api/updates/check', 'human:qa')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(answered).toBe(false)
    expect(app.asked).toEqual([])
    app.channel.emit('message', { channel: updates.BRIDGE, hello: true })
    const res = await state
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(desktopState())
    expect((await check).status).toBe(200)
    expect(app.asked.map((a) => a.op).sort()).toEqual(['check', 'state'])
  })
})

describe('the update routes under the desktop app', () => {
  let app: ReturnType<typeof fakeApp>
  beforeAll(() => {
    app = fakeApp()
    updates.listenForDesktop(app.channel)
    app.channel.emit('message', { channel: updates.BRIDGE, hello: true })
  })

  it("pass the app's state to the human", async () => {
    const res = await call('GET', '/api/updates', 'human:qa')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(desktopState())
    expect(app.asked.at(-1)).toEqual({ op: 'state', body: undefined })
  })

  it('reach the app from another copy of the module, as the routes do in the built server', async () => {
    // The built server bundles the plugin that listens apart from the routes: two copies of updates.ts.
    vi.resetModules()
    const other = await import('./updates')
    expect(other).not.toBe(updates)
    expect(await other.updatesState()).toEqual(desktopState())
  })

  it('refuse an agent every one of them, and ask the app nothing for it: no install from an agent', async () => {
    const before = app.asked.length
    for (const [method, route, body] of ROUTES) {
      const res = await call(method, route, 'agent:builder', body)
      expect(res.status, route).toBe(403)
      expect((await res.json()).error, route).toMatch(/^only the human /)
    }
    expect(app.asked.length).toBe(before)
  })

  it('start a check and the install, and change the settings, for the human', async () => {
    expect(await (await call('POST', '/api/updates/check', 'human:qa')).json()).toMatchObject({
      status: 'available',
    })
    const settings = await call('PATCH', '/api/updates/settings', 'human:qa', { prereleases: true })
    expect(await settings.json()).toMatchObject({ settings: { autoCheck: true, prereleases: true } })
    const install = await call('POST', '/api/updates/install', 'human:qa')
    expect(install.status).toBe(200)
    expect(await install.json()).toMatchObject({ status: 'downloading' })
    expect(app.asked.slice(-3)).toEqual([
      { op: 'check', body: undefined },
      { op: 'settings', body: { prereleases: true } },
      { op: 'install', body: undefined },
    ])
  })

  it("pass the app's refusal on, and refuse settings that are not the two booleans (no password, nothing else)", async () => {
    const again = await call('POST', '/api/updates/install', 'human:qa')
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'nothing to install' })
    const before = app.asked.length
    for (const body of [{ password: 'x' }, { autoCheck: 'no' }]) {
      expect((await call('PATCH', '/api/updates/settings', 'human:qa', body)).status).toBe(400)
    }
    expect(app.asked.length).toBe(before)
  })
})
