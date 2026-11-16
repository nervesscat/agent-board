import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { LastHeard, Liveness, TimelineSpan, TimelineWait, WorkTotals } from '#/lib/workTimeline'

import { clock } from './format'

import {
  currentActivity,
  lastHeard,
  lastWord,
  livenessLines,
  lostContact,
  measureOffset,
  onServerClock,
  stallReason,
  workDuration,
  parseWorkStates,
  stateMatches,
  workLine,
  workShares,
  WORK_LINE_STATES,
  type WorkTimelineLike,
} from './workStatus'
import type { TimelineStage } from './workTimeline'

const at = (hhmm: string) => `2026-10-20T${hhmm}:00.000Z`
const NOW = Date.parse(at('12:30'))
const ZERO: WorkTotals = { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 }

const span = (more: Partial<TimelineSpan>): TimelineSpan => ({
  id: 1,
  phase: 'build',
  round: null,
  agent: 'builder',
  by: 'builder',
  start: at('12:00'),
  end: at('12:30'),
  open: true,
  ...more,
})

const wait = (more: Partial<TimelineWait>): TimelineWait => ({
  id: 2,
  reason: 'lock',
  agent: '',
  on: null,
  note: '',
  start: at('12:10'),
  end: at('12:30'),
  open: true,
  ...more,
})

const timeline = (more: Partial<WorkTimelineLike> = {}): WorkTimelineLike => ({
  spans: [],
  waits: [],
  totals: ZERO,
  stalled: null,
  live: true,
  start: at('12:00'),
  end: at('12:30'),
  lastHeard: null,
  lastWordAt: null,
  ...more,
})

const stage = (kind: TimelineStage['kind'], since = at('12:00')): TimelineStage => ({
  key: kind === 'review' ? 'review' : kind === 'blocked' ? 'blocked' : 'in_progress',
  kind,
  since,
})

const MINUTE = 60_000
/** A state's liveness, for the work-line fixtures: only the fields the line reads. */
const liveness = (more: Partial<Liveness> = {}): Liveness => ({
  state: 'working',
  agent: 'claude',
  phase: 'build',
  since: at('11:44'),
  lastSignalAt: at('12:28'),
  lastWordAt: at('12:18'),
  silentMinutes: 10,
  spans: [
    { phase: 'build', agent: 'claude', since: at('11:44'), lastWordAt: at('12:18'), silentMinutes: 10 },
  ],
  ...more,
})

const heard = (more: Partial<LastHeard> = {}): LastHeard => ({
  at: at('12:23'),
  agent: 'claude/builder-1',
  by: 'claude',
  kind: 'heartbeat',
  phase: 'build',
  reason: '',
  note: 'builder adding paged tags endpoint',
  ...more,
})

const stall = (since: string, minutes = 33) => ({
  since,
  minutes,
  lastAgent: 'builder',
  lastBy: 'builder',
  lastFrom: 'event' as const,
})

