import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

// A preview's links and the guard follow the entrance this board serves now: one saved in Settings applies
// without a restart, and clearing it removes it. The entrance is saved as tailnetEntrance.ts saves it (the
// settings row, then the served entrance reset); the Tailscale check that a save also makes is not run here.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-preview-entrance-')))
const ENV_KEYS = ['DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH', 'BOARD_ENV', 'TAILSCALE_BIN'] as const
const envBefore = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.DATA_DIR = path.join(tmp, 'data')
delete process.env.PUBLIC_ORIGIN
delete process.env.AUTH
delete process.env.BOARD_ENV
// No Tailscale here: the clear reads its state for the answer it gives, and that answer is not under test.
process.env.TAILSCALE_BIN = path.join(tmp, 'no-tailscale')

const link = await import('./previewLink')
const config = await import('./config')
const entrance = await import('./tailnetEntrance')
const entranceGuard = await import('./entrance')
const { db, schema } = await import('#/db')

const NAME = 'devbox.example-tailnet.ts.net'
const ORIGIN = `https://${NAME}`
const running = { workspaceId: 3, runId: 9, runType: 'preview', status: 'running', port: 47101 }

/** A save as Settings makes it, minus the Tailscale check: the row, then the served entrance read again. */
function saveRow(origin: string) {
  db.delete(schema.settings).run()
  db.insert(schema.settings).values({ key: 'tailnetEntrance', value: { origin } }).run()
  config.resetServedEntrance()
}

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key]
    else process.env[key] = envBefore[key]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a preview link follows the entrance Settings saved, live', () => {
  it('gives no remoteUrl while no entrance is saved', () => {
    db.delete(schema.settings).run()
    config.resetServedEntrance()
    expect(link.previewLinksOf(running)).toEqual({ proxyUrl: 'http://localhost:47100/p/3/9/' })
  })

  it('gives the proxied remoteUrl on the saved entrance, with no restart', () => {
    saveRow(ORIGIN)
    expect(link.previewLinksOf(running)).toEqual({
      proxyUrl: 'http://localhost:47100/p/3/9/',
      remoteUrl: `${ORIGIN}/p/3/9/`,
    })
  })

  it('removes remoteUrl when the entrance is cleared, with no restart', async () => {
    saveRow(ORIGIN)
    expect(link.previewLinksOf(running)?.remoteUrl).toBe(`${ORIGIN}/p/3/9/`)
    await entrance.setEntrance(null, 'Enrique')
    expect(link.previewLinksOf(running)).toEqual({ proxyUrl: 'http://localhost:47100/p/3/9/' })
  })

  it('gives no links at all for a preview that is not running, with the entrance saved', () => {
    saveRow(ORIGIN)
    expect(link.previewLinksOf({ ...running, status: 'stopped' })).toBeNull()
    db.delete(schema.settings).run()
    config.resetServedEntrance()
  })
})

describe('the guard follows the saved entrance too', () => {
  const request = (host: string) => new Request(`http://${host}/p/3/9/`, { method: 'GET', headers: { host } })

  it('admits the saved host through the entrance, and refuses it once cleared', async () => {
    saveRow(ORIGIN)
    const verdict = entranceGuard.guardBoardRequest(request(NAME), config.authMode(), config.servedEntrance())
    expect(verdict).toEqual({ allow: true, entrance: config.servedEntrance() })
    await entrance.setEntrance(null, 'Enrique')
    const after = entranceGuard.guardBoardRequest(request(NAME), config.authMode(), config.servedEntrance())
    expect(after.allow).toBe(false)
  })
})
