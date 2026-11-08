import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import { Actor } from '#/components/Actor'
import { ChipTabs } from '#/components/Chips'
import { Empty } from '#/components/Empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tip } from '#/components/ui/tooltip'
import { StalledBadge, WorkTotals } from '#/components/WorkStatus'
import { WorkTimelineBar, hasWork } from '#/components/WorkTimeline'
import { errorMessage, get, type ProjectWork, type RoadmapTicket } from '#/lib/api'
import { type Step, type StepGroup, type StepState, stepCounts, timeline } from '#/lib/roadmap'
import { useStages } from '#/lib/project'
import { STAGE_DOT, type StageLike, stageBadge, stageOf } from '#/lib/stages'
import {
  WINDOW_CHOICES,
  WINDOW_LABELS,
  type WindowChoice,
  parseWindowChoice,
  windowFor,
} from '#/lib/roadmapWindow'
import { useNow } from '#/lib/useNow'

const FILTERS = ['all', 'blocked', 'review'] as const
type Filter = (typeof FILTERS)[number]

// ?show= is the filter picked: every ticket, those with something blocked, or those in review.
// ?window= is the time axis every row shares: today, the last 24 h or 7 d, or fit the rows. Absent: the default.
export const Route = createFileRoute('/projects/$id/roadmap')({
  component: Roadmap,
  validateSearch: z.object({
    show: z.enum(FILTERS).optional().catch(undefined),
    window: z
      .unknown()
      .optional()
      .transform((raw) => {
        const choice = parseWindowChoice(raw)
        return choice === 'default' ? undefined : choice
      }),
  }),
})

type Lane = RoadmapTicket['lanes'][number]
/** A ticket or a lane as the view draws it: its stage and its timeline worked out. */
type RoadmapItem = { row: RoadmapTicket | Lane; stage: StageLike; groups: StepGroup[] }

const hasState = (b: RoadmapItem, state: StepState) =>
  b.groups.some((g) => g.steps.some((s) => s.state === state))
const isBlocked = (b: RoadmapItem) => b.stage.kind === 'blocked' || hasState(b, 'blocked')

