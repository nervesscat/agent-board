import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { clock, stamp } from '#/lib/format'
import {
  buildChart,
  PX_PER_MINUTE,
  share,
  spokenDuration,
  type AgentRow,
  type Chart,
  type ChartWait,
  type Handoff,
  type RowItem,
  type Window,
} from '#/lib/timelineRows'
import { useNow } from '#/lib/useNow'
import type { TimelineMark, TimelineSpan, WorkTimeline } from '#/lib/workTimeline'

import {
  ARROW,
  ARROW_ICON,
  BLOCKED_BAND,
  BLOCKED_CHIP,
  DELEGATION,
  GRID_LINE,
  HANDOFF_LINE,
  HATCH,
  HUMAN_ICON,
  HUMAN_WAIT,
  MARK,
  NOW_LINE,
  OTHER_MARK,
  OTHER_PHASE,
  PHASE,
  PLAIN_WAIT,
  waitIcon,
  WorkTimelineKey,
  boxStyle,
} from './WorkTimelineKey'

export { spokenDuration }

/**
 * A ticket's work timeline (src/lib/workTimeline.ts) as a chart: one row per agent (a sub-agent under the
 * agent that recorded it), its work as solid segments by phase, its waits hatched on its own row (amber
 * and filled on the human, a thin connector where it delegated), the hand-offs between rows, the board's
 * events on a rail on top, the blocked stages as bands behind the rows. Layout is in src/lib/timelineRows.ts,
 * the key in WorkTimelineKey.tsx. Every segment and marker is a button, with its story as its name and
 * tooltip, and its details in a popover on click, tap or Enter.
 */

const phaseName = (s: Pick<TimelineSpan, 'phase' | 'round'>) =>
  s.round !== null ? `${s.phase} round ${s.round}` : s.phase
const phaseShort = (s: Pick<TimelineSpan, 'phase' | 'round'>) =>
  s.round !== null ? `${s.phase} r${s.round}` : s.phase

/**
 * Where a segment ends, in words: `now` only while it is open on a live ticket. On a ticket no longer
 * worked an open segment ends at the ticket's last event, as the bar draws it, so it gives that time
 * (its `open` suffix still says it was never closed).
 */
const until = (seg: { open: boolean; end: string }, live: boolean) =>
  seg.open && live ? 'now' : clock(seg.end)

export const spanLabel = (s: TimelineSpan, live: boolean) =>
  `${phaseName(s)} by ${s.agent}${s.by !== s.agent ? ` (via ${s.by})` : ''}, ${clock(s.start)} to ${until(s, live)}, ${spokenDuration(Date.parse(s.end) - Date.parse(s.start))}${s.open ? ', open' : ''}`

export const waitLabel = (w: ChartWait, live: boolean) =>
  `wait: ${w.reason} (${w.agent}), ${clock(w.start)} to ${until(w, live)}, ${spokenDuration(Date.parse(w.end) - Date.parse(w.start))}${w.open ? ', open' : ''}${w.note ? `: ${w.note}` : ''}`

/** A wait delegated to another agent: the delegate in the name, as the wait's own story. */
export const delegationLabel = (w: ChartWait, live: boolean) =>
  `delegated to ${w.on} by ${w.agent}, ${clock(w.start)} to ${until(w, live)}, ${spokenDuration(Date.parse(w.end) - Date.parse(w.start))}${w.open ? ', open' : ''}${w.note ? `: ${w.note}` : ''}`

const handoffLabel = (h: { from: string; to: string; at: string; note: string }) =>
  `handoff ${h.from} → ${h.to}, ${clock(h.at)}${h.note ? `: ${h.note}` : ''}`

const markLabel = (m: TimelineMark) =>
  `${(MARK[m.kind] ?? OTHER_MARK).name}${m.note ? `: ${m.note}` : ''}, ${clock(m.at)}`

/** The pieces of the popover: a definition list of facts. */
function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const endedWhen = (seg: { open: boolean; end: string }, live: boolean) =>
  seg.open ? (live ? 'running' : 'never closed') : stamp(seg.end)

/**
 * A segment: its label as the tooltip and the button's name, its details in a popover opened by a click,
 * a tap or Enter. The popover's trigger is the segment itself, so the keyboard reaches it with the same
 * focus the tooltip gets.
 */
