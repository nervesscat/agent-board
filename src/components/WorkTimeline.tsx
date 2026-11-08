import { ArrowRight } from 'lucide-react'

import { Tip } from '#/components/ui/tooltip'
import { clock } from '#/lib/format'
import type { TimelineSpan, TimelineWait, WorkTimeline } from '#/lib/workTimeline'

/**
 * A ticket's work timeline (src/lib/workTimeline.ts) as one horizontal track, from its first event to
 * now (or its last event, once it is no longer worked): the agents' spans as solid segments coloured
 * by phase, packed into as many rows as overlap; the waits hatched on a row of their own, with the time
 * in a blocked stage (that and the waits on the human hatched faintly over the spans too, since they
 * take that time off working); the hand-offs and the board's events as markers. Every segment and marker is a
 * button with its whole story as its name and its tooltip, so the track reads from the keyboard too.
 */

/** A duration in words for names and tooltips: `38 min`, `2 h 5 min`, `under a minute`. */
export function spokenDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

const PHASE: Record<string, string> = {
  spec: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-sky-950',
  build: 'bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950',
  review: 'bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950',
  verify: 'bg-teal-600 text-white dark:bg-teal-400 dark:text-teal-950',
  pr: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950',
  preview: 'bg-pink-600 text-white dark:bg-pink-400 dark:text-pink-950',
  merge: 'bg-lime-700 text-white dark:bg-lime-400 dark:text-lime-950',
}
const OTHER_PHASE = 'bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-900'

/** A wait's colour: amber on the human, the muted foreground otherwise. It draws the hatching too. */
const WAIT_TONE: Record<string, string> = {
  human: 'text-amber-700 border-amber-600/60 dark:text-amber-300 dark:border-amber-400/60',
}
const OTHER_WAIT = 'text-muted-foreground border-muted-foreground/50'

/** Diagonal stripes in the element's own text colour, faded so its label stays readable. */
const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg, color-mix(in oklab, currentColor 30%, transparent) 0 3px, transparent 3px 7px)',
}

const phaseName = (s: Pick<TimelineSpan, 'phase' | 'round'>) =>
  s.round !== null ? `${s.phase} round ${s.round}` : s.phase

/**
 * Where a segment ends, in words: `now` only while it is open on a live ticket. On a ticket no longer
 * worked an open segment ends at the ticket's last event, as the bar draws it, so it gives that time
 * (its `open` suffix still says it was never closed).
 */
const until = (seg: { open: boolean; end: string }, live: boolean) =>
  seg.open && live ? 'now' : clock(seg.end)

export const spanLabel = (s: TimelineSpan, live: boolean) =>
  `${phaseName(s)} by ${s.agent}${s.by !== s.agent ? ` (via ${s.by})` : ''}, ${clock(s.start)} to ${until(s, live)}, ${spokenDuration(Date.parse(s.end) - Date.parse(s.start))}${s.open ? ', open' : ''}`

export const waitLabel = (w: TimelineWait, live: boolean) =>
  `wait: ${w.reason} (${w.agent}), ${clock(w.start)} to ${until(w, live)}, ${spokenDuration(Date.parse(w.end) - Date.parse(w.start))}${w.open ? ', open' : ''}${w.note ? `: ${w.note}` : ''}`

/** Spans packed into rows so overlapping ones (an orchestrator's and its sub-agent's) sit apart. */
function packRows(spans: TimelineSpan[]): TimelineSpan[][] {
  const rows: { end: number; spans: TimelineSpan[] }[] = []
  for (const s of [...spans].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const start = Date.parse(s.start)
    const row = rows.find((r) => r.end <= start)
    if (row) {
      row.spans.push(s)
      row.end = Date.parse(s.end)
    } else rows.push({ end: Date.parse(s.end), spans: [s] })
  }
  return rows.map((r) => r.spans)
}

/** Something to draw: a span, a wait, a hand-off, a board event or time in a blocked stage (a stage move alone is not). */
export const hasWork = (t: WorkTimeline) =>
  t.spans.length + t.waits.length + t.handoffs.length + t.marks.length + t.blockedStretches.length > 0

