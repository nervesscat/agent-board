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
  it('hold wins, then any review of mine, else pending', () => {
    expect(prs.prStatus({ hold: true, myReview: 'approved' })).toBe('on_hold')
    expect(prs.prStatus({ hold: false, myReview: 'approved' })).toBe('reviewed')
    expect(prs.prStatus({ hold: false, myReview: 'commented' })).toBe('reviewed')
    expect(prs.prStatus({ hold: false, myReview: 'none' })).toBe('pending')
  })
})