function Roadmap() {
  const { id } = Route.useParams()
  const { show = 'all', window: windowParam } = Route.useSearch()
  const navigate = Route.useNavigate()
  const stages = useStages(id)
  const now = useNow(15_000)
  const { data, isLoading, error } = useQuery({
    queryKey: ['roadmap', id],
    queryFn: () => get<RoadmapTicket[]>(`/api/projects/${id}/roadmap`),
    refetchInterval: 10_000,
  })
  const { data: work } = useQuery({
    queryKey: ['work', id],
    queryFn: () => get<ProjectWork>(`/api/projects/${id}/work`),
    refetchInterval: 10_000,
  })
  const item = (row: RoadmapTicket | Lane): RoadmapItem => ({
    row,
    stage: stageOf(stages, row.status),
    groups: timeline(row.tasks),
  })
  const tickets = (data ?? []).map((t) => ({ ...item(t), lanes: t.lanes.map(item) }))
  const blocked = tickets.filter((t) => isBlocked(t) || t.lanes.some(isBlocked))
  const review = tickets.filter((t) => t.stage.kind === 'review')
  const shown = show === 'blocked' ? blocked : show === 'review' ? review : tickets
  const every = tickets.flatMap((t) => [t, ...t.lanes])
  // The one time axis for every row shown: computed here, from the shown rows' work, and ending now.
  // Lane #18 (the chart) takes it as `window` on each row's track (see Row); nothing draws it yet.
  const range = windowFor(
    parseWindowChoice(windowParam),
    shown.flatMap((t) => [t.row, ...t.lanes.map((l) => l.row)]),
    now,
  )
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Roadmap</h1>
          <p className="text-sm text-muted-foreground">
            Every ticket being worked, side by side: what is done, what is being worked now and what comes
            next, for the ticket and each of its lanes.
          </p>
        </div>
        <ChipTabs
          chips={[
            { key: 'all', label: 'All', count: tickets.length },
            { key: 'blocked', label: 'Blocked', count: blocked.length },
            { key: 'review', label: 'Needs review', count: review.length },
          ]}
          value={show}
          onChange={(v: Filter) =>
            navigate({ search: (prev) => ({ ...prev, show: v === 'all' ? undefined : v }), replace: true })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>Time axis, every row:</span>
        <ChipTabs<WindowChoice | ''>
          chips={WINDOW_CHOICES.map((key) => ({ key, label: WINDOW_LABELS[key] }))}
          value={windowParam ?? ''}
          onChange={(v) =>
            navigate({ search: (prev) => ({ ...prev, window: v || undefined }), replace: true })
          }
        />
        <span>
          {new Date(range.start).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} to now
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-4">
          <Stat n={tickets.length} label="tickets" />
          <Stat n={every.length - tickets.length} label="lanes" />
          <Stat n={every.filter((b) => hasState(b, 'now')).length} label="working now" />
          <Stat n={every.filter(isBlocked).length} label="blocked" amber />
          <Stat n={review.length} label="in review" />
          <Stat n={every.filter((b) => b.row.work.stalled).length} label="stalled" amber />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Legend />
          {/* Lane #18: <WorkTimelineKey /> (the chart's key, built from its style tables) goes beside the task Legend. */}
        </div>
      </div>
      {work && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Project work, every ticket and lane:</span>
          {/* Lane #19: <WorkSummary totals={work.totals} /> replaces WorkTotals here. */}
          <WorkTotals totals={work.totals} />
        </div>
      )}
      {error ? (
        <p className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : isLoading ? (
        <Skeleton className="h-64" />
      ) : shown.length === 0 ? (
        <Empty>
          {show === 'all'
            ? 'No ticket is in progress, blocked or in review.'
            : show === 'blocked'
              ? 'Nothing is blocked.'
              : 'No ticket is waiting for review.'}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card" data-testid="roadmap">
          {shown.map((t) => (
            <TicketRows key={t.row.id} projectId={id} ticket={t} lanes={t.lanes} />
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ n, label, amber = false }: { n: number; label: string; amber?: boolean }) {
  return (
    <span>
      <b
        className={`font-semibold tabular-nums ${amber && n ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'}`}
      >
        {n}
      </b>{' '}
      {label}
    </span>
  )
}

function Legend() {
  const items: [StepState, string][] = [
    ['done', 'Done'],
    ['now', 'Now'],
    ['next', 'Next'],
    ['later', 'Later'],
    ['blocked', 'Blocked'],
  ]
  return (
    <div className="flex flex-wrap items-center gap-3.5" aria-label="Legend">
      <span className="font-medium text-foreground">Tasks</span>
      {items.map(([state, label]) => (
        <span key={state} className="inline-flex items-center gap-1.5">
          <Dot state={state} small />
          {label}
        </span>
      ))}
    </div>
  )
}

/** One ticket's row and, under it, a thinner row per lane; the lanes fold away. */
function TicketRows({
  projectId,
  ticket,
  lanes,
}: {
  projectId: string
  ticket: RoadmapItem
  lanes: RoadmapItem[]
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-b last:border-b-0" aria-label={`#${ticket.row.id} ${ticket.row.title}`}>
      <Row projectId={projectId} item={ticket}>
        {lanes.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
            {lanes.length} lane{lanes.length === 1 ? '' : 's'}
          </button>
        )}
      </Row>
      {open &&
        lanes.map((lane, i) => (
          <Row
            key={lane.row.id}
            projectId={projectId}
            item={lane}
            lane={{ depth: 'depth' in lane.row ? lane.row.depth : 0, last: i === lanes.length - 1 }}
          />
        ))}
    </section>
  )
}

function Row({
  projectId,
  item,
  lane,
  children,
}: {
  projectId: string
  item: RoadmapItem
  /** Set on a lane's row: how deep it sits under the ticket, and whether it is the last one. */
  lane?: { depth: number; last: boolean }
  children?: React.ReactNode
}) {
  const { row, stage, groups } = item
  const { done, total } = stepCounts(groups)
  const indent = lane ? 40 + lane.depth * 14 : 16
  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] ${lane ? 'max-md:ml-4 max-md:border-l-2' : ''}`}
    >
      <div
        className={`relative flex min-w-0 flex-col justify-center pr-4 md:border-r ${lane ? 'py-2' : 'py-3.5'}`}
        style={{ paddingLeft: indent }}
      >
        {lane && (
          <LaneLink spine={indent - 20} last={lane.last} dot={STAGE_DOT[stage.color] ?? STAGE_DOT.gray} />
        )}
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: projectId, ticketId: String(row.id) }}
          className="flex min-w-0 items-baseline gap-2 hover:underline"
        >
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{row.id}</span>
          <Tip content={row.title}>
            <span className={`truncate ${lane ? 'text-[13px]' : 'font-medium'}`}>{row.title}</span>
          </Tip>
        </Link>
        <div
          className={`flex flex-wrap items-center gap-2 text-xs text-muted-foreground ${lane ? 'mt-1' : 'mt-1.5'}`}
        >
          {row.assignee ? <Actor name={row.assignee} className="font-normal" /> : <span>Unassigned</span>}
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${stageBadge(stage)}`}>
            {stage.name}
          </span>
          {/* Lane #19: <NowLine work={row.work} /> and <StallNotice compact work={row.work} /> replace this badge. */}
          <StalledBadge stalled={row.work.stalled} />
          {children}
          {total > 0 && (
            <Tip content={`${done} of ${total} done`}>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <span className="h-1 w-11 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-muted-foreground"
                    style={{ width: `${(100 * done) / total}%` }}
                  />
                </span>
                <span className="font-mono tabular-nums">
                  {done}/{total}
                </span>
              </span>
            </Tip>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <Track groups={groups} lane={Boolean(lane)} />
        <div role="group" className={`space-y-1 px-5 ${lane ? 'pb-2' : 'pb-3'}`} aria-label="Work timeline">
          {/* Lane #18: WorkTimelineBar takes the shared `window` from the route (`range`) here, and draws NowLine. */}
          <WorkTimelineBar timeline={row.work} compact={Boolean(lane)} />
          {/* Lane #19: <WorkSummary timeline={row.work} /> replaces WorkTotals here. */}
          {hasWork(row.work) && <WorkTotals totals={row.work.totals} />}
        </div>
      </div>
    </div>
  )
}

/** The tasks left to right; it scrolls sideways, starting with the current step in view. */
function Track({ groups, lane }: { groups: StepGroup[]; lane: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const key = groups.map((g) => g.steps.map((s) => `${s.id}:${s.state}`).join()).join('|')
  useEffect(() => {
    const track = ref.current
    const current = track?.querySelector<HTMLElement>('[data-state="now"], [data-state="blocked"]')
    if (track && current)
      track.scrollLeft = Math.max(0, current.offsetLeft - track.clientWidth / 2 + current.offsetWidth / 2)
  }, [key])
  if (!groups.length)
    return <div className="flex items-center px-5 py-3 text-xs text-muted-foreground">No tasks yet.</div>
  let index = 0
  return (
    <div
      ref={ref}
      className={`scroll-rail relative flex items-start overflow-x-auto overscroll-x-contain ${lane ? 'px-5 pt-5 pb-2' : 'px-5 pt-6.5 pb-3'}`}
    >
      {groups.map((g) => {
        const steps = (
          <ol className="flex shrink-0 items-start">
            {g.steps.map((s) => (
              <StepItem key={s.id} step={s} first={index++ === 0} lane={lane} />
            ))}
          </ol>
        )
        if (!g.caption) return <div key={g.steps[0]!.id}>{steps}</div>
        const groupDone = g.steps.filter((s) => s.state === 'done').length
        return (
          <div key={`g${g.steps[0]!.id}`} className="flex shrink-0 flex-col">
            {steps}
            <div className="relative mx-2.5 mt-2 border-t border-muted-foreground/30 pt-0.5 text-center text-[10.5px] tracking-wide text-muted-foreground before:absolute before:-top-[5px] before:left-0 before:h-[5px] before:border-l before:border-muted-foreground/30 after:absolute after:-top-[5px] after:right-0 after:h-[5px] after:border-l after:border-muted-foreground/30">
              {g.caption} · {groupDone}/{g.steps.length}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The tree line from a ticket down to its lane: a soft spine that curves into a small node on the
 * lane's title line (11px above the head's middle), the node in the lane's stage colour; the spine
 * carries on past every lane but the last.
 */
function LaneLink({ spine, last, dot }: { spine: number; last: boolean; dot: string }) {
  const line = 'border-muted-foreground/30'
  return (
    <span aria-hidden className="max-md:hidden">
      <span
        className={`absolute top-0 bottom-[calc(50%+11px)] w-2.5 rounded-bl-[10px] border-b border-l ${line}`}
        style={{ left: spine }}
      />
      {!last && (
        <span className={`absolute top-[calc(50%-11px)] bottom-0 border-l ${line}`} style={{ left: spine }} />
      )}
      <span
        className={`absolute top-[calc(50%-11px)] size-1.5 -translate-y-1/2 rounded-full ring-[3px] ring-card ${dot}`}
        style={{ left: spine + 10 }}
      />
    </span>
  )
}

const FLAG: Partial<Record<StepState, string>> = {
  now: 'text-brand bg-brand/12',
  next: 'text-muted-foreground bg-muted',
  blocked: 'text-amber-700 bg-amber-500/20 dark:text-amber-300 dark:bg-amber-400/15',
}
const LABEL: Record<StepState, string> = {
  done: 'text-muted-foreground',
  now: 'font-semibold text-foreground',
  next: 'text-foreground',
  later: 'text-muted-foreground/70',
  blocked: 'font-medium text-amber-700 dark:text-amber-300',
}

function StepItem({ step, first, lane }: { step: Step; first: boolean; lane: boolean }) {
  // The line into a step is solid up to where the ticket is, dashed after.
  const reached = step.state === 'done' || step.state === 'now' || step.state === 'blocked'
  const tip = step.blocked && step.blockedReason ? `${step.text}: ${step.blockedReason}` : step.text
  return (
    <Tip content={tip}>
      <li
        data-state={step.state}
        className={`relative flex shrink-0 flex-col items-center ${lane ? 'w-[84px]' : 'w-[92px]'}`}
      >
        {!first && (
          <span
            aria-hidden
            className={`absolute right-[calc(50%+12px)] left-[calc(-50%+12px)] ${lane ? 'top-[7px] border-t-[1.5px]' : 'top-[9px] border-t-2'} ${reached ? 'border-muted-foreground' : 'border-dashed border-muted-foreground/30'}`}
          />
        )}
        {FLAG[step.state] && (
          <span
            className={`absolute rounded-full px-1.5 font-semibold tracking-wider whitespace-nowrap uppercase ${lane ? '-top-[17px] text-[9.5px] leading-[13px]' : '-top-[19px] text-[10px] leading-[15px]'} ${FLAG[step.state]}`}
          >
            {step.state}
          </span>
        )}
        <Dot state={step.state} small={lane} />
        <span
          className={`mt-1.5 line-clamp-2 text-center leading-tight ${lane ? 'max-w-20 text-[11.5px]' : 'max-w-[88px] text-xs'} ${LABEL[step.state]}`}
        >
          {step.text}
        </span>
        {step.state === 'blocked' && step.blockedReason && (
          <span className="mt-0.5 line-clamp-2 max-w-[88px] text-center text-[11px] leading-tight text-amber-700 dark:text-amber-300">
            {step.blockedReason}
          </span>
        )}
      </li>
    </Tip>
  )
}

const DOT: Record<StepState, string> = {
  done: 'border-muted-foreground bg-muted-foreground text-card',
  now: 'border-2 border-brand bg-card ring-4 ring-brand/15',
  next: 'border-foreground bg-card',
  later: 'border-dashed border-muted-foreground/50 bg-card',
  blocked: 'border-amber-500 bg-amber-500 text-amber-950 dark:border-amber-400 dark:bg-amber-400',
}

function Dot({ state, small = false }: { state: StepState; small?: boolean }) {
  return (
    <span
      className={`relative z-10 grid shrink-0 place-items-center rounded-full border-[1.5px] ${small ? 'size-4' : 'size-5'} ${DOT[state]}`}
    >
      {state === 'done' && <Check className={small ? 'size-2.5' : 'size-3'} strokeWidth={3} />}
      {state === 'now' && <span className={`rounded-full bg-brand ${small ? 'size-1.5' : 'size-2'}`} />}
      {state === 'blocked' && <span className="text-[10px] leading-none font-bold">!</span>}
    </span>
  )
}
