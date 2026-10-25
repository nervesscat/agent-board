import { describe, expect, it } from 'vitest'

import { type Who, chainOf, claimedShape, isBoardRecord, whoOf } from './roles'

const actors = new Map<string, Who>([
  ['enrique', { kind: 'human', role: 'human', parent: '' }],
  ['orch', { kind: 'agent', role: 'orchestrator', parent: '' }],
  ['orch/worker-2', { kind: 'agent', role: 'worker', parent: 'orch' }],
  ['legacy', { kind: 'agent', role: 'orchestrator', parent: '' }],
])
const who = (name: string) => whoOf(name, actors)

describe('whoOf', () => {
  it("reads a name the board saw from its actors row, as it stands now: an old post's author too", () => {
    expect(who('orch')).toEqual({ kind: 'agent', role: 'orchestrator', parent: '' })
    expect(who('enrique')).toEqual({ kind: 'human', role: 'human', parent: '' })
    // A name whose token the human made an orchestrator after it posted: the post shows it now.
    expect(who('legacy').role).toBe('orchestrator')
  })

  it('takes a name never seen that has a / for a worker under the name before the last /', () => {
    expect(who('ghost/a/b')).toEqual({ kind: 'agent', role: 'worker', parent: 'ghost/a' })
    expect(who('orch/never-seen')).toEqual({ kind: 'agent', role: 'worker', parent: 'orch' })
  })

  it('guesses any other unseen name by its name, as before', () => {
    expect(who('codex-review')).toEqual({ kind: 'agent', role: 'worker', parent: '' })
    expect(who('maria')).toEqual({ kind: 'human', role: 'human', parent: '' })
    // A leading / is no parent.
    expect(who('/odd')).toEqual({ kind: 'human', role: 'human', parent: '' })
  })

  it('reads `board` as the board itself, never a human, even when an actors row carries that name', () => {
    expect(who('board')).toEqual({ kind: 'board', role: 'board', parent: '' })
    const named = new Map<string, Who>([['board', { kind: 'human', role: 'human', parent: '' }]])
    expect(whoOf('board', named).role).toBe('board')
    expect(chainOf('board', who)).toBe('board (Board)')
  })
})

describe('chainOf', () => {
  it('names each link with its role, nearest first', () => {
    expect(chainOf('orch/worker-2', who)).toBe('orch/worker-2 (Agent) ← orch (Orchestrator)')
    expect(chainOf('orch/worker-2/helper', who)).toBe(
      'orch/worker-2/helper (Agent) ← orch/worker-2 (Agent) ← orch (Orchestrator)',
    )
    expect(chainOf('enrique', who)).toBe('enrique (Human)')
    expect(chainOf('claude', who)).toBe('claude (Agent)')
  })

  it('stops on a loop', () => {
    const loop = new Map<string, Who>([
      ['a', { kind: 'agent', role: 'worker', parent: 'b' }],
      ['b', { kind: 'agent', role: 'worker', parent: 'a' }],
    ])
    expect(chainOf('a', (n) => whoOf(n, loop))).toBe('a (Agent) ← b (Agent)')
  })
})

describe('isBoardRecord', () => {
  it("is the board's own only when the board recorded it, or no one did (an older event)", () => {
    expect(isBoardRecord('board', 'board')).toBe(true)
    expect(isBoardRecord('board', '')).toBe(true)
    expect(isBoardRecord('board', null)).toBe(true)
    // A worker's event under the board's name is a claim, not the board's.
    expect(isBoardRecord('board', 'claude')).toBe(false)
    expect(isBoardRecord('board', 'orch/builder-1')).toBe(false)
    // Another name is never the board's, whoever recorded it.
    expect(isBoardRecord('claude', 'board')).toBe(false)
    expect(isBoardRecord('claude', 'claude')).toBe(false)
  })

  it('agrees with how the record is shown: the Board badge exactly when it is the board’s own', () => {
    for (const by of ['board', '', null, 'claude', 'orch/builder-1'])
      expect(isBoardRecord('board', by)).toBe(claimedShape('board', by) === 'actor')
  })
})
