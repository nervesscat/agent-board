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