describe('currentActivity', () => {
  it('reads a wait delegated to an agent, inside an open build span, as building', () => {
    const t = timeline({
      spans: [span({ start: at('11:47') })],
      waits: [wait({ on: 'builder', reason: 'delegate', agent: 'orch', start: at('11:47') })],
    })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'building',
      verb: 'Building',
      phase: 'build',
      agent: 'builder',
      since: at('11:47'),
      ms: 43 * 60_000,
    })
  })

  it('names an open human wait as waiting on you, since when', () => {
    const t = timeline({ waits: [wait({ reason: 'human', start: at('12:09') })] })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'waiting-human',
      reason: 'human',
      since: at('12:09'),
      ms: 21 * 60_000,
    })
  })

  it('gives the earliest open human wait, the longest one', () => {
    const t = timeline({
      waits: [
        wait({ id: 3, reason: 'human', start: at('12:20') }),
        wait({ id: 4, reason: 'human', start: at('12:09') }),
      ],
    })
    expect(currentActivity(t, NOW)).toMatchObject({ kind: 'waiting-human', since: at('12:09') })
  })

  it('reads a human wait that names an agent as waiting on you, not as the agent building', () => {
    const t = timeline({
      spans: [span({})],
      waits: [wait({ reason: 'human', on: 'builder', start: at('12:09') })],
    })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'waiting-human',
      reason: 'human',
      since: at('12:09'),
      ms: 21 * 60_000,
    })
  })

  it('never shows negative time when the clock is behind the span it reads', () => {
    const t = timeline({ spans: [span({ start: at('12:40') })] })
    const a = currentActivity(t, NOW)
    expect(a).toMatchObject({ kind: 'building', ms: 0 })
  })

  it('says nothing is open when no span or wait is', () => {
    expect(currentActivity(timeline(), NOW)).toEqual({ kind: 'nothing' })
  })

  it('says nothing is open on a ticket that is not live, even with a span left open', () => {
    expect(currentActivity(timeline({ live: false, spans: [span({})] }), NOW)).toEqual({ kind: 'nothing' })
  })

  it('reads an open wait with no span as waiting on its agent', () => {
    const t = timeline({ waits: [wait({ agent: 'builder', reason: 'lock', start: at('12:00') })] })
    expect(currentActivity(t, NOW)).toEqual({
      kind: 'waiting-agent',
      agent: 'builder',
      reason: 'lock',
      since: at('12:00'),
      ms: 30 * 60_000,
    })
  })

  it('reads the latest open span as building, and a non-build phase by its verb', () => {
    const t = timeline({
      spans: [
        span({ id: 5, phase: 'review', agent: 'old', start: at('12:00') }),
        span({ id: 6, phase: 'verify', agent: 'new', start: at('12:20') }),
      ],
    })
    expect(currentActivity(t, NOW)).toMatchObject({ kind: 'building', verb: 'Verifying', agent: 'new' })
  })

  it('reads no events at all as nothing open', () => {
    expect(currentActivity(timeline({ start: null, end: null }), NOW)).toEqual({ kind: 'nothing' })
  })
})

describe('lastHeard', () => {
  it('gives the agent, what it said and when', () => {
    expect(lastHeard(timeline({ lastHeard: heard() }))).toEqual({
      at: at('12:23'),
      agent: 'claude/builder-1',
      by: 'claude',
      summary: 'builder adding paged tags endpoint',
    })
  })

  it('falls back to the reason, then the phase, when there is no note', () => {
    expect(lastHeard(timeline({ lastHeard: heard({ note: '', reason: 'run returned' }) }))?.summary).toBe(
      'run returned',
    )
    expect(lastHeard(timeline({ lastHeard: heard({ note: '', reason: '' }) }))?.summary).toBe('build')
  })

  it('keeps an empty agent empty, so the line gives the time only', () => {
    expect(lastHeard(timeline({ lastHeard: heard({ agent: '' }) }))?.agent).toBe('')
  })

  it('is null when no agent event exists, even while a delegated build is open', () => {
    expect(lastHeard(timeline({ lastHeard: null }))).toBeNull()
    expect(lastHeard(timeline({ spans: [span({})], waits: [wait({ on: 'builder' })] }))).toBeNull()
  })
})

describe('per-agent liveness lines', () => {
  const liveness: Liveness = {
    state: 'working',
    agent: 'claude',
    phase: 'build',
    since: at('11:47'),
    lastSignalAt: at('12:10'),
    lastWordAt: at('12:10'),
    silentMinutes: 20,
    spans: [
      { phase: 'build', agent: 'claude', since: at('11:47'), lastWordAt: at('12:10'), silentMinutes: 20 },
      { phase: 'review', agent: 'codex', since: at('12:00'), lastWordAt: at('12:20'), silentMinutes: 10 },
    ],
  }

  it('gives every open span its own agent, phase, time and last word', () => {
    expect(livenessLines(liveness, NOW)).toEqual([
      'claude · build · 43 min · last word 20 min ago',
      'codex · review · 30 min · last word 10 min ago',
    ])
    // A lost run's detail opens with the agent too: the state word is the line above it.
    expect(livenessLines({ ...liveness, state: 'lost' }, NOW)).toEqual([
      'claude · build · 43 min · last word 20 min ago',
      'codex · review · 30 min · last word 10 min ago',
    ])
  })

  it("reads the ticket's last word and how many minutes ago", () => {
    expect(lastWord({ ...timeline(), liveness }, NOW)).toEqual({
      at: at('12:10'),
      agent: 'claude',
      minutes: 20,
    })
  })
})

