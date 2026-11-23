import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

import { DelayedLoading, SkeletonText } from '#/components/Loading'
import { RunReportView, runReportLabel } from '#/components/RunReport'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { nameParts, parentName, shortName } from '#/lib/actorName'
import { get } from '#/lib/api'
import { clock, stamp } from '#/lib/format'
import type { RunReport } from '#/lib/runReports'
import { reportsForSpans } from '#/lib/spanReport'
import {
  buildChart,
  longDuration,
  axisFor,
  share,
  spokenDuration,
  type AgentRow,
  type Band,
  type Chart,
  type ChartWait,
  type Handoff,
  type RowItem,
  type Window,
} from '#/lib/timelineRows'
import { useNow, useServerOffset } from '#/lib/useNow'
import type { TimelineMark, TimelineSpan, WorkTimeline } from '#/lib/workTimeline'
import { onServerClock } from '#/lib/workStatus'

import {
  ARROW,
  ARROW_ICON,
  BREAK_MARK,
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
  BAND_STYLE,
  boxStyle,
} from './WorkTimelineStyle'

export { spokenDuration }

/**
 * A ticket's work timeline (src/lib/workTimeline.ts) as a chart: one row per agent (a sub-agent under the
 * agent that recorded it), its work as solid segments by phase, its waits hatched on its own row (amber
 * and filled on the human, a thin connector where it delegated), the hand-offs between rows, the board's
 * events on a rail on top, the blocked stages as bands behind the rows. Layout is in src/lib/timelineRows.ts,
 * the shared classes in WorkTimelineStyle.tsx. Every segment and marker is a button, with its story as its name and
 * tooltip, and its details in a popover on click, tap or Enter; a work span instead opens, in a dialog, the run
 * report written for that run (src/lib/spanReport.ts), or its facts and that it has none.
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
  `${h.from} passed the work to ${h.to}, ${clock(h.at)}${h.note ? `: ${h.note}` : ''}`

/** A collapsed period's story: its real start, end and length, and that it is not drawn to scale. */
export const collapsedLabel = (b: Pick<Band, 'label' | 'start' | 'end' | 'open'>) =>
  `${b.label}, ${stamp(new Date(b.start).toISOString())} to ${b.open ? 'now' : stamp(new Date(b.end).toISOString())}, ${longDuration(b.end - b.start)}, not drawn to scale`

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
  'absolute flex min-w-0 items-center gap-1 overflow-hidden rounded-sm px-1 data-[narrow=true]:px-0 text-left leading-none whitespace-nowrap outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring'

/** Lane height in pixels: the compact chart (a lane of a Roadmap ticket) is shorter. */
const lanePx = (compact: boolean) => (compact ? 16 : 20)
/** The rail above the rows and the axis below them. */
const RAIL_PX = 18
const AXIS_PX = 14

/**
 * The row's label: the name it works as, with the parent it works under as a quiet prefix (`opencode/
 * builder-832`), as the chart's own reading of who is who. A deep indent is not needed when the prefix
 * already says it; a plain sub-agent (no prefix in its name) keeps the indent. The full name, and the
 * parent the timeline knows it under, are the tooltip and the label's accessible name.
 */
function RowLabel({ name, depth, parent }: { name: string; depth: number; parent: string | null }) {
  const parts = nameParts(name)
  const prefix = parentName(parts.parent)
  const full = `${name || 'unnamed'}${parent ? `, sub-agent of ${parent}` : ''}`
  return (
    <Tip content={full}>
      <span
        data-testid="agent-label"
        aria-label={full}
        className="flex min-w-0 items-baseline gap-1"
        style={{ paddingLeft: prefix ? undefined : `${depth * 0.75}rem` }}
      >
        {prefix && (
          <span aria-hidden className="min-w-0 shrink truncate font-normal text-muted-foreground">
            {prefix}/
          </span>
        )}
        <span className="min-w-0 shrink-0 truncate font-medium">{shortName(name, 16)}</span>
      </span>
    </Tip>
  )
}

