import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { GhPr } from './git'

// gh answers from fixtures: each `gh pr list` call is recorded, and answered by `answer`.
let calls: string[][] = []
let answer: (args: string[]) => GhPr[] = () => []
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push(args)
    try {
      cb(null, { stdout: JSON.stringify(answer(args)), stderr: '' })
    } catch (err) {
      cb(err as Error)
    }
  },
}))

let listMyPrs: typeof import('./git').listMyPrs
beforeAll(async () => {
  listMyPrs = (await import('./git')).listMyPrs
})

const pr = (number: number, mergedAt: string | null = null) => ({ number, mergedAt }) as GhPr
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]

describe('listMyPrs', () => {
  it('searches my PRs and the ones I review, open and recently merged, each search bounded', async () => {
    calls = []
    answer = () => []
    await listMyPrs('/r/app', { mergedSince: '2026-09-22' })
    const searches = calls.map((a) => `${flag(a, '--state')} ${flag(a, '--limit')} ${flag(a, '--search')}`)
    expect(searches.sort()).toEqual(
      [
        'open 100 author:@me',
        'open 100 review-requested:@me',
        'open 100 reviewed-by:@me',
        'open 100 assignee:@me',
        'merged 30 author:@me merged:>=2026-09-22',
        'merged 30 review-requested:@me merged:>=2026-09-22',
        'merged 30 reviewed-by:@me merged:>=2026-09-22',
        'merged 30 assignee:@me merged:>=2026-09-22',
      ].sort(),
    )
    for (const a of calls) expect(flag(a, '--json')).toContain('mergedAt')
    for (const a of calls) expect(flag(a, '--json')).toContain('reviewRequests')
  })

  it('merges what the searches found, with the searches that found each', async () => {
    answer = (args) => {
      const search = flag(args, '--search')!
      if (search === 'author:@me') return [pr(1)]
      if (search === 'review-requested:@me') return [pr(2)]
      if (search === 'assignee:@me') return [pr(1), pr(3)]
      if (search.startsWith('reviewed-by:@me merged')) return [pr(4, '2026-10-01T10:00:00Z')]
      return []
    }
    const found = await listMyPrs('/r/app', { mergedSince: '2026-09-22' })
    expect(found.map((p) => [p.number, p.requested, p.assigned, p.mergedAt])).toEqual([
      [1, false, true, null],
      [2, true, false, null],
      [3, false, true, null],
      [4, false, false, '2026-10-01T10:00:00Z'],
    ])
  })

  it('fails as a whole when a merged search fails, so the refresh counts the repo as failed', async () => {
    answer = (args) => {
      if (flag(args, '--state') === 'merged') throw new Error('gh: merged search failed')
      return [pr(1)]
    }
    await expect(listMyPrs('/r/app', { mergedSince: '2026-09-22' })).rejects.toThrow('merged search failed')
  })
})

describe('folderGone', () => {
  // A spawn Node could not start in its cwd: Windows says ENOENT for any folder it cannot use.
  const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
  let tmp: string
  let folderGone: typeof import('./git').folderGone
  beforeAll(async () => {
    folderGone = (await import('./git')).folderGone
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-folder-gone-'))
  })

  it('says a missing folder does not exist', () => {
    const gone = path.join(tmp, 'gone')
    expect(folderGone(enoent, gone)?.message).toBe(
      `${gone} does not exist: the repo's folder was moved or deleted`,
    )
    expect(folderGone(enoent, gone)?.status).toBe(409)
  })

  it('says a file at the repo path is not a folder, on any platform', () => {
    const file = path.join(tmp, 'a-file')
    fs.writeFileSync(file, '')
    for (const code of ['ENOENT', 'ENOTDIR'])
      expect(folderGone({ ...enoent, code }, file)?.message).toBe(
        `${file} is not a folder: the repo's path names a file, not its checkout`,
      )
    // A folder under that file does not exist.
    expect(folderGone(enoent, path.join(file, 'below'))?.message).toMatch(/does not exist/)
  })

  it('says a folder too long for Windows to start a program in is too long, and only on Windows', async () => {
    const { cwdTooLong } = await import('./git')
    const fits = 'C:\\' + 'x'.repeat(255)
    expect(cwdTooLong(fits, 'win32')).toBeNull()
    expect(cwdTooLong(fits + 'x', 'win32')?.message).toMatch(
      /is too long a path for Windows to run git or gh in \(over 258 characters\): move the checkout/,
    )
    expect(cwdTooLong('/' + 'x'.repeat(400), 'linux')).toBeNull()
  })

  it('leaves a usable folder and any other failure alone', () => {
    expect(folderGone(enoent, tmp)).toBeNull()
    expect(folderGone(new Error('fatal: not a git repository'), path.join(tmp, 'gone'))).toBeNull()
    expect(folderGone({ code: 'ENOENT', syscall: 'open' }, path.join(tmp, 'gone'))).toBeNull()
  })
})