describe('stallReason', () => {
  it('is null when the ticket is not stalled', () => {
    expect(stallReason(timeline())).toBeNull()
  })

  it('says nothing is open since the last closed span ended, quoting its event when it is the last one', () => {
    const t = timeline({
      stalled: stall(at('12:08')),
      spans: [span({ start: at('11:50'), end: at('12:08'), open: false })],
      lastHeard: heard({ at: at('12:08'), reason: 'run returned before the builder reported', note: '' }),
    })
    expect(stallReason(t)).toEqual({
      kind: 'nothing-open',
      since: at('12:08'),
      endedAt: at('12:08'),
      phase: 'build',
      quote: 'run returned before the builder reported',
      stage: null,
    })
  })

  it('does not quote an event that is not the closing one', () => {
    const t = timeline({
      stalled: stall(at('12:08')),
      spans: [span({ end: at('12:08'), open: false })],
      lastHeard: heard({ at: at('12:05'), reason: 'other' }),
    })
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open', quote: '' })
  })

  it('says who a stalled open wait is on, since when', () => {
    const t = timeline({
      stalled: stall(at('12:02')),
      waits: [wait({ on: 'builder', reason: 'delegate', start: at('12:00') })],
    })
    expect(stallReason(t)).toEqual({
      kind: 'waiting',
      on: 'builder',
      reason: 'delegate',
      since: at('12:02'),
      stage: null,
    })
  })

  it('says the stage when the active stage is not the default one', () => {
    const t = timeline({ stalled: stall(at('12:08')), spans: [span({ end: at('12:08'), open: false })] })
    expect(stallReason(t, 'Bug Found')).toMatchObject({ kind: 'nothing-open', stage: 'Bug Found' })
  })

  it('never names an open span: a span whose lease ran out is Lost contact, not a stall', () => {
    // A stalled ticket has nothing open; an open span with an expired lease belongs to `lostContact`.
    const t = timeline({ stalled: stall(at('12:02')), spans: [span({ agent: 'builder' })] })
    expect(stallReason(t)).toMatchObject({ kind: 'nothing-open' })
    const lost: WorkTimelineLike = {
      ...timeline(),
      liveness: {
        state: 'lost',
        agent: 'builder',
        phase: 'build',
        since: at('11:18'),
        lastSignalAt: at('11:18'),
        lastWordAt: at('12:04'),
        silentMinutes: 26,
        spans: [
          {
            phase: 'build',
            agent: 'builder',
            since: at('11:18'),
            lastWordAt: at('12:04'),
            silentMinutes: 26,
          },
        ],
      },
    }
    expect(lostContact(lost)).toEqual({
      agent: 'builder',
      phase: 'build',
      since: at('11:18'),
      silentMinutes: 26,
      lastWordAt: at('12:04'),
    })
    expect(livenessLines(lost.liveness, NOW)).toEqual(['builder · build · 72 min · last word 26 min ago'])
  })

  it('reads a stall on a ticket with no events as nothing open since its last signal', () => {
    const t = timeline({ stalled: stall(at('09:00')), start: null, end: null })
    expect(stallReason(t)).toEqual({
      kind: 'nothing-open',
      since: at('09:00'),
      endedAt: null,
      phase: '',
      quote: '',
      stage: null,
    })
  })
})

describe('workShares', () => {
  it('gives each total its share of the sum', () => {
    const s = workShares({ workingMs: 3, waitingMs: 1, blockedOnHumanMs: 0 })
    expect(s).toEqual({ total: 4, worked: 75, waited: 25, onYou: 0 })
  })

  it('gives no shares for no time', () => {
    expect(workShares(ZERO)).toEqual({ total: 0, worked: 0, waited: 0, onYou: 0 })
  })
})

