import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { ClaimedActor } from '#/components/Actor'
import { StalledBadge, WorkTotals } from '#/components/WorkStatus'
import { WorkTimelineBar, hasWork } from '#/components/WorkTimeline'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type TicketEvent, type TicketEvents, type TicketFull } from '#/lib/api'
import { clock, stamp } from '#/lib/format'
import { useStages } from '#/lib/project'

/**
 * The ticket's work timeline: the agents' spans, waits and hand-offs and the board's own events as one
 * bar, the working / waiting / blocked-on-human totals, the stalled warning, and every event, newest
 * first, with the heartbeats folded into one line.
 */
export function WorkTimelineCard({ t }: { t: TicketFull }) {
  const stages = useStages(t.projectId)
  const [beats, setBeats] = useState(false)
  const { data, error } = useQuery({
    queryKey: ['ticket-events', t.id],
    queryFn: () => get<TicketEvents>(`/api/tickets/${t.id}/events`),
    refetchInterval: 10_000,
  })
  const stageName = (key: string) => stages.find((s) => s.key === key)?.name ?? key
  const heartbeats = data?.events.filter((e) => e.kind === 'heartbeat') ?? []
  const shown = data?.events.filter((e) => beats || e.kind !== 'heartbeat') ?? []
  return (
    <section className="rounded-lg border p-4" aria-label="Timeline">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Timeline</h2>
        <div className="flex flex-wrap items-center gap-2">
          <StalledBadge stalled={data?.timeline.stalled} />
          {data && hasWork(data.timeline) && <WorkTotals totals={data.timeline.totals} />}
        </div>
      </div>
      {error ? (
        <p className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          <WorkTimelineBar timeline={data.timeline} />
          {data.events.length > 0 && (
            <>
              <ol aria-label="Events" className="space-y-1 text-xs">
                {heartbeats.length > 0 && !beats && (
                  <li className="text-muted-foreground">
                    {heartbeats.length} heartbeat{heartbeats.length === 1 ? '' : 's'}, last{' '}
                    {clock(heartbeats[0]!.at)}
                  </li>
                )}
                {/* The row's parts sit in a div of their own: a <time> right under an <li> is the feed's post shape. */}
                {shown.map((e) => (
                  <li key={e.id}>
                    {/* It wraps: a long name breaks, and the sentence keeps a readable width on a line of its own. */}
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <Tip content={stamp(e.at)}>
                        <time
                          dateTime={e.at}
                          className="shrink-0 font-mono text-muted-foreground tabular-nums"
                        >
                          {clock(e.at)}
                        </time>
                      </Tip>
                      {/* The name an event claims may be free text: who recorded it follows when that is someone else. */}
                      <ClaimedActor name={e.agent} by={e.by} className="min-w-0 flex-wrap break-all" />
                      <span className="min-w-0 grow basis-48 break-words">{eventSentence(e, stageName)}</span>
                    </div>
                  </li>
                ))}
              </ol>
              {heartbeats.length > 0 && (
                <Button variant="ghost" size="sm" aria-expanded={beats} onClick={() => setBeats((v) => !v)}>
                  {beats ? 'Hide heartbeats' : 'Show heartbeats'}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** One event as a plain sentence, after who did it. */
function eventSentence(e: TicketEvent, stageName: (key: string) => string): string {
  const phase = `${e.phase}${e.round !== null ? ` round ${e.round}` : ''}`
  const note = e.note ? `: ${e.note}` : ''
  switch (e.kind) {
    case 'span_start':
      return `started ${phase}${note}`
    case 'span_end':
      return `ended ${phase}${note}`
    case 'handoff':
      return `handoff ${e.fromAgent} → ${e.toAgent}${note}`
    case 'wait_start':
      return `started waiting: ${e.reason}${note}`
    case 'wait_end':
      return `stopped waiting: ${e.reason}${note}`
    case 'heartbeat':
      return `heartbeat${note}`
    case 'stage':
      return e.fromStage
        ? `moved ${stageName(e.fromStage)} → ${stageName(e.toStage)}`
        : `created in ${stageName(e.toStage)}`
    case 'preview':
      return `preview ${e.note}`
    default:
      return e.note || e.kind
  }
}