function Segment({
  label,
  details,
  className,
  style,
  attrs = {},
  children,
}: {
  label: string
  details: ReactNode
  className: string
  style: CSSProperties
  attrs?: Record<string, string | undefined>
  children?: ReactNode
}) {
  return (
    <Popover>
      <Tip content={label}>
        <PopoverTrigger
          render={<button type="button" aria-label={label} className={className} style={style} {...attrs} />}
        >
          {children}
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-64">{details}</PopoverContent>
    </Popover>
  )
}

const SEG_BASE =
  'absolute flex items-center gap-1 overflow-hidden rounded-sm px-1 text-left leading-none whitespace-nowrap outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring'

/** Lane height in pixels: the compact chart (a lane of a Roadmap ticket) is shorter. */
const lanePx = (compact: boolean) => (compact ? 16 : 20)
/** The rail above the rows and the axis below them. */
const RAIL_PX = 18
const AXIS_PX = 14

/** One row of the chart: the label on the left from sm up, above the track on a phone; the track scrolls. */
function Row({
  label,
  height,
  minWidth,
  children,
}: {
  label: ReactNode
  height: number
  minWidth: number
  children: ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row">
      <div className="sticky left-0 z-10 w-max max-w-full shrink-0 bg-card pb-0.5 pr-2 text-[11px] sm:w-28 sm:pb-0">
        {label}
      </div>
      <div className="relative min-w-0 sm:flex-1" style={{ height, minWidth }}>
        {children}
      </div>
    </div>
  )
}

function WaitSegment({
  item,
  chart,
  compact,
}: {
  item: Extract<RowItem, { kind: 'wait' }>
  chart: Chart
  compact: boolean
}) {
  const { wait: w, seg, lane, delegated } = item
  const h = lanePx(compact)
  const text = compact ? 'text-[10px]' : 'text-[11px]'
  const top = lane * h + 1
  const height = h - 2
  if (delegated) {
    const on = w.on as string
    return (
      <Segment
        label={delegationLabel(w, chart.live)}
        details={
          <Facts
            items={[
              ['Delegated to', on],
              ['By', w.agent],
              ['Started', stamp(w.start)],
              ['Ended', endedWhen(w, chart.live)],
              ['Note', w.note || '—'],
            ]}
          />
        }
        className={`${SEG_BASE} ${text} ${DELEGATION}`}
        style={boxStyle(seg.left, seg.width, lane * h, h)}
        attrs={{ 'data-kind': 'delegation', 'data-on': on, 'data-narrow': seg.narrow ? 'true' : undefined }}
      >
        <span aria-hidden className="h-px min-w-2 flex-1 bg-current" />
        {!seg.narrow && <span className="shrink-0 rounded-sm bg-card px-1">delegated to {on}</span>}
      </Segment>
    )
  }
  const human = w.reason === 'human'
  const Icon = human ? HUMAN_ICON : waitIcon(w.reason)
  return (
    <Segment
      label={waitLabel(w, chart.live)}
      details={
        <Facts
          items={[
            ['Waiting', w.agent],
            ['On', w.reason === 'human' ? 'the human' : w.reason],
            ['Started', stamp(w.start)],
            ['Ended', endedWhen(w, chart.live)],
            ['Duration', spokenDuration(Date.parse(w.end) - Date.parse(w.start))],
            ['Note', w.note || '—'],
          ]}
        />
      }
      className={`${SEG_BASE} ${text} ${human ? HUMAN_WAIT : `${PLAIN_WAIT} font-medium`}`}
      style={{ ...boxStyle(seg.left, seg.width, top, height), ...(human ? {} : HATCH) }}
      attrs={{
        'data-kind': 'wait',
        'data-reason': w.reason,
        'data-open': w.open ? 'true' : 'false',
        'data-narrow': seg.narrow ? 'true' : undefined,
      }}
    >
      {!seg.narrow && (
        <>
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate rounded-sm bg-card px-0.5">{w.reason}</span>
        </>
      )}
    </Segment>
  )
}