describe('workLine: the one work-state line', () => {
  it('words every state of the table, by the precedence, and nothing for a row that is not live', () => {
    // The human's turn wins over everything: an open human wait, even with a live lease.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness(),
          waits: [wait({ reason: 'human', start: at('12:00') })],
          waitingOnHuman: true,
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'waiting', text: 'Waiting on you' })
    // A review ticket with an undecided card waits on the human, not on its own review.
    expect(
      workLine(timeline({ stage: stage('review', at('11:30')), waitingOnHuman: true }), NOW),
    ).toMatchObject({ state: 'waiting', text: 'Waiting on you' })
    // A review stage with an open span and a live lease still reads Your turn: the verdict is the next move.
    expect(workLine(timeline({ stage: stage('review', '2026-10-18T12:30:00.000Z') }), NOW)).toMatchObject({
      state: 'your-turn',
      text: 'Your turn · waiting 2d',
    })
    // A blocked-kind stage is the human's turn too.
    expect(workLine(timeline({ stage: stage('blocked') }), NOW)).toMatchObject({
      state: 'waiting',
      text: 'Waiting on you',
    })
    // Lost outranks the day-long quiet and the stall, with or without a progress post in 25 h.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ state: 'lost', since: at('11:44'), lastWordAt: at('12:10') }),
          progressAt: at('11:30'),
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'lost', text: 'Lost contact · 46m' })
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ state: 'lost', since: at('11:44'), lastWordAt: at('12:10') }),
          progressAt: '2026-10-19T11:30:00.000Z',
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'lost' })
    // Nothing open, silent past stallMinutes: today's stall, now No word, even with an old progress post.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43'), spans: [] }),
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'no-word', text: 'No word 47m' })
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43'), spans: [] }),
          progressAt: '2026-10-19T11:30:00.000Z',
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'no-word' })
    // A live lease with no progress post in over a day reads Quiet, never Working now.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ lastSignalAt: at('12:28'), lastWordAt: at('12:28') }),
          progressAt: '2026-10-19T11:30:00.000Z',
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'quiet', text: 'Quiet 1d' })
    // A lease 2 minutes old kept by another agent's post, this agent's last word 12 minutes ago.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({ lastSignalAt: at('12:28'), lastWordAt: at('12:18') }),
          progressAt: at('12:18'),
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'working', text: 'Working now · last word 12m' })
    // The gap between the lease and stallMinutes is neutral.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({
            state: 'idle',
            lastSignalAt: at('12:20'),
            lastWordAt: at('12:20'),
            spans: [],
          }),
          progressAt: at('12:00'),
        }),
        NOW,
      ),
    ).toMatchObject({ state: 'nothing', text: 'Nothing open' })
    // A done ticket and an archived one have no line.
    expect(workLine(timeline({ live: false }), NOW)).toBeNull()
  })

  it('keeps Quiet off a review ticket and off a ticket whose lane posted within the day', () => {
    // The same silence, in review: the verdict outranks it.
    expect(
      workLine(timeline({ stage: stage('review', at('11:30')), progressAt: at('11:30') }), NOW),
    ).toMatchObject({ state: 'your-turn' })
    // A lane's post is part of the read's progressAt, so a parent with one is not quiet.
    expect(
      workLine(
        timeline({
          stage: stage('active'),
          liveness: liveness({
            state: 'idle',
            lastSignalAt: at('12:20'),
            lastWordAt: at('12:20'),
            spans: [],
          }),
          progressAt: at('12:25'),
        }),
        NOW,
      ),
    ).not.toMatchObject({ state: 'quiet' })
  })

  it('carries the per-agent detail under the word and the why in the tooltip', () => {
    const working = workLine(
      timeline({
        stage: stage('active'),
        liveness: liveness(),
        progressAt: at('12:18'),
      }),
      NOW,
    )!
    expect(working.detail).toEqual(['claude · build · 46 min · last word 10 min ago'])
    expect(working.why).toBe('claude · build · 46 min · last word 10 min ago')
    // A no-word row keeps the stall's why, and the stage's name when it is not the default one.
    const noWord = workLine(
      timeline({
        stage: stage('active'),
        liveness: liveness({ state: 'stalled', lastSignalAt: at('11:43'), spans: [] }),
        stalled: stall(at('11:43')),
      }),
      NOW,
      'Bug Found',
    )!
    expect(noWord.why).toBe(`in Bug Found, no agent heard from since ${clock(at('11:43'))}`)
  })

  it('never puts the state words on a surface: only workLine words them', () => {
    // The one place that words a state: the components carry none of the seven lines' templates. (The
    // Overview's human-wait row keeps its own "Waiting on you since <clock>": that is not the work line.)
    const files = [
      'src/components/WorkStatus.tsx',
      'src/components/TicketBoard.tsx',
      'src/components/Summary.tsx',
      'src/components/WorkTimelineCard.tsx',
      'src/routes/projects.$id.roadmap.tsx',
    ]
    const composed = [
      /Working now · last word/,
      /No word \$\{/,
      /Quiet \$\{/,
      /Your turn · waiting/,
      /Waiting on you(?! \{)/,
      /Lost contact · /,
      /Nothing open/,
    ]
    for (const file of files) {
      const text = readFileSync(new URL(`../${file.slice(4)}`, import.meta.url), 'utf8')
      for (const pattern of composed) expect(text, `${file} composes ${pattern}`).not.toMatch(pattern)
    }
  })
})

describe('the duration format', () => {
  it('is whole floored units: minutes under an hour, hours under a day, days from it', () => {
    expect(workDuration(0)).toBe('0m')
    expect(workDuration(59 * MINUTE)).toBe('59m')
    expect(workDuration(60 * MINUTE)).toBe('1h')
    expect(workDuration(23 * 60 * MINUTE)).toBe('23h')
    expect(workDuration(24 * 60 * MINUTE)).toBe('1d')
    expect(workDuration(49 * 60 * MINUTE)).toBe('2d')
    expect(workDuration(-5)).toBe('0m')
  })
})

describe('the server clock', () => {
  it('measures how far the browser clock runs behind the server, and moves the browser time onto the server clock', () => {
    // The server stamped 12:30 when the browser read 12:25: the browser is 5 minutes behind.
    const offset = measureOffset(at('12:30'), Date.parse(at('12:25')))
    expect(offset).toBe(5 * 60_000)
    expect(onServerClock(Date.parse(at('12:35')), offset)).toBe(Date.parse(at('12:40')))
  })

  it('a browser clock ahead of the server measures negative', () => {
    expect(measureOffset(at('12:30'), Date.parse(at('12:33')))).toBe(-3 * 60_000)
  })

  it('a span started on the server clock counts its time there, not on the browser clock behind it', () => {
    const offset = measureOffset(at('12:30'), Date.parse(at('12:25')))
    const t: WorkTimelineLike = {
      spans: [span({ start: at('12:20'), open: true })],
      waits: [],
      totals: ZERO,
      stalled: null,
      live: true,
      start: at('12:00'),
      end: at('12:30'),
      lastHeard: null,
    }
    // Browser 12:35 is server 12:40: the span, begun at 12:20, has run 20 minutes (not 15).
    expect(currentActivity(t, onServerClock(Date.parse(at('12:35')), offset))).toMatchObject({
      kind: 'building',
      ms: 20 * 60_000,
    })
  })
})

describe('the State filter’s choice', () => {
  it('reads the states from the URL value once each, in list order, and drops what it does not know', () => {
    expect(parseWorkStates('lost,waiting')).toEqual(['waiting', 'lost'])
    expect(parseWorkStates('lost,lost,nonsense')).toEqual(['lost'])
    expect(parseWorkStates('')).toEqual([])
    expect(parseWorkStates(undefined)).toEqual([])
  })

  it('keeps every row when nothing is chosen, and only the chosen states otherwise', () => {
    for (const s of WORK_LINE_STATES) expect(stateMatches(s, [])).toBe(true)
    expect(stateMatches('lost', ['lost', 'waiting'])).toBe(true)
    expect(stateMatches('quiet', ['lost', 'waiting'])).toBe(false)
  })

  it('keeps no row that has no line, once a state is chosen', () => {
    expect(stateMatches(null, [])).toBe(true)
    expect(stateMatches(null, ['nothing'])).toBe(false)
    expect(stateMatches(null, WORK_LINE_STATES)).toBe(false)
  })
})
