import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { onServerClock } from '#/lib/workStatus'
import type { ProjectSummary } from '#/lib/api'

import { InProgress } from './Summary'

/**
 * One ticket's work, read by the Overview and by the List: both are given the browser's clock, and both
 * must put it on the server's once. A browser ten minutes behind the server is the case that shows a
 * second correction.
 */

// The pages' links and route context need no router to be rendered as text.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => createElement('a', { href: '#' }, children as ReactElement),
  useParams: () => ({ id: '1' }),
}))

const MIN = 60_000
const SERVER_NOW = '2026-11-12T12:30:00.000Z'
const BROWSER_NOW = Date.parse(SERVER_NOW) - 10 * MIN

// The same span everywhere: started 43 minutes before the server's read.
const START = '2026-11-12T11:47:00.000Z'

const activity = {
  spans: [{ phase: 'build', agent: 'claude', since: START }],
  waits: [],
  lastHeard: null,
  lastClosedSpan: null,
  now: SERVER_NOW,
  liveness: {
    state: 'lost' as const,
    agent: 'claude',
    phase: 'build',
    since: START,
    lastSignalAt: START,
    lastWordAt: START,
    silentMinutes: 43,
    spans: [{ phase: 'build', agent: 'claude', since: START, lastWordAt: START, silentMinutes: 43 }],
  },
}

/** The Overview's in-progress entry for that span, as the summary endpoint hands it to the card. */
const summary = (): ProjectSummary =>
  ({
    project: { id: 1, name: 'Board' },
    agents: [],
    stages: [
      { key: 'in_progress', name: 'In progress', kind: 'active' },
      { key: 'done', name: 'Done', kind: 'done' },
    ],
    needsYou: { stalled: [] },
    inProgress: [
      {
        id: 1,
        title: 'Ship the importer',
        status: 'in_progress',
        kind: 'active',
        activity,
        stalled: null,
        stale: false,
        since: START,
        assignee: 'claude',
        lanes: 0,
        decisions: 0,
        blockedTasks: 0,
        preview: null,
        rollup: { done: 0, total: 0 },
        lastPost: null,
      },
    ],
  }) as unknown as ProjectSummary

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')

// Names on the rows come from a query the page has already answered; here it answers nothing.
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) } },
})

const render = (element: ReactElement) =>
  text(renderToStaticMarkup(createElement(QueryClientProvider, { client }, element)))

describe('the server clock correction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts one span’s minutes the same on the Overview as on a raw clock', () => {
    // The browser runs ten minutes behind the server that stamped the span.
    vi.spyOn(Date, 'now').mockReturnValue(BROWSER_NOW)
    // What the Overview holds: the server's own time, corrected once where the summary arrived.
    const now = onServerClock(BROWSER_NOW, Date.parse(SERVER_NOW) - BROWSER_NOW)
    expect(now).toBe(Date.parse(SERVER_NOW))

    const element = createElement(InProgress, { p: summary(), now })
    const overview = render(element)
    // The state's icon is named by its line: 12:30 on the server is 43 minutes after 11:47, never 53.
    expect(renderToStaticMarkup(createElement(QueryClientProvider, { client }, element))).toContain(
      'aria-label="Lost contact · 43m"',
    )
    expect(overview).toContain('43m')
    expect(overview).toContain('claude · build · 43 min · last word 43 min ago')
    expect(overview).not.toContain('53')
  })
})