function SpanSegment({
  item,
  chart,
  compact,
}: {
  item: Extract<RowItem, { kind: 'span' }>
  chart: Chart
  compact: boolean
}) {
  const { span: s, seg, lane } = item
  const h = lanePx(compact)
  const text = compact ? 'text-[10px]' : 'text-[11px]'
  return (
    <Segment
      label={spanLabel(s, chart.live)}
      details={
        <Facts
          items={[
            ['Who', s.by !== s.agent ? `${s.agent} (via ${s.by})` : s.agent],
            ['Work', phaseName(s)],
            ['Started', stamp(s.start)],
            ['Ended', endedWhen(s, chart.live)],
            ['Duration', spokenDuration(Date.parse(s.end) - Date.parse(s.start))],
          ]}
        />
      }
      className={`${SEG_BASE} ${text} ${PHASE[s.phase] ?? OTHER_PHASE} ${s.open ? 'rounded-r-none' : ''}`}
      style={{
        ...boxStyle(seg.left, seg.width, lane * h + 1, h - 2),
        ...(s.open && !seg.narrow ? { maskImage: 'linear-gradient(to right, #000 85%, transparent)' } : {}),
      }}
      attrs={{
        'data-kind': 'span',
        'data-phase': s.phase,
        'data-open': s.open ? 'true' : 'false',
        'data-narrow': seg.narrow ? 'true' : undefined,
      }}
    >
      {!seg.narrow && phaseShort(s)}
    </Segment>
  )
}

function HandoffMarker({ h }: { h: Handoff }) {
  const { handoff: x } = h
  return (
    <Segment
      label={handoffLabel(x)}
      details={
        <Facts
          items={[
            ['From', x.from],
            ['To', x.to],
            ['At', stamp(x.at)],
            ['Note', x.note || '—'],
          ]}
        />
      }
      className={`absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${ARROW}`}
      style={{ left: `${h.left * 100}%` }}
      attrs={{ 'data-kind': 'handoff' }}
    >
      <ARROW_ICON className="size-2.5" aria-hidden />
    </Segment>
  )
}

