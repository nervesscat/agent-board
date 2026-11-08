import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { ClaimedActor } from '#/components/Actor'
import { WorkTimelineBar, hasWork } from '#/components/WorkTimeline'
import { WorkTotals } from '#/components/WorkStatus'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import {
  errorMessage,
  get,
  type TicketEvent,
  type TicketEvents,
  type TicketFull,
  type WorkTimeline,
} from '#/lib/api'
import { clock, stamp } from '#/lib/format'
import { useStages } from '#/lib/project'
import { useNow } from '#/lib/useNow'

/** The story shows its newest rows, then "Show all". */
const NEWEST_ROWS = 10

/**
 * The ticket's Timeline card. At the top: what is open now, whether the ticket is stalled and why, and
 * the last heartbeat. Then the chart, the totals and the key. Then the events as a story: one sentence
 * per row, the consecutive rows of one actor under one actor line, a wait's start and end as one row
 * with its duration, and the heartbeats folded away until they are asked for.
 */
export function WorkTimelineCard({ t }: { t: TicketFull }) {
  const stages = useStages(t.projectId)
  const [beats, setBeats] = useState(false)
  const [all, setAll] = useState(false)
  const { data, error } = useQuery({
    queryKey: ['ticket-events', t.id],
    queryFn: () => get<TicketEvents>(`/api/tickets/${t.id}/events`),
    refetchInterval: 10_000,
  })
  const now = useNow(1000)
  const stageName = (key: string) => stages.find((s) => s.key === key)?.name ?? key
  const events = data ? newestFirst(data.events) : []
  const heartbeats = events.filter((e) => e.kind === 'heartbeat')
  const rows = data ? storyRows(events, data.timeline, now, stageName, beats) : []
  const shown = all ? rows : rows.slice(0, NEWEST_ROWS)
  return (
    <section className="rounded-lg border p-4" aria-label="Timeline">
      <h2 className="mb-3 text-sm font-medium">Timeline</h2>
      {error ? (
        <p className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1 text-sm">
            <NowLine timeline={data.timeline} />
            <StallNotice timeline={data.timeline} />
            <LastHeard beat={heartbeats[0] ?? null} />
          </div>
          <WorkTimelineBar timeline={data.timeline} />
          {hasWork(data.timeline) && <WorkTotals totals={data.timeline.totals} />}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Key</summary>
            <div className="mt-2">
              <WorkTimelineKey />
            </div>
          </details>
          {events.length > 0 && (
            <>
              <ol aria-label="Events" className="space-y-3 text-xs">
                {groupRuns(shown).map((run) => (
                  <li key={run.rows[0]!.id}>
                    <div className="mb-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      {/* The name an event claims may be free text: who recorded it follows when that is someone else. */}
                      <ClaimedActor name={run.agent} by={run.by} className="min-w-0 flex-wrap break-all" />
                    </div>
                    <ol className="space-y-1 border-l pl-3">
                      {run.rows.map((r) => (
                        <li key={r.id} className="flex min-w-0 items-baseline gap-x-2">
                          <Tip content={stamp(r.at)}>
                            <time
                              dateTime={r.at}
                              className="shrink-0 font-mono text-muted-foreground tabular-nums"
                            >
                              {clock(r.at)}
                            </time>
                          </Tip>
                          <span className="min-w-0 break-words">{r.text}</span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
              {(rows.length > NEWEST_ROWS || heartbeats.length > 0) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {rows.length > NEWEST_ROWS && (
                    <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                      {all ? 'Show fewer' : `Show all ${rows.length}`}
                    </Button>
                  )}
                  {heartbeats.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={beats}
                      onClick={() => setBeats((v) => !v)}
                    >
                      {beats ? 'Hide heartbeats' : 'Show heartbeats'}
                    </Button>
                  )}
                  {heartbeats.length > 0 && !beats && (
                    <span className="text-muted-foreground">
                      {heartbeats.length} heartbeat{heartbeats.length === 1 ? '' : 's'}, last{' '}
                      {clock(heartbeats[0]!.at)}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

// --- The story: events as rows, folded into runs of one actor ---

/** One sentence of the story: when, who (the actor and who recorded it), and what it says. */
type Row = { id: number; at: string; agent: string; by: string; text: string }
/** The consecutive rows of one actor, under one actor line. */
type Run = { agent: string; by: string; rows: Row[] }

const newestFirst = (events: TicketEvent[]) =>
  [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id)

/**
 * The rows the story shows, newest first. A wait's end is not a row of its own: its start carries both
 * ends and the duration (a wait still open runs to now on a live ticket). Heartbeats are rows only when
 * they are asked for.
 */
function storyRows(
  events: TicketEvent[],
  timeline: WorkTimeline,
  now: number,
  stageName: (key: string) => string,
  beats: boolean,
): Row[] {
  const startIds = new Set(events.filter((e) => e.kind === 'wait_start').map((e) => e.id))
  const endOf = new Map<number, TicketEvent>()
  for (const e of events) if (e.kind === 'wait_end' && e.refId !== null) endOf.set(e.refId, e)
  const lastAt = events[0]?.at
  const ticketEnd = timeline.live ? now : Date.parse(timeline.end ?? lastAt ?? new Date(now).toISOString())
  const rows: Row[] = []
  for (const e of events) {
    if (e.kind === 'heartbeat' && !beats) continue
    if (e.kind === 'wait_end' && e.refId !== null && startIds.has(e.refId)) continue
    const end = endOf.get(e.id)
    const text =
      e.kind === 'wait_start'
        ? end
          ? `waited for ${waitTarget(e.reason, e.note)} · ${waitFor(Date.parse(end.at) - Date.parse(e.at))}`
          : `waiting for ${waitTarget(e.reason, e.note)} · ${waitFor(ticketEnd - Date.parse(e.at))}`
        : sentence(e, stageName)
    rows.push({ id: e.id, at: e.at, agent: e.agent, by: e.by, text })
  }
  return rows
}

/** The consecutive rows of one actor (name and recorder) as one run. */
function groupRuns(rows: Row[]): Run[] {
  const runs: Run[] = []
  for (const r of rows) {
    const last = runs.at(-1)
    if (last && last.agent === r.agent && last.by === r.by) last.rows.push(r)
    else runs.push({ agent: r.agent, by: r.by, rows: [r] })
  }
  return runs
}

/** One event as a plain sentence, without its actor (the actor line above its run says who). */
function sentence(e: TicketEvent, stageName: (key: string) => string): string {
  const phase = `${e.phase || 'work'}${e.round !== null ? ` round ${e.round}` : ''}`
  const note = e.note ? `: ${e.note}` : ''
  switch (e.kind) {
    case 'span_start':
      return `started ${phase}${note}`
    case 'span_end':
      return `ended ${phase}${note}`
    case 'handoff':
      return `handed the work to ${e.toAgent || 'someone'}${note}`
    case 'wait_start':
      return `waiting for ${waitTarget(e.reason, e.note)}`
    case 'wait_end':
      return `stopped waiting for ${waitTarget(e.reason, e.note)}${note}`
    case 'heartbeat':
      return `heartbeat${note}`
    case 'stage':
      return e.fromStage ? `moved to ${stageName(e.toStage)}` : `created in ${stageName(e.toStage)}`
    case 'push':
      return `pushed${note}`
    case 'pr':
      return `opened the PR${note}`
    case 'merge':
      return `merged${note}`
    case 'preview':
      return `preview ${e.note}`
    default:
      return e.note || e.kind
  }
}

/** What a wait is for: its reason, or for `other` the note that says what (`spec`). */
function waitTarget(reason: string, note: string): string {
  switch (reason) {
    case 'other':
      return note || 'something else'
    case 'lock':
      return note ? `the lock (${note})` : 'the lock'
    case 'human':
      return 'you'
    case 'mcp':
      return 'the MCP server'
    default:
      return reason || 'something else'
  }
}

/** A duration for the story: `0 s`, `85 s`, `1 min 25 s`, `43 min`, `2 h 5 min`. */
function waitFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

// --- STAND-INS (remove at rebase) ---
// The header and the key are not on this branch yet: NowLine, StallNotice, LastHeard and WorkSummary come
// from WorkStatus.tsx, WorkTimelineKey from WorkTimelineKey.tsx (both still in progress). These stand-ins take the same
// props they are expected to take (`timeline`, and `beat` for LastHeard). When those merge, delete this
// block and import the real ones.

function NowLine({ timeline }: { timeline: WorkTimeline }) {
  const now = useNow(1000)
  const span = timeline.spans.find((s) => s.open)
  const wait = timeline.waits.find((w) => w.open)
  const text = span
    ? `Building · ${span.agent} · ${waitFor(now - Date.parse(span.start))}`
    : wait
      ? `Waiting on ${waitTarget(wait.reason, wait.note)} · ${waitFor(now - Date.parse(wait.start))}`
      : 'Nothing open'
  return <p data-testid="now-line">{text}</p>
}

function StallNotice({ timeline }: { timeline: WorkTimeline }) {
  const s = timeline.stalled
  if (!s) return null
  const closed = timeline.spans
    .filter((x) => !x.open)
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0]
  const why = closed
    ? `nothing open since the ${closed.phase} ended at ${clock(closed.end)}`
    : `nobody heard from since ${clock(s.since)}`
  return (
    <p data-testid="stalled" className="text-amber-800 dark:text-amber-300">
      Stalled {waitFor(s.minutes * 60_000)} · {why}
    </p>
  )
}

function LastHeard({ beat }: { beat: TicketEvent | null }) {
  if (!beat) return null
  return (
    <p data-testid="last-heard" className="text-muted-foreground">
      Last heard {clock(beat.at)} · {beat.agent}
      {beat.note ? `: ${beat.note}` : ''}
    </p>
  )
}

function WorkTimelineKey() {
  return (
    <ul className="space-y-0.5">
      <li>Solid: work, by phase</li>
      <li>Hatched: waiting</li>
      <li>Amber: waiting on you or blocked</li>
      <li>Arrow: hand-off</li>
    </ul>
  )
}