/**
 * One row of the chart: the label on the left when the chart is wide enough, above the track when it is not. The track takes the
 * width that is left, and never more: the chart does not scroll sideways.
 */
function Row({
  label,
  height,
  trackRef,
  children,
}: {
  label: ReactNode
  height: number
  trackRef?: (el: HTMLDivElement | null) => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col @md:flex-row">
      <div className="max-w-full min-w-0 shrink-0 bg-card pb-0.5 pr-2 text-[11px] @md:w-32 @md:pb-0 @xl:w-40">
        {label}
      </div>
      <div ref={trackRef} className="relative min-w-0 @md:flex-1" style={{ height }}>
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
        label={delegationLabel(w, chart.going)}
        details={
          <Facts
            items={[
              ['Delegated to', on],
              ['By', w.agent],
              ['Started', stamp(w.start)],
              ['Ended', endedWhen(w, chart.going)],
              ['Note', w.note || '—'],
            ]}
          />
        }
        className={`${SEG_BASE} ${text} ${DELEGATION}`}
        style={boxStyle(seg.left, seg.width, lane * h, h)}
        attrs={{ 'data-kind': 'delegation', 'data-on': on, 'data-narrow': seg.narrow ? 'true' : undefined }}
      >
        <span aria-hidden className="h-px min-w-2 flex-1 bg-current" />
        {!seg.narrow && <span className="min-w-0 truncate rounded-sm bg-card px-1">delegated to {on}</span>}
      </Segment>
    )
  }
  const human = w.reason === 'human'
  const Icon = human ? HUMAN_ICON : waitIcon(w.reason)
  return (
    <Segment
      label={waitLabel(w, chart.going)}
      details={
        <Facts
          items={[
            ['Waiting', w.agent],
            ['On', w.reason === 'human' ? 'the human' : w.reason],
            ['Started', stamp(w.start)],
            ['Ended', endedWhen(w, chart.going)],
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
          {/* The pill hides the hatch behind the word; a human wait has no hatch, so its own colour shows. */}
          <span className={`truncate rounded-sm px-0.5 ${human ? '' : 'bg-card'}`}>{w.reason}</span>
        </>
      )}
    </Segment>
  )
}

/** What a span bar opens: where the ticket's run reports come from. */
export type SpanReports = {
  projectId: number
  ticketId: number
  /** The ticket's reports when the page already has them; otherwise they are fetched when a bar is opened. */
  known?: RunReport[]
}

/** A work span's bar: a button named for the report it opens and the story of the span, opening the chart's dialog. */
function SpanSegment({
  item,
  chart,
  compact,
  onOpen,
}: {
  item: Extract<RowItem, { kind: 'span' }>
  chart: Chart
  compact: boolean
  onOpen: (spanId: number) => void
}) {
  const { span: s, seg, lane } = item
  const h = lanePx(compact)
  const text = compact ? 'text-[10px]' : 'text-[11px]'
  const label = spanLabel(s, chart.going)
  return (
    <Tip content={label}>
      <button
        type="button"
        aria-label={`Open the ${shortName(s.agent)} report${s.round !== null ? `, round ${s.round}` : ''}: ${label}`}
        onClick={() => onOpen(s.id)}
        className={`${SEG_BASE} cursor-pointer ${text} ${PHASE[s.phase] ?? OTHER_PHASE} ${s.open ? 'rounded-r-none' : ''}`}
        style={{
          ...boxStyle(seg.left, seg.width, lane * h + 1, h - 2),
          ...(s.open && !seg.narrow ? { maskImage: 'linear-gradient(to right, #000 85%, transparent)' } : {}),
        }}
        data-kind="span"
        data-phase={s.phase}
        data-open={s.open ? 'true' : 'false'}
        data-narrow={seg.narrow ? 'true' : undefined}
      >
        {!seg.narrow && <span className="min-w-0 truncate">{phaseShort(s)}</span>}
      </button>
    </Tip>
  )
}