export function WorkTimelineBar({
  timeline,
  compact = false,
}: {
  timeline: WorkTimeline
  compact?: boolean
}) {
  if (!timeline.start || !timeline.end || !hasWork(timeline))
    return (
      <p data-testid="work-timeline" className="text-xs text-muted-foreground">
        No work recorded yet.
      </p>
    )
  const start = Date.parse(timeline.start)
  const length = Math.max(1, Date.parse(timeline.end) - start)
  const at = (iso: string) => `${Math.min(100, Math.max(0, ((Date.parse(iso) - start) / length) * 100))}%`
  const width = (from: string, to: string) =>
    `max(6px, ${Math.max(0, ((Date.parse(to) - Date.parse(from)) / length) * 100)}%)`
  const rows = packRows(timeline.spans)
  const rowH = compact ? 'h-4' : 'h-5'
  const text = compact ? 'text-[10px]' : 'text-[11px]'
  const segment = `absolute inset-y-0 overflow-hidden rounded-sm px-1 text-left leading-none whitespace-nowrap outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${text}`
  const hasWaits = timeline.waits.length > 0 || timeline.blockedStretches.length > 0
  const hasMarks = timeline.handoffs.length > 0 || timeline.marks.length > 0
  return (
    <div data-testid="work-timeline" className="space-y-1">
      {rows.length > 0 && (
        <div className="relative space-y-0.5" aria-label="Spans" role="group">
          {rows.map((row, i) => (
            <div key={i} className={`relative ${rowH}`}>
              {row.map((s) => {
                const label = spanLabel(s, timeline.live)
                return (
                  <Tip key={s.id} content={label}>
                    <button
                      type="button"
                      aria-label={label}
                      data-kind="span"
                      data-phase={s.phase}
                      data-open={s.open ? 'true' : 'false'}
                      className={`${segment} ${PHASE[s.phase] ?? OTHER_PHASE} ${s.open ? 'rounded-r-none' : ''}`}
                      style={{ left: at(s.start), width: width(s.start, s.end) }}
                    >
                      {phaseName(s)}
                    </button>
                  </Tip>
                )
              })}
              {/* Where the human holds the work up, shown faintly over the spans too: that time is blocked
                  on the human, not working. Other waits stay on their own row, since work under them counts. */}
              {[
                ...timeline.waits
                  .filter((w) => w.reason === 'human')
                  .map((w) => ({ ...w, key: `wait-${w.id}` })),
                ...timeline.blockedStretches.map((b) => ({ ...b, key: `blocked-${b.start}` })),
              ].map((w) => (
                <span
                  key={w.key}
                  aria-hidden
                  data-kind="human-overlay"
                  className={`pointer-events-none absolute inset-y-0 ${WAIT_TONE.human}`}
                  style={{ left: at(w.start), width: width(w.start, w.end), ...HATCH }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {hasWaits && (
        <div className={`relative ${rowH}`} aria-label="Waits" role="group">
          {timeline.blockedStretches.map((b) => {
            const label = `blocked stage, ${clock(b.start)} to ${clock(b.end)}, ${spokenDuration(Date.parse(b.end) - Date.parse(b.start))}`
            return (
              <Tip key={b.start} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  data-kind="blocked"
                  className={`${segment} border border-dashed bg-amber-500/10 ${WAIT_TONE.human}`}
                  style={{ left: at(b.start), width: width(b.start, b.end) }}
                >
                  blocked
                </button>
              </Tip>
            )
          })}
          {timeline.waits.map((w) => {
            const label = waitLabel(w, timeline.live)
            return (
              <Tip key={w.id} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  data-kind="wait"
                  data-reason={w.reason}
                  data-open={w.open ? 'true' : 'false'}
                  className={`${segment} border bg-card font-medium ${WAIT_TONE[w.reason] ?? OTHER_WAIT}`}
                  style={{ left: at(w.start), width: width(w.start, w.end), ...HATCH }}
                >
                  {w.reason}
                </button>
              </Tip>
            )
          })}
        </div>
      )}
      {hasMarks && (
        <div className="relative h-4" aria-label="Hand-offs and board events" role="group">
          {timeline.marks.map((m) => {
            const label = `${m.kind}${m.note ? `: ${m.note}` : ''}, ${clock(m.at)}`
            return (
              <Tip key={m.id} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  data-kind="mark"
                  data-mark={m.kind}
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-card bg-muted-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ left: at(m.at) }}
                />
              </Tip>
            )
          })}
          {timeline.handoffs.map((h) => {
            const label = `handoff ${h.from} → ${h.to}, ${clock(h.at)}${h.note ? `: ${h.note}` : ''}`
            return (
              <Tip key={h.id} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  data-kind="handoff"
                  className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-card text-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ left: at(h.at) }}
                >
                  <ArrowRight className="size-2.5" aria-hidden />
                </button>
              </Tip>
            )
          })}
        </div>
      )}
      <div className="flex justify-between text-[10.5px] text-muted-foreground tabular-nums" aria-hidden>
        <span>{clock(timeline.start)}</span>
        <span>{timeline.live ? 'now' : clock(timeline.end)}</span>
      </div>
    </div>
  )
}
