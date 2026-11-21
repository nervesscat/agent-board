import { describe, expect, it } from 'vitest'

import { MAX_DONE, MAX_PETS, TITLE_LIMIT, elapsed, petsOf, phaseLabel } from './agentsAtWork'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const stage = { key: 'in_progress', name: 'In progress', kind: 'active' as const }

const live = (over: Record<string, unknown> = {}) =>
  ({
    ticketId: 1,
    title: 'Ship the importer',
    status: 'in_progress',
    stage,
    parent: null,
    agents: ['builder'],
    phase: 'build',
    round: null,
    lastHeardAt: minutesAgo(3),
    lastHeardBy: 'builder',
    silentMinutes: 3,
    waitingFor: null,
    stalled: false,
    ...over,
  }) as never
const quiet = (over: Record<string, unknown> = {}) =>
  ({
    ...(live() as object),
    lastSignalAt: minutesAgo(90),
    silentMinutes: 90,
    stalled: true,
    state: '',
    ...over,
  }) as never
const done = (over: Record<string, unknown> = {}) =>
  ({
    id: 9,
    title: 'Shipped',
    status: 'done',
    parent: null,
    assignee: 'builder',
    doneAt: minutesAgo(125),
    ...over,
  }) as never

const names = (r: ReturnType<typeof petsOf>) => r.pets.map((p) => `${p.ticketId}:${p.agent}:${p.state}`)

