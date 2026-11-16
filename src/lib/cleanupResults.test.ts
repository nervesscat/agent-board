import { describe, expect, it } from 'vitest'

import type { DeleteResult } from '#/lib/api'
import { countsOf, deleteResults, isDeleteResult, keptItems } from './cleanupResults'

const item = (over: Partial<DeleteResult> = {}): DeleteResult => ({
  ticketId: 12,
  branch: 'lane/47',
  kind: 'local',
  sha: 'a'.repeat(40),
  ok: true,
  outcome: 'deleted',
  reason: null,
  removed: [],
  unlinked: [],
  restore: [`git branch lane/47 ${'a'.repeat(40)}`],
  ...over,
})

describe('a cleanup delete’s job result', () => {
  it('counts what went, what was kept and what was already gone, as one line', () => {
    expect(countsOf([item(), item({ branch: 'other' })])).toEqual({
      deleted: 2,
      kept: 0,
      gone: 0,
      text: '2 deleted',
    })
    expect(
      countsOf([
        item(),
        item({ branch: 'moved', outcome: 'refused', ok: false, reason: 'moved since' }),
        item({ branch: 'broken', outcome: 'failed', ok: false, reason: 'git said no' }),
        item({ branch: 'gone', outcome: 'gone' }),
      ]),
    ).toEqual({ deleted: 1, kept: 2, gone: 1, text: '1 deleted, 2 kept, 1 already gone' })
  })

  it('reads a job’s result only when every entry is an outcome, else nothing', () => {
    expect(deleteResults([item(), item({ outcome: 'refused', ok: false })])).toHaveLength(2)
    expect(deleteResults([])).toEqual([])
    expect(deleteResults({ summary: 'not items' })).toBeNull()
    expect(deleteResults([item(), { branch: 'x' }])).toBeNull()
    expect(deleteResults(null)).toBeNull()
    expect(deleteResults('text')).toBeNull()
  })

  it('recognises an item by what it carries, and nothing else', () => {
    expect(isDeleteResult(item())).toBe(true)
    expect(isDeleteResult(item({ kind: 'remote' }))).toBe(true)
    expect(isDeleteResult({ ...item(), kind: 'everything' })).toBe(false)
    expect(isDeleteResult({ ...item(), outcome: 'maybe' })).toBe(false)
    expect(isDeleteResult({ ...item(), ok: 'yes' })).toBe(false)
    expect(isDeleteResult({ ...item(), ticketId: '12' })).toBe(false)
    expect(isDeleteResult({ ...item(), branch: undefined })).toBe(false)
    expect(isDeleteResult(null)).toBe(false)
  })

  it('retries the kept items and only them, exactly as they were asked', () => {
    const sha = 'b'.repeat(40)
    expect(
      keptItems([
        item(),
        item({ ticketId: 13, branch: 'kept/one', outcome: 'refused', ok: false, reason: 'moved since' }),
        item({
          ticketId: 14,
          branch: 'kept/tree',
          kind: 'worktrees',
          sha,
          worktrees: ['/tmp/wt-a', '/tmp/wt-b'],
          outcome: 'failed',
          ok: false,
          reason: 'the worktree has changes',
          removed: ['/tmp/wt-a'],
          restore: ['git worktree add /tmp/wt-a kept/tree'],
        }),
        item({ ticketId: 15, branch: 'gone', outcome: 'gone' }),
      ]),
    ).toEqual([
      { ticketId: 13, branch: 'kept/one', kind: 'local', sha: 'a'.repeat(40) },
      {
        ticketId: 14,
        branch: 'kept/tree',
        kind: 'worktrees',
        sha,
        worktrees: ['/tmp/wt-a', '/tmp/wt-b'],
      },
    ])
  })
})
