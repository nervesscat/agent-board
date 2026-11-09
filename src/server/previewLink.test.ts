import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

// The database opens at import: point DATA_DIR at a throwaway directory first.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

const link = await import('./previewLink')
const { db, schema } = await import('#/db')

const RUNNING_AT = '2026-11-09T09:59:00.000Z'
const NOW = Date.parse('2026-11-09T10:00:00.000Z')

describe('the link secret', () => {
  it('is made once, kept in the settings table, and the same on every read', () => {
    const first = link.linkSecret()
    expect(first.length).toBe(32)
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, link.PREVIEW_LINK_KEY)).get()
    expect(typeof row?.value).toBe('string')
    expect(Buffer.from(row!.value as string, 'base64url').equals(first)).toBe(true)
    expect(link.linkSecret().equals(first)).toBe(true)
  })
})

describe('minted links', () => {
  it('open the run path with the value in ?pl=, valid for five minutes', () => {
    const minted = link.mintPreviewLink(3, 9, RUNNING_AT, 't4', NOW)
    expect(minted.url).toMatch(/^\/p\/3\/9\/\?pl=v1\.\d+\.t4\.[A-Za-z0-9_-]+$/)
    expect(Date.parse(minted.expiresAt)).toBe(NOW + link.PREVIEW_LINK_TTL_MS)
    const value = minted.url.split('pl=')[1]!
    expect(link.verifyPreviewValue(value, 3, 9, RUNNING_AT, NOW)).toBe('t4')
    expect(link.verifyPreviewValue(value, 3, 9, RUNNING_AT, NOW + link.PREVIEW_LINK_TTL_MS - 1)).toBe('t4')
    expect(link.verifyPreviewValue(value, 3, 9, RUNNING_AT, NOW + link.PREVIEW_LINK_TTL_MS)).toBeNull()
  })

  it('verify only for the workspace, the run, and the start it was made for', () => {
    const value = link.signPreviewValue(3, 9, RUNNING_AT, 's1', NOW + 60_000)
    expect(link.verifyPreviewValue(value, 3, 9, RUNNING_AT, NOW)).toBe('s1')
    expect(link.verifyPreviewValue(value, 4, 9, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue(value, 3, 10, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue(value, 3, 9, '2026-11-09T09:00:00.000Z', NOW)).toBeNull()
    expect(link.verifyPreviewValue(value, 3, 9, null, NOW)).toBeNull()
  })

  it('refuse a value that was tampered with, reshaped, or missing', () => {
    const value = link.signPreviewValue(3, 9, RUNNING_AT, 't4', NOW + 60_000)
    const [v, exp, principal, mac] = value.split('.')
    expect(link.verifyPreviewValue(`${v}.${exp}.t5.${mac}`, 3, 9, RUNNING_AT, NOW)).toBeNull()
    expect(
      link.verifyPreviewValue(`${v}.${Number(exp) + 600}.${principal}.${mac}`, 3, 9, RUNNING_AT, NOW),
    ).toBeNull()
    expect(link.verifyPreviewValue(`${v}.${exp}.${principal}.AAAA`, 3, 9, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue(`v2.${exp}.${principal}.${mac}`, 3, 9, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue('v1.x.t4.y', 3, 9, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue('', 3, 9, RUNNING_AT, NOW)).toBeNull()
    expect(link.verifyPreviewValue(null, 3, 9, RUNNING_AT, NOW)).toBeNull()
  })

  it('carry no secret in the clear: the value is the principal and an expiry, and a mac', () => {
    const value = link.signPreviewValue(3, 9, RUNNING_AT, 't4', NOW + 60_000)
    expect(value.split('.')).toHaveLength(4)
    expect(value).not.toContain(link.linkSecret().toString('base64url'))
  })
})

describe('the links a running preview is listed with', () => {
  const running = {
    workspaceId: 3,
    runId: 9,
    runType: 'preview',
    status: 'running',
    port: 47101,
  }

  it('gives the proxied path on this machine for a running preview', () => {
    expect(link.previewLinksOf(running)).toEqual({ proxyUrl: 'http://localhost:47100/p/3/9/' })
  })

  it('gives nothing for a preview that is not running, a job, or one with no port', () => {
    expect(link.previewLinksOf({ ...running, status: 'stopped' })).toBeNull()
    expect(link.previewLinksOf({ ...running, status: 'building' })).toBeNull()
    expect(link.previewLinksOf({ ...running, runType: 'job' })).toBeNull()
    expect(link.previewLinksOf({ ...running, port: null })).toBeNull()
  })

  it('names the path the cookie and the proxy use', () => {
    expect(link.previewPathOf(3, 9)).toBe('/p/3/9/')
    expect(link.previewCookieName(3, 9)).toBe('board_preview_3_9')
  })
})
