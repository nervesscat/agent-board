import { describe, expect, it } from 'vitest'

import {
  inQueue,
  inReviewer,
  onSide,
  PR_FILTERS,
  PR_REVIEWERS,
  PR_STAGES,
  stageCount,
  waitingCount,
  WAITING_STAGES,
  type PrFilter,
  type PrStage,
  type QueueRow,
} from './prQueue'

/** A queue row: its side, its stage, and whether GitHub still asks me to review it. */
const row = (waitingOn: PrFilter, status: PrStage, requested = false): QueueRow => ({
  waitingOn,
  status,
  requested,
})

/**
 * A queue with every stage on both sides, and requested and not mixed: To review has two pending
 * (one requested), one on hold (requested), one reviewed and one done (both requested); Waiting on
 * others has one pending, one on hold, two reviewed and one done.
 */
const queue: QueueRow[] = [
  row('me', 'pending', true),
  row('me', 'pending'),
  row('me', 'on_hold', true),
  row('me', 'reviewed', true),
  row('me', 'done', true),
  row('others', 'pending'),
  row('others', 'on_hold'),
  row('others', 'reviewed'),
  row('others', 'reviewed'),
  row('others', 'done'),
]

describe('the PR queue filters', () => {
  it('puts each PR on its side of the queue', () => {
    expect(queue.filter((r) => onSide(r, 'me'))).toHaveLength(5)
    expect(queue.filter((r) => onSide(r, 'others'))).toHaveLength(5)
  })

  it('shows every PR of the side with All PRs, and only the requested ones with Just me as reviewer', () => {
    expect(queue.every((r) => inReviewer(r, 'all'))).toBe(true)
    expect(queue.filter((r) => inReviewer(r, 'mine')).map((r) => r.status)).toEqual([
      'pending',
      'on_hold',
      'reviewed',
      'done',
    ])
  })

  it('narrows only To review by the switch: Waiting on others shows every row of its side', () => {
    for (const r of queue)
      expect(inQueue(r, 'others', 'mine'), `${r.status} ${r.requested}`).toBe(onSide(r, 'others'))
    expect(queue.filter((r) => inQueue(r, 'me', 'all'))).toHaveLength(5)
    expect(queue.filter((r) => inQueue(r, 'me', 'mine'))).toHaveLength(4)
    expect(queue.filter((r) => inQueue(r, 'me', 'mine'))).not.toContainEqual(row('me', 'pending'))
  })
})

describe('the PR queue counters', () => {
  it('counts only pending and on hold rows, the stages that still wait on someone', () => {
    expect(WAITING_STAGES).toEqual(['pending', 'on_hold'])
    // To review: two pending + one on hold; its reviewed and done rows are listed but not counted.
    expect(waitingCount(queue, 'me', 'all')).toBe(3)
    // Waiting on others: one pending + one on hold.
    expect(waitingCount(queue, 'others', 'all')).toBe(2)
  })

  it('counts nothing when the filter has no such row, whatever its other stages hold', () => {
    expect(waitingCount([row('me', 'reviewed'), row('me', 'done')], 'me', 'all')).toBe(0)
    expect(waitingCount([row('others', 'done')], 'others', 'all')).toBe(0)
    expect(waitingCount([], 'me', 'all')).toBe(0)
  })

  it("follows the switch on To review: the counter counts the narrowed list's waiting rows", () => {
    expect(waitingCount(queue, 'me', 'mine')).toBe(2)
    const narrowed = queue.filter((r) => inQueue(r, 'me', 'mine'))
    expect(waitingCount(narrowed, 'me', 'all')).toBe(2)
  })

  it("is the sum of the tab's Pending and On hold chips, under the switch and the stage shown", () => {
    for (const filter of PR_FILTERS)
      for (const reviewer of PR_REVIEWERS) {
        // Every stage shown in turn: the counter does not depend on which one, and always adds up.
        for (const _stage of PR_STAGES) {
          const at = `${filter} ${reviewer} ${_stage}`
          expect(waitingCount(queue, filter, reviewer), at).toBe(
            stageCount(queue, filter, reviewer, 'pending') + stageCount(queue, filter, reviewer, 'on_hold'),
          )
        }
      }
  })

  it('counts each stage over the list the filter shows, the switch included', () => {
    expect(PR_STAGES.map((s) => stageCount(queue, 'me', 'all', s))).toEqual([2, 1, 1, 1])
    expect(PR_STAGES.map((s) => stageCount(queue, 'me', 'mine', s))).toEqual([1, 1, 1, 1])
    expect(PR_STAGES.map((s) => stageCount(queue, 'others', 'mine', s))).toEqual([1, 2, 1, 1])
  })

  it('leaves every stage empty with none requested, as the empty text says', () => {
    const none = [row('me', 'pending'), row('me', 'on_hold')]
    expect(PR_STAGES.map((s) => stageCount(none, 'me', 'mine', s))).toEqual([0, 0, 0, 0])
    expect(waitingCount(none, 'me', 'mine')).toBe(0)
  })
})