/** The chart: the rail of board events, a row per agent, and the axis, all on one scrolling track. */
export function WorkTimelineBar({
  timeline,
  compact = false,
  window: win,
  showKey,
}: {
  timeline: WorkTimeline
  compact?: boolean
  /** Fixes the axis to this window (the Roadmap's), instead of the ticket's own first event to its end. */
  window?: Window
  /** Whether the key is shown under the chart; by default it is, unless the chart is compact. */
  showKey?: boolean
}) {
  const now = useNow(30_000)
  const summaryId = useId()
  const scroller = useRef<HTMLDivElement>(null)
  const live = timeline.live
  // A live ticket opens at its right end, where now is.
  useEffect(() => {
    const el = scroller.current
    if (el && live) el.scrollLeft = el.scrollWidth
  }, [live])
  if (!timeline.start || !timeline.end || !hasWork(timeline))
    return (
      <p data-testid="work-timeline" className="text-xs text-muted-foreground">
        No work recorded yet.
      </p>
    )

  const chart = buildChart(timeline, now, win)
  const { axis, rows, marks, bands } = chart
  const h = lanePx(compact)
  const minWidth = Math.max(1, Math.round((axis.end - axis.start) / 60_000)) * PX_PER_MINUTE
  const gridLines = (
    <>
      {axis.ticks.map((t) => (
        <span
          key={t.at}
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 w-px ${GRID_LINE}`}
          style={{ left: `${share(axis, t.at) * 100}%` }}
        />
      ))}
      {bands.map((b) => (
        <span
          key={b.key}
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 ${BLOCKED_BAND}`}
          style={{ left: `${b.seg.left * 100}%`, width: `${b.seg.width * 100}%` }}
        />
      ))}
      {live && (
        <span
          aria-hidden
          data-kind="now"
          className={`pointer-events-none absolute inset-y-0 right-0 w-0.5 ${NOW_LINE}`}
        />
      )}
    </>
  )
  const atSec = (t: number) => clock(new Date(t).toISOString())

  return (
    <div
      data-testid="work-timeline"
      data-live={live ? 'true' : 'false'}
      aria-describedby={summaryId}
      className="space-y-1 text-xs"
    >
      <p id={summaryId} className="sr-only">
        {chart.summary}
      </p>
      <div ref={scroller} data-testid="work-timeline-scroll" className="overflow-x-auto pb-1">
        <div className="w-max min-w-full">
          {marks.length > 0 || bands.length > 0 || chart.created ? (
            <Row
              label={<span className="text-muted-foreground">Board</span>}
              height={RAIL_PX}
              minWidth={minWidth}
            >
              {chart.created && (
                <Tip content={`created ${chart.created.minutes} min before work`}>
                  <button
                    type="button"
                    aria-label={`created ${chart.created.minutes} min before work`}
                    data-kind="created"
                    className="absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full border border-card bg-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                    style={{ left: 0 }}
                  />
                </Tip>
              )}
              {bands.map((b) => (
                <Segment
                  key={b.key}
                  label={`blocked stage, ${atSec(b.start)} to ${atSec(b.end)}, ${spokenDuration(b.end - b.start)}`}
                  details={
                    <Facts
                      items={[
                        ['Stage', 'blocked'],
                        ['From', stamp(new Date(b.start).toISOString())],
                        ['Duration', spokenDuration(b.end - b.start)],
                      ]}
                    />
                  }
                  className={`${SEG_BASE} ${compact ? 'text-[10px]' : 'text-[11px]'} ${BLOCKED_CHIP}`}
                  style={boxStyle(b.seg.left, b.seg.width, 2, RAIL_PX - 4)}
                  attrs={{ 'data-kind': 'blocked', 'data-narrow': b.seg.narrow ? 'true' : undefined }}
                >
                  {!b.seg.narrow && 'blocked'}
                </Segment>
              ))}
              {marks.map(({ mark: m, left }) => {
                const meta = MARK[m.kind] ?? OTHER_MARK
                const Icon = meta.icon
                return (
                  <Segment
                    key={m.id}
                    label={markLabel(m)}
                    details={
                      <Facts
                        items={[
                          ['Event', meta.name],
                          ['At', stamp(m.at)],
                          ['Note', m.note || '—'],
                        ]}
                      />
                    }
                    className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-card text-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                    style={{ left: `${left * 100}%` }}
                    attrs={{ 'data-kind': 'mark', 'data-mark': m.kind }}
                  >
                    <Icon className="size-3" aria-hidden />
                  </Segment>
                )
              })}
            </Row>
          ) : null}
          {rows.map((row: AgentRow) => (
            <Row
              key={row.agent}
              minWidth={minWidth}
              height={row.lanes * h}
              label={
                <Tip content={`${row.agent || 'unnamed'}${row.parent ? `, sub-agent of ${row.parent}` : ''}`}>
                  <span
                    className="block truncate font-medium"
                    style={{ paddingLeft: `${row.depth * 0.75}rem` }}
                  >
                    {row.name}
                  </span>
                </Tip>
              }
            >
              {gridLines}
              {row.connectors.map((c) => (
                <span
                  key={`${c.key}-${row.agent}`}
                  aria-hidden
                  data-kind="handoff-line"
                  className={`pointer-events-none absolute w-0 border-l border-dashed ${HANDOFF_LINE}`}
                  style={{ left: `${c.left * 100}%`, top: `${c.top}%`, bottom: `${c.bottom}%` }}
                />
              ))}
              {row.items.map((item) =>
                item.kind === 'span' ? (
                  <SpanSegment key={item.key} item={item} chart={chart} compact={compact} />
                ) : (
                  <WaitSegment key={item.key} item={item} chart={chart} compact={compact} />
                ),
              )}
              {row.arrows.map((a) => (
                <HandoffMarker key={a.handoff.id} h={a} />
              ))}
            </Row>
          ))}
          <Row label={null} height={AXIS_PX} minWidth={minWidth}>
            {axis.ticks
              .filter((t) => !(live && share(axis, t.at) > 0.92))
              .map((t, i) => (
                <span
                  key={t.at}
                  aria-hidden
                  className="absolute top-0 whitespace-nowrap text-[10.5px] text-muted-foreground tabular-nums"
                  style={{
                    left: `${share(axis, t.at) * 100}%`,
                    transform: i === 0 ? 'none' : 'translateX(-50%)',
                  }}
                >
                  {t.label}
                </span>
              ))}
            {live && (
              <span aria-hidden className="absolute top-0 right-0 text-[10.5px] text-muted-foreground">
                now
              </span>
            )}
          </Row>
        </div>
      </div>
      {chart.created && (
        <p className="text-[10.5px] text-muted-foreground">created {chart.created.minutes} min before work</p>
      )}
      {(showKey ?? !compact) && <WorkTimelineKey />}
    </div>
  )
}

/** Whether there is something to draw: a span, a wait, a hand-off, a board event or time in a blocked stage. */
export const hasWork = (t: WorkTimeline) =>
  t.spans.length + t.waits.length + t.handoffs.length + t.marks.length + t.blockedStretches.length > 0
