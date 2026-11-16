import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSummary } from '#/lib/api'
import type { StageKind } from './constants'
import {
  askingHuman,
  asksHuman,
  needKeys,
  recallDismissed,
  rememberDismissed,
  undismissed,
  type NeedsYou,
} from './needsYou'

type Decision = NeedsYou['decisions'][number]
type PrToReview = NeedsYou['prs'][number]
type Thread = NeedsYou['threads'][number]
type Review = NeedsYou['reviews'][number]
type BlockedTask = NeedsYou['blockedTasks'][number]
type InstructionChange = NeedsYou['instructionChanges'][number]
type Stalled = NeedsYou['stalled'][number]

const decision = (postId: number) => ({ postId }) as Decision
const pr = (id: number, updatedAt = '2026-01-01T00:00:00.000Z') => ({ id, updatedAt }) as PrToReview
const thread = (parentId: number, lastId: number, parentType: 'ticket' | 'update' = 'update') =>
  ({ parentType, parentId, last: { id: lastId } }) as Thread
const review = (id: number, updatedAt = '2026-01-01T00:00:00.000Z') => ({ id, updatedAt }) as Review
const blockedTask = (taskId: number) => ({ taskId }) as BlockedTask
const instructionChange = (changeId: number) => ({ changeId }) as InstructionChange
const stalled = (ticketId: number, lastSignalAt: string) => ({ ticketId, lastSignalAt }) as Stalled

/** A project summary holding exactly these entries: what the card reads, and nothing else. */
function project(needs: Partial<Omit<NeedsYou, 'total'>>): ProjectSummary {
  const lists = {
    decisions: [],
    humanWaits: [],
    prs: [],
    threads: [],
    reviews: [],
    blockedTasks: [],
    instructionChanges: [],
    stalled: [],
    ...needs,
  }
  const needsYou: NeedsYou = {
    ...lists,
    total: Object.values(lists).reduce((n, list) => n + list.length, 0),
  }
  return { needsYou } as unknown as ProjectSummary
}

const stored = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  })
  return store
}

afterEach(() => vi.unstubAllGlobals())

describe('the entries that ask the human', () => {
  const kindOf = (kinds: Record<number, StageKind | undefined>) => (ticketId: number) => kinds[ticketId]
  const entry = (ticketId: number | null) => ({ ticketId })

  it('keeps the active, review and blocked tickets’ entries, and drops open, done, cancelled and unknown ones', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7].map(entry)
    const lookup = kindOf({
      1: 'active',
      2: 'review',
      3: 'blocked',
      4: 'open',
      5: 'done',
      6: 'cancelled',
    })
    expect(askingHuman(entries, lookup).map((e) => e.ticketId)).toEqual([1, 2, 3])
    for (const kind of ['active', 'review', 'blocked'] as const) expect(asksHuman(kind)).toBe(true)
    for (const kind of ['open', 'done', 'cancelled'] as const) expect(asksHuman(kind)).toBe(false)
    expect(asksHuman(undefined)).toBe(false)
  })

  it('keeps an entry bound to no ticket, and one `keep` names whatever its ticket’s stage', () => {
    const archived = { ticketId: 9, archive: true }
    const entries = [entry(null), entry(9), archived]
    const lookup = kindOf({ 9: 'done' })
    expect(askingHuman(entries, lookup).map((e) => e.ticketId)).toEqual([null])
    expect(askingHuman(entries, lookup, (e) => 'archive' in e).map((e) => e.ticketId)).toEqual([null, 9])
  })
})

describe('the key of each Needs you entry', () => {
  it('names the entry, never its place in the list', () => {
    expect(needKeys.decision(decision(11))).toBe('decision:11')
    expect(needKeys.pr(pr(7))).toBe('pr:7:2026-01-01T00:00:00.000Z')
    expect(needKeys.thread(thread(5, 9))).toBe('thread:update:5:9')
    expect(needKeys.thread(thread(5, 9))).not.toBe(needKeys.thread(thread(5, 10)))
    expect(needKeys.review(review(42))).toBe('review:42:2026-01-01T00:00:00.000Z')
    expect(needKeys.blockedTask(blockedTask(1555))).toBe('blocked:1555')
    expect(needKeys.instructionChange(instructionChange(3))).toBe('instruction:3')
    expect(needKeys.stalled(stalled(42, '2026-01-02T03:04:05.000Z'))).toBe(
      'stalled:42:2026-01-02T03:04:05.000Z',
    )
  })
})