/**
 * The dialog a span bar opens: the run report written for the run, or when there is none the span's own
 * facts and a line saying so. It is mounted only while open, so the reports are fetched (when the chart was
 * not given them) on the first click.
 */
function SpanDialog({
  span: s,
  spans,
  reports: source,
  now,
  live,
  onClose,
}: {
  span: TimelineSpan
  spans: TimelineSpan[]
  reports: SpanReports | undefined
  now: number
  live: boolean
  onClose: () => void
}) {
  const fetched = useQuery({
    queryKey: ['span-reports', source?.projectId, source?.ticketId],
    queryFn: () =>
      get<RunReport[]>(
        `/api/projects/${source!.projectId}/run-reports?ticketId=${source!.ticketId}&limit=200`,
      ),
    enabled: Boolean(source) && !source!.known,
  })
  const list = source?.known ?? fetched.data
  const report = useMemo(
    () => (list ? (reportsForSpans(spans, list, now).get(s.id) ?? null) : null),
    [list, spans, now, s.id],
  )
  const loading = Boolean(source) && !list && !fetched.error
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{report ? `Run report: ${runReportLabel(report)}` : phaseName(s)}</DialogTitle>
          <DialogDescription className="sr-only">
            {report ? 'The report written for this run' : 'The facts of this run'}
          </DialogDescription>
        </DialogHeader>
        {report ? (
          <RunReportView r={report} />
        ) : (
          <div className="space-y-3">
            <Facts
              items={[
                ['Who', s.by !== s.agent ? `${s.agent} (via ${s.by})` : s.agent],
                ['Work', phaseName(s)],
                ['Started', stamp(s.start)],
                ['Ended', endedWhen(s, live)],
                ['Duration', spokenDuration(Date.parse(s.end) - Date.parse(s.start))],
              ]}
            />
            {loading ? (
              <DelayedLoading label="Loading run report…">
                <SkeletonText lines={1} />
              </DelayedLoading>
            ) : (
              <p className="text-xs text-muted-foreground">
                {fetched.error
                  ? 'The reports could not be loaded.'
                  : `No report for this run${s.open ? ' yet' : ''}.`}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
      style={{ left: keepInside(h.left, 8) }}
      attrs={{ 'data-kind': 'handoff' }}
    >
      <ARROW_ICON className="size-2.5" aria-hidden />
    </Segment>
  )
}

/** The track's width before it is measured (the server's render and the first paint). */
const FIRST_WIDTH = 640

/** A marker's centre on the track, kept so that the whole marker (`half` px each side) stays inside it. */
const keepInside = (left: number, half: number) => `clamp(${half}px, ${left * 100}%, calc(100% - ${half}px))`

/** A tick label's width in px, as the thinning of the axis counts it (its characters at the axis's font size). */
const labelPx = (label: string) => label.length * 6.4 + 6

/**
 * The chart: the rail of board events, a row per agent, and the axis. It always fits the width it is given:
 * it measures its track and draws the time to that width (src/lib/timelineCollapse.ts), the collapsed
 * blocks staying a fixed few pixels; labels, ticks and markers give way where the width is short.
 */
export function WorkTimelineBar({
  timeline,
  compact = false,
  window: win,
  reports,
}: {
  timeline: WorkTimeline
  compact?: boolean
  /** Fixes the axis to this window (the Roadmap's), instead of the ticket's own first event to its end. */
  window?: Window
  /** The ticket the chart draws, for a span bar to open its run report; without it a bar opens its facts only. */
  reports?: SpanReports
}) {
  // The axis's now is the server's, so a browser clock behind it does not cut the live segments short.
  const now = onServerClock(useNow(30_000), useServerOffset(timeline.now))
  const summaryId = useId()
  const [opened, setOpened] = useState<number | null>(null)
  // The track's own width, so the chart is drawn to it: measured when it is there and as it changes.
  const [track, setTrack] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FIRST_WIDTH)
  useEffect(() => {
    if (!track) return
    const read = () => setWidth(Math.max(1, Math.round(track.getBoundingClientRect().width)))
    read()
    const watch = new ResizeObserver(read)
    watch.observe(track)
    return () => watch.disconnect()
  }, [track])
  // The chart follows the time only while its axis runs to now: not when it ends at a pinned merge.
  const live = timeline.live && axisFor(timeline, now, win).pinned === null
  if (!timeline.start || !timeline.end || !hasWork(timeline))
    return (
      <p data-testid="work-timeline" className="text-xs text-muted-foreground">
        No work recorded yet.
      </p>
    )

  const chart = buildChart(timeline, now, win, width)
  const { axis, rows, marks, bands } = chart
  const openedSpan = timeline.spans.find((x) => x.id === opened) ?? null
  const h = lanePx(compact)
  // Where now is on the track: its right end, or earlier when the axis ends in empty track (nothing but collapsed blocks).
  const nowLeft = share(axis, axis.end)
  const shownBreaks = chart.breaks.filter((k) => !(live && k.left > nowLeft * 0.92))
  // The labels that fit: not within reach of the now label, a break mark or the track's edge, nor of the
  // label before them (a long one, with its date, takes room for more). A dropped label keeps its gridline.
  const tickLabels: typeof axis.ticks = []
  let taken = -Infinity
  for (const t of axis.ticks) {
    const first = t === axis.ticks[0]
    const need = labelPx(t.label)
    const x = share(axis, t.at) * width
    const from = first ? x : x - need / 2
    const to = first ? x + need : x + need / 2
    if (to > (live ? nowLeft * width - 30 : width) || from < 0 || from < taken + 8) continue
    // A break mark is about 10 px wide: no label runs under it, whichever way the label extends from its tick.
    if (shownBreaks.some((k) => from < k.left * width + 9 && to > k.left * width - 9)) continue
    tickLabels.push(t)
    taken = to
  }
  const gridLines = (
    <>
      {axis.ticks.map((t) => (
        <span
          key={t.at}
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 w-px ${GRID_LINE}`}
          style={{ left: `min(${share(axis, t.at) * 100}%, calc(100% - 1px))` }}
        />
      ))}
      {bands.map((b) => (
        <span
          key={b.key}
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 ${BAND_STYLE[b.kind].band}`}
          style={{ left: `${b.seg.left * 100}%`, width: `${b.seg.width * 100}%` }}
        />
      ))}
      {live && (
        <span
          aria-hidden
          data-kind="now"
          className={`pointer-events-none absolute inset-y-0 w-0.5 ${NOW_LINE}`}
          style={{ right: `${(1 - nowLeft) * 100}%` }}
        />
      )}
    </>
  )

  return (
    <div
      data-testid="work-timeline"
      data-live={timeline.live ? 'true' : 'false'}
      aria-describedby={summaryId}
      // A container, so the labels stand beside the rows or above them by the chart's own width, not the screen's.
      className="@container space-y-1 text-xs"
    >
      <p id={summaryId} className="sr-only">
        {chart.summary}
      </p>
      <div className="pb-1">
        {marks.length > 0 || bands.length > 0 || chart.created ? (
          <Row label={<span className="text-muted-foreground">Board</span>} height={RAIL_PX}>
            {chart.created && (
              <Tip content={`created ${chart.created.minutes} min before work`}>
                <button
                  type="button"
                  aria-label={`created ${chart.created.minutes} min before work`}
                  data-kind="created"
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-card bg-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ left: keepInside(chart.created.left, 5) }}
                />
              </Tip>
            )}
            {bands.map((b) => (
              <Segment
                key={b.key}
                label={collapsedLabel(b)}
                details={
                  <Facts
                    items={[
                      ['Waiting for', b.label],
                      ['From', stamp(new Date(b.start).toISOString())],
                      ['To', b.open ? 'now' : stamp(new Date(b.end).toISOString())],
                      ['Duration', longDuration(b.end - b.start)],
                      ['Not to scale', 'This time is shown as a short block, not at its real length.'],
                      ...(b.marks.length
                        ? [
                            [
                              'Also then',
                              b.marks
                                .map((m) => `${(MARK[m.kind] ?? OTHER_MARK).name}, ${stamp(m.at)}`)
                                .join('; '),
                            ] as [string, ReactNode],
                          ]
                        : []),
                    ]}
                  />
                }
                className={`${SEG_BASE} justify-center ${compact ? 'text-[10px]' : 'text-[11px]'} ${BAND_STYLE[b.kind].chip}`}
                style={boxStyle(b.seg.left, b.seg.width, 2, RAIL_PX - 4)}
                attrs={{ 'data-kind': b.kind }}
              >
                <span className="min-w-0 truncate">{b.label}</span>
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
                  style={{ left: keepInside(left, 8) }}
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
            height={row.lanes * h}
            label={<RowLabel name={row.agent} depth={row.depth} parent={row.parent} />}
          >
            {gridLines}
            {row.connectors.map((c) => (
              <span
                key={`${c.key}-${row.agent}`}
                aria-hidden
                data-kind="handoff-line"
                className={`pointer-events-none absolute w-0 border-l border-dashed ${HANDOFF_LINE}`}
                style={{ left: keepInside(c.left, 8), top: `${c.top}%`, bottom: `${c.bottom}%` }}
              />
            ))}
            {row.items.map((item) =>
              item.kind === 'span' ? (
                <SpanSegment key={item.key} item={item} chart={chart} compact={compact} onOpen={setOpened} />
              ) : (
                <WaitSegment key={item.key} item={item} chart={chart} compact={compact} />
              ),
            )}
            {row.arrows.map((a) => (
              <HandoffMarker key={a.handoff.id} h={a} />
            ))}
          </Row>
        ))}
        <Row label={null} height={AXIS_PX} trackRef={setTrack}>
          {tickLabels.map((t) => (
            <span
              key={t.at}
              aria-hidden
              className="absolute top-0 whitespace-nowrap text-[10.5px] text-muted-foreground tabular-nums"
              style={{
                left: `${share(axis, t.at) * 100}%`,
                transform: t === axis.ticks[0] ? 'none' : 'translateX(-50%)',
              }}
            >
              {t.label}
            </span>
          ))}
          {shownBreaks.map((k) => (
            <span
              key={k.key}
              aria-hidden
              data-kind="axis-break"
              className={`absolute top-0 -translate-x-1/2 text-[10.5px] leading-[14px] font-medium ${BREAK_MARK}`}
              style={{ left: `${k.left * 100}%` }}
            >
              //
            </span>
          ))}
          {live && (
            <span
              aria-hidden
              className="absolute top-0 text-[10.5px] text-muted-foreground"
              style={{ right: `${(1 - nowLeft) * 100}%` }}
            >
              now
            </span>
          )}
        </Row>
      </div>
      {chart.created && (
        <p className="text-[10.5px] text-muted-foreground">created {chart.created.minutes} min before work</p>
      )}
      {openedSpan && (
        <SpanDialog
          span={openedSpan}
          spans={timeline.spans}
          reports={reports}
          now={now}
          live={chart.going}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  )
}

/** Whether there is something to draw: a span, a wait, a hand-off, a board event or time the ticket waited on the human (a blocked or review stage, a wait, a decision card). */
export const hasWork = (t: WorkTimeline) =>
  t.spans.length +
    t.waits.length +
    t.handoffs.length +
    t.marks.length +
    t.blockedStretches.length +
    t.reviewStretches.length +
    t.humanStretches.length >
  0
