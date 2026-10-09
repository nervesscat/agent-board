import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let prs: typeof import('./prs')
beforeAll(async () => {
  prs = await import('./prs')
})

describe('localPath', () => {
  it('maps Windows drive paths into WSL, leaves everything else alone', async () => {
    const { localPath } = await import('./uploads')
    expect(localPath('C:\\Users\\me\\shot.png', 'linux')).toBe('/mnt/c/Users/me/shot.png')
    expect(localPath('F:/work/a b/rec.mp4', 'linux')).toBe('/mnt/f/work/a b/rec.mp4')
    expect(localPath('/home/me/shot.png', 'linux')).toBe('/home/me/shot.png')
    expect(localPath('C:\\Users\\me\\shot.png', 'win32')).toBe('C:\\Users\\me\\shot.png')
  })
})

describe('actors', () => {
  it('remembers how each name signed in; the last sign-in wins; built-ins fill the gaps', async () => {
    const { listActors, noteActor } = await import('./actors')
    noteActor('claude-spark', 'agent')
    noteActor('laptop', 'human')
    noteActor('laptop', 'human')
    const kinds = new Map(listActors().map((a) => [a.name, a.kind]))
    expect(kinds.get('claude-spark')).toBe('agent')
    expect(kinds.get('laptop')).toBe('human')
    expect(kinds.get('claude')).toBe('agent')
    noteActor('laptop', 'agent')
    expect(new Map(listActors().map((a) => [a.name, a.kind])).get('laptop')).toBe('agent')
  })
})

describe('prStatus', () => {
  it('merged is done, held or not; then hold wins over the review stage', () => {
    const st = (mergedAt: string | null, hold: boolean, reviewStage: 'pending' | 'reviewed' | 'on_hold') =>
      prs.prStatus({ mergedAt, hold, reviewStage })
    expect(st('2026-10-01T10:00:00Z', true, 'pending')).toBe('done')
    expect(st('2026-10-01T10:00:00Z', false, 'reviewed')).toBe('done')
    expect(st(null, true, 'reviewed')).toBe('on_hold')
    expect(st(null, false, 'reviewed')).toBe('reviewed')
    expect(st(null, false, 'on_hold')).toBe('on_hold')
    expect(st(null, false, 'pending')).toBe('pending')
  })
})