describe('what is hidden', () => {
  it('leaves out the entries already opened and counts only what is left', () => {
    const p = project({
      decisions: [decision(11)],
      threads: [thread(5, 9)],
      stalled: [stalled(42, '2026-01-02T03:04:05.000Z')],
    })
    const shown = undismissed(p, new Set([needKeys.decision(decision(11))]))
    expect(shown.needsYou.decisions).toEqual([])
    expect(shown.needsYou.threads).toHaveLength(1)
    expect(shown.needsYou.stalled).toHaveLength(1)
    expect(shown.needsYou.total).toBe(2)
    expect(p.needsYou.total).toBe(3)
  })

  it('keeps the same summary, and everything in it, when nothing matches', () => {
    const p = project({ decisions: [decision(11)] })
    expect(undismissed(p, new Set())).toBe(p)
    expect(undismissed(p, new Set(['decision:99']))).toBe(p)
  })

  it('hides each kind of entry on its own, whatever else is dismissed', () => {
    const p = project({
      prs: [pr(7)],
      threads: [thread(5, 9, 'ticket')],
      reviews: [review(42)],
      blockedTasks: [blockedTask(1556)],
      instructionChanges: [instructionChange(3)],
    })
    const all = new Set([
      needKeys.pr(pr(7)),
      needKeys.thread(thread(5, 9, 'ticket')),
      needKeys.review(review(42)),
      needKeys.blockedTask(blockedTask(1556)),
      needKeys.instructionChange(instructionChange(3)),
    ])
    const shown = undismissed(p, all).needsYou
    expect(shown).toEqual({
      decisions: [],
      humanWaits: [],
      prs: [],
      threads: [],
      reviews: [],
      blockedTasks: [],
      instructionChanges: [],
      stalled: [],
      total: 0,
    })
  })

  it('hides a human wait once it is opened, and shows it again when a newer one starts', () => {
    const p = project({
      humanWaits: [{ waitId: 8, since: '2026-01-02T03:04:05.000Z' } as NeedsYou['humanWaits'][number]],
    })
    const opened = new Set([needKeys.humanWait(p.needsYou.humanWaits[0]!)])
    expect(undismissed(p, opened).needsYou.humanWaits).toEqual([])
    expect(undismissed(p, opened).needsYou.total).toBe(0)
    const later = project({
      humanWaits: [{ waitId: 8, since: '2026-01-02T04:00:00.000Z' } as NeedsYou['humanWaits'][number]],
    })
    expect(undismissed(later, opened).needsYou.humanWaits).toHaveLength(1)
  })
})

describe('an entry comes back when its fact changes', () => {
  it('a new reply makes the thread ask again', () => {
    const before = project({ threads: [thread(5, 9)] })
    const dismissed = new Set([needKeys.thread(before.needsYou.threads[0]!)])
    const after = project({ threads: [thread(5, 10)] })
    expect(undismissed(before, dismissed).needsYou.threads).toHaveLength(0)
    expect(undismissed(after, dismissed).needsYou.threads).toHaveLength(1)
  })

  it('a new stall, a PR update and another review round show again', () => {
    const dismissed = new Set([
      needKeys.stalled(stalled(42, '2026-01-02T03:04:05.000Z')),
      needKeys.pr(pr(7, '2026-01-01T00:00:00.000Z')),
      needKeys.review(review(42, '2026-01-01T00:00:00.000Z')),
    ])
    const same = project({
      stalled: [stalled(42, '2026-01-02T03:04:05.000Z')],
      prs: [pr(7, '2026-01-01T00:00:00.000Z')],
      reviews: [review(42, '2026-01-01T00:00:00.000Z')],
    })
    expect(undismissed(same, dismissed).needsYou.total).toBe(0)

    const changed = project({
      stalled: [stalled(42, '2026-01-05T06:07:08.000Z')],
      prs: [pr(7, '2026-01-04T00:00:00.000Z')],
      reviews: [review(42, '2026-01-04T00:00:00.000Z')],
    })
    expect(undismissed(changed, dismissed).needsYou.total).toBe(3)
  })

  it('a decision stays hidden while it is the same card', () => {
    const dismissed = new Set([needKeys.decision(decision(11))])
    expect(undismissed(project({ decisions: [decision(11)] }), dismissed).needsYou.total).toBe(0)
    expect(undismissed(project({ decisions: [decision(12)] }), dismissed).needsYou.total).toBe(1)
  })
})

describe('what this browser remembers, per actor', () => {
  it('keeps each actor’s own entries apart', () => {
    const store = stored()
    rememberDismissed('enrique', 'decision:11')
    expect([...recallDismissed('enrique')]).toEqual(['decision:11'])
    expect([...recallDismissed('claude')]).toEqual([])
    expect([...store.keys()]).toEqual(['needs-you-dismissed:enrique'])
    rememberDismissed('claude', 'decision:12')
    expect([...recallDismissed('claude')]).toEqual(['decision:12'])
    expect([...recallDismissed('enrique')]).toEqual(['decision:11'])
  })

  it('does not remember one key twice, and keeps the newest entries', () => {
    stored()
    rememberDismissed('enrique', 'decision:11')
    expect([...rememberDismissed('enrique', 'decision:11')]).toEqual(['decision:11'])
    for (let i = 0; i < 250; i++) rememberDismissed('enrique', `decision:${1000 + i}`)
    const keys = recallDismissed('enrique')
    expect(keys.size).toBe(200)
    expect(keys.has('decision:11')).toBe(false)
    expect(keys.has('decision:1249')).toBe(true)
  })

  it('forgets nothing loudly when storage cannot be used, or holds junk', () => {
    const store = stored()
    store.set('needs-you-dismissed:enrique', 'not json')
    expect([...recallDismissed('enrique')]).toEqual([])
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect([...recallDismissed('enrique')]).toEqual([])
    expect(() => rememberDismissed('enrique', 'decision:11')).not.toThrow()
    expect([...rememberDismissed('enrique', 'decision:11')]).toEqual(['decision:11'])
  })
})