describe('petsOf', () => {
  it('makes one character per agent, with its ticket, phase and time since it was heard', () => {
    const { pets } = petsOf(
      { liveNow: [live({ agents: ['a', 'b'], round: null })], recentlyActive: [] },
      [],
      NOW,
    )
    expect(pets.map((p) => p.agent)).toEqual(['a', 'b'])
    expect(pets[0]).toMatchObject({
      ticketId: 1,
      short: '#1 Ship the importer',
      state: 'working',
      phase: 'Building',
      since: 'last heard 3 min ago',
      size: 'normal',
      label: '#1 Ship the importer — agent a, Building, last heard 3 min ago, working',
    })
  })

  it('words the phase, with the round, and falls back to the raw phase, or to Working', () => {
    expect(phaseLabel('review', 2)).toBe('Reviewing round 2')
    expect(phaseLabel('spec', null)).toBe('Specifying')
    expect(phaseLabel('ci', null)).toBe('CI')
    expect(phaseLabel('preview', null)).toBe('Previewing')
    expect(phaseLabel('odd', null)).toBe('odd')
    expect(phaseLabel(null, null)).toBe('')
    const { pets } = petsOf({ liveNow: [live({ phase: null, round: null })], recentlyActive: [] }, [], NOW)
    expect(pets[0]!.phase).toBe('Working')
  })

  it('keeps one character for a ticket with no agent name, and none for an empty list of tickets', () => {
    const r = petsOf({ liveNow: [live({ agents: [] })], recentlyActive: [] }, [], NOW)
    expect(r.pets).toHaveLength(1)
    expect(r.pets[0]!.agent).toBeNull()
    expect(r.pets[0]!.label).not.toContain('agent')
    expect(petsOf({ liveNow: [], recentlyActive: [] }, [], NOW)).toEqual({ pets: [], more: 0, live: 0 })
    expect(petsOf(undefined, [], NOW).pets).toEqual([])
  })

  it('cuts a long title but never the number', () => {
    const title = 'x'.repeat(80)
    const { pets } = petsOf({ liveNow: [live({ ticketId: 123, title })], recentlyActive: [] }, [], NOW)
    expect(pets[0]!.short.startsWith('#123 ')).toBe(true)
    expect(pets[0]!.short.length).toBe('#123 '.length + TITLE_LIMIT)
    expect(pets[0]!.short.endsWith('…')).toBe(true)
    expect(pets[0]!.label).toContain(title)
  })

  it('reads the state: an open wait or a blocked stage waits, a stalled ticket sleeps, the rest work', () => {
    const wait = { reason: 'human', note: 'which one?', agent: 'a', on: null, since: minutesAgo(5) }
    const r = petsOf(
      {
        liveNow: [
          live({ ticketId: 1 }),
          live({ ticketId: 2, waitingFor: wait }),
          // A waiting ticket stays waiting however long it has been quiet: the server decides stalled.
          live({ ticketId: 3, waitingFor: wait, silentMinutes: 500, lastHeardAt: minutesAgo(500) }),
          live({ ticketId: 4, stage: { key: 'b', name: 'Blocked', kind: 'blocked' } }),
          live({ ticketId: 6, silentMinutes: 500, lastHeardAt: minutesAgo(500) }),
        ],
        recentlyActive: [quiet({ ticketId: 5 }), quiet({ ticketId: 7, stalled: false })],
      },
      [],
      NOW,
    )
    expect(Object.fromEntries(r.pets.map((p) => [p.ticketId, p.state]))).toEqual({
      1: 'working',
      2: 'waiting',
      3: 'waiting',
      4: 'waiting',
      5: 'asleep',
      6: 'working',
    })
    expect(r.pets.find((p) => p.ticketId === 2)!.phase).toBe('Waiting: which one?')
    expect(r.pets.find((p) => p.ticketId === 4)!.phase).toBe('Blocked')
    expect(r.pets.find((p) => p.ticketId === 5)!.phase).toBe('Building, quiet')
  })

  it('orders waiting, working, asleep, done, ties by ticket then name, the same each time', () => {
    const wait = { reason: 'human', note: '', agent: 'a', on: null, since: minutesAgo(5) }
    const input = {
      liveNow: [
        live({ ticketId: 8, agents: ['z', 'a'] }),
        live({ ticketId: 4 }),
        live({ ticketId: 9, waitingFor: wait }),
      ],
      recentlyActive: [quiet({ ticketId: 2 })],
    }
    const first = names(petsOf(input, [done({ id: 20 })], NOW))
    expect(first).toEqual([
      '9:builder:waiting',
      '4:builder:working',
      '8:a:working',
      '8:z:working',
      '2:builder:asleep',
      '20:builder:done',
    ])
    expect(
      names(petsOf({ ...input, liveNow: [...input.liveNow].reverse() }, [done({ id: 20 })], NOW)),
    ).toEqual(first)
  })

  it('puts a subagent small, after its parent on the same ticket, and a lone one in its place', () => {
    const r = petsOf(
      {
        liveNow: [
          live({ ticketId: 1, agents: ['p/b', 'q', 'p', 'p/a'] }),
          live({ ticketId: 2, agents: ['x/y'] }),
        ],
        recentlyActive: [],
      },
      [],
      NOW,
    )
    expect(r.pets.map((p) => `${p.agent}:${p.size}`)).toEqual([
      'p:normal',
      'p/a:small',
      'p/b:small',
      'q:normal',
      'x/y:small',
    ])
  })

  it('does not repeat a name on a ticket', () => {
    const r = petsOf({ liveNow: [live({ agents: ['a', 'a'] })], recentlyActive: [] }, [], NOW)
    expect(r.pets).toHaveLength(1)
  })

  it('stops at the cap and counts the rest', () => {
    const liveNow = Array.from({ length: 15 }, (_, i) => live({ ticketId: i + 1 }))
    const r = petsOf({ liveNow, recentlyActive: [] }, [], NOW)
    expect(r.pets).toHaveLength(MAX_PETS)
    expect(r.more).toBe(3)
    expect(r.live).toBe(15)
    expect(r.pets[0]!.ticketId).toBe(1)
  })

  it('shows up to three finished tickets, by the assignee, after the live ones', () => {
    const tickets = [1, 2, 3, 4].map((id) => done({ id: 100 + id, assignee: id === 2 ? '' : 'builder' }))
    const r = petsOf({ liveNow: [live()], recentlyActive: [] }, tickets, NOW)
    const finished = r.pets.filter((p) => p.state === 'done')
    expect(finished).toHaveLength(MAX_DONE)
    expect(finished[1]!.agent).toBeNull()
    expect(finished[0]!.label).toBe('#101 Shipped — agent builder, done today, finished 2 h ago')
    expect(r.pets[0]!.state).toBe('working')
    expect(r.live).toBe(1)
  })

  it('reads the time only from the clock it is given', () => {
    expect(elapsed(minutesAgo(0), NOW)).toBe('just now')
    expect(elapsed(minutesAgo(3), NOW)).toBe('3 min')
    expect(elapsed(minutesAgo(125), NOW)).toBe('2 h')
    expect(elapsed(minutesAgo(3000), NOW)).toBe('2 d')
    // A server time a little ahead of this clock is not negative.
    expect(elapsed(minutesAgo(-2), NOW)).toBe('just now')
    const r = petsOf({ liveNow: [live({ lastHeardAt: minutesAgo(0) })], recentlyActive: [] }, [], NOW)
    expect(r.pets[0]!.since).toBe('last heard just now')
  })
})
