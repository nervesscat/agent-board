import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type HistoryState, Link, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  Bookmark,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Flag,
  FlagOff,
  GitBranch,
  GitCommitHorizontal,
  Hand,
  History,
  Layers,
  ListPlus,
  ListTodo,
  Lock,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  ScrollText,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  Fragment,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'

import { Actor, useActorKinds } from '#/components/Actor'
import { ComplexitySelect } from '#/components/Complexity'
import { RichEditor } from '#/components/RichEditor'
import { AssigneeSelect } from '#/components/AssigneeSelect'
import { BranchSelect } from '#/components/BranchSelect'
import { StatusSelect } from '#/components/StatusSelect'
import { Attachments } from '#/components/Attachments'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { NeedsField, NeedsStatus, toastRefusal } from '#/components/Needs'
import { NewTicket } from '#/components/NewTicket'
import { cn } from '#/lib/utils'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { RunsCard, useTicketRuns } from '#/components/RunsCard'
import { PrState } from '#/components/PrState'
import { type FeedTab, RESUME_TEMPLATE } from '#/lib/constants'
import { PushBadge, PushDot, RefreshPush } from '#/components/PushDot'
import { Tag, compareTags } from '#/components/Tag'
import { TagsInput, useTagChoices } from '#/components/TagsInput'
import { ReachBadge } from '#/components/ReachBadge'
import { ReviewResultButton } from '#/components/ReviewResult'
import { ActionButton, EditBox, Edited, PostActions } from '#/components/PostTools'
import { Thread } from '#/components/Thread'
import { type Verdict, VerdictButtons, verdictOf } from '#/components/Verdict'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Switch } from '#/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { autoPhaseOf, autoPhaseTip } from '#/lib/autoPhases'
import { WorkTimelineCard } from '#/components/WorkTimelineCard'
import {
  del,
  errorMessage,
  get,
  patch,
  post,
  put,
  upload,
  type TicketFull,
  type TicketGit,
  type SummaryHistory,
  type TicketRow,
  type UpdateRow,
} from '#/lib/api'
import { STATUS_LABEL, ago, agoLong, clock, shortSha, stamp } from '#/lib/format'
import {
  laneStageOrder,
  type LaneFilter,
  type LaneSearch,
  type LaneVerdict,
  LANE_VERDICTS,
  NO_FILTER,
  effectiveFilter,
  isFiltering,
  laneVerdict,
  laneFilter,
  laneNeighbours,
  laneSearch,
  sortLanes,
  stageOk,
  tagOk,
  verdictOk,
  validateLaneSearch,
} from '#/lib/lanes'
import { type AreaId, type Layout, defaultLayout, shownIn } from '#/lib/layout'
import { useProject, useStages } from '#/lib/project'
import { type Anchor, anchorId, useAnchor, useReveal } from '#/lib/reveal'
import { addTags, overTagLimits } from '#/lib/tags'
import { type StepList, columnNeighbours, isClosed, stageBadge, stageOf } from '#/lib/stages'
import { ticketsKey, ticketsQuery } from '#/lib/tickets'

export const Route = createFileRoute('/projects/$id/features/$ticketId')({
  component: TicketPage,
  validateSearch: validateLaneSearch,
})

function TicketPage() {
  const { id, ticketId } = Route.useParams()
  const search = Route.useSearch()
  const filter = laneFilter(search)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const stages = useStages(id)
  // Which sections show, in which column and order: the project's layout, taken once per ticket shown.
  // Until it loads no section is drawn, rather than drawn in its default place and moved (a #link would
  // land on where it was). A layout saved while the ticket is open applies on the next one shown or the
  // next visit: a section that changed column would be drawn afresh, losing what is typed in it.
  const project = useProject(id)
  const live = project.data?.layout ?? (project.isError ? defaultLayout() : undefined)
  const [kept, setKept] = useState<{ ticketId: string; layout: Layout } | null>(null)
  const layout = kept?.ticketId === ticketId ? kept.layout : live
  if (layout && kept?.ticketId !== ticketId) setKept({ ticketId, layout })
  const setFilter = (f: LaneFilter) =>
    navigate({
      to: '/projects/$id/features/$ticketId',
      params: { id, ticketId },
      search: laneSearch(f),
      replace: true,
      // A filter change is the same page: stay where the reader is, and keep the list it steps through.
      resetScroll: false,
      state: true,
    })
  const key = ['ticket', ticketId]
  // Fold the lanes' updates into this ticket's feed.
  const [laneFeed, setLaneFeed] = useState(false)
  const {
    data: t,
    error,
    dataUpdatedAt: readAt,
  } = useQuery({
    queryKey: [...key, laneFeed],
    queryFn: () => get<TicketFull>(`/api/tickets/${ticketId}${laneFeed ? '?lanes=1' : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  })
  const { data: ticketGit } = useQuery({
    queryKey: ['ticket-git', ticketId],
    queryFn: () => get<TicketGit>(`/api/tickets/${ticketId}/git`),
    refetchInterval: 30_000,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ticketsKey(id) })
    qc.invalidateQueries({ queryKey: ['ticket-git', ticketId] })
    // Its repos, and with them its runs, may have changed.
    qc.invalidateQueries({ queryKey: ['ticket-runs'] })
    // The tags the project's tickets carry, offered under every tags field.
    qc.invalidateQueries({ queryKey: ['project', id] })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const update = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch(`/api/tickets/${ticketId}`, p),
    onSuccess: invalidate,
    // A move to done refused for a need not merged yet comes with the human's way past it.
    onError: (err, p) => toastRefusal(err, () => update.mutate({ ...p, force: true })),
  })
  const remove = useMutation({
    mutationFn: (keepLanes: boolean) => del(`/api/tickets/${ticketId}${keepLanes ? '?keepLanes=1' : ''}`),
    onSuccess: () => {
      invalidate()
      const parent = t?.ancestors.at(-1)
      if (parent)
        navigate({ to: '/projects/$id/features/$ticketId', params: { id, ticketId: String(parent.id) } })
      else navigate({ to: '/projects/$id/features', params: { id } })
    },
    onError,
  })
  // The archive is the human's: a finished top-level ticket comes off the board, its lanes with it.
  const archive = useMutation({
    mutationFn: (to: 'archive' | 'restore') => post(`/api/tickets/${ticketId}/${to}`),
    onSuccess: (_d, to) => {
      invalidate()
      toast.success(to === 'archive' ? 'Archived: off the board, under Archived' : 'Restored to the board')
    },
    onError,
  })
  const judge = useMutation({
    mutationFn: (v: { ticketId: number; verdict: Verdict; reopenTo?: string; force?: boolean }) =>
      put(`/api/tickets/${v.ticketId}/approval`, {
        verdict: v.verdict,
        reopenTo: v.reopenTo,
        force: v.force,
      }),
    onSuccess: (_d, v) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
      // The parent's lanes list shows the same call.
      if (t?.parentId) qc.invalidateQueries({ queryKey: ['ticket', String(t.parentId)] })
    },
    // Approving a PR review moves it to done, held to its needs like any move there.
    onError: (err, v) => toastRefusal(err, () => judge.mutate({ ...v, force: true })),
  })
  // On a lane: the parent's lanes, for previous / next under the same filter. Same query as the
  // parent's own page, so it is usually cached already.
  const { data: parent } = useQuery({
    queryKey: ['ticket', String(t?.parentId), false],
    queryFn: () => get<TicketFull>(`/api/tickets/${t!.parentId}`),
    enabled: Boolean(t?.parentId),
    refetchInterval: 10_000,
  })
  // On a top-level ticket: the board's tickets, for previous / next in the same column. Same query
  // as the board, so it is usually cached already.
  const { data: board, dataUpdatedAt: boardReadAt } = useQuery({
    ...ticketsQuery(id, 'root'),
    enabled: Boolean(t) && !t?.parentId,
    refetchInterval: 10_000,
  })
  // A link's #anchor (a post, a reply, the hand-off, the resume note) is brought into view once this
  // ticket is drawn: not while the previous ticket stays on screen until it loads. Stepping to another
  // ticket, the location (and its anchor) is the next one's before this route's params are.
  const anchor = useAnchor()
  const linkedTo = useLocation({ select: (l) => l.pathname.split('/').at(-1) })
  const drawn = t !== undefined && String(t.id) === ticketId && ticketId === linkedTo
  useReveal(anchor, { page: ticketId, ready: drawn && layout !== undefined })
  // A lane's post linked to on this ticket is in the feed with the lanes' posts folded in: folded in
  // once per anchor, so turning it off again stays off.
  const anchoredPost = anchorId(anchor?.holder ?? anchor?.target, 'post')
  const foldedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!drawn || !anchor || anchoredPost === null || laneFeed || foldedFor.current === anchor.hash) return
    if (t.lanes.length && !t.updates.some((u) => u.id === anchoredPost)) {
      foldedFor.current = anchor.hash
      setLaneFeed(true)
    }
  }, [drawn, anchor, anchoredPost, laneFeed, t])

  // Stepping to another ticket, the previous one stays on screen until the new one loads: its git state
  // may come first, and must not show under the previous ticket's branch.
  const git = t && t.id === Number(ticketId) ? ticketGit : undefined
  // Here, not only in the Runs card: with none to show the card is left out, and its column with it.
  const runs = useTicketRuns(t, git)

  if (error) return <p className="text-sm text-destructive">{errorMessage(error)}</p>
  if (!t) return null

  /**
   * Record a verdict. Disapproving cancels the lane, which can drop it out of the filtered list, so
   * from inside a lane it moves on to the next one (worked out before the change), and a toast
   * offers to undo: the lane gets back its stage and earlier call.
   */
  const decide = (
    lane: Pick<TicketFull, 'id' | 'status' | 'approvedAt' | 'approvedBy' | 'disapprovedAt' | 'disapprovedBy'>,
    verdict: Verdict,
  ) => {
    if (verdict !== 'disapproved') return judge.mutate({ ticketId: lane.id, verdict })
    const before = { verdict: verdictOf(lane), status: lane.status }
    const around = lane.id === t.id && parent ? laneNeighbours(parent.lanes, stages, lane.id, filter) : null
    const go = around?.next ?? around?.prev ?? null
    judge.mutate(
      { ticketId: lane.id, verdict },
      {
        onSuccess: () => {
          if (go)
            navigate({
              to: '/projects/$id/features/$ticketId',
              params: { id, ticketId: String(go.id) },
              search: laneSearch(filter),
            })
          toast(`#${lane.id} disapproved and cancelled`, {
            description: `Undo takes back the disapproval and returns it to ${stageOf(stages, before.status).name}${
              go ? `. Moved on to #${go.id}.` : '.'
            }`,
            duration: 10_000,
            action: {
              label: 'Undo',
              onClick: () =>
                judge.mutate({ ticketId: lane.id, verdict: before.verdict, reopenTo: before.status }),
            },
          })
        },
      },
    )
  }
  const openLanes = t.lanes.filter((l) => !isClosed(stageOf(stages, l.status).kind)).length
  const kind = stageOf(stages, t.status).kind
  const lanesWarning = openLanes > 0 && (kind === 'review' || kind === 'done')
  // null: a section with nothing to show on this ticket. It is left out of its column, so a column
  // with nothing left to show is not drawn and the other one takes the page's width.
  const sections: Record<AreaId<'ticket.main'>, ReactNode> = {
    // Keyed by ticket, so an open editor and its draft do not follow to the next one. Not on a
    // ticket that is finished or archived.
    'ticket.resume':
      t.archivedAt || isClosed(kind) ? null : <ResumeNote key={t.id} t={t} onChange={invalidate} />,
    'ticket.instructions': (
      <div id="instructions" className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
        <Instructions key={t.id} t={t} onSave={(body) => update.mutate({ body })} onChange={invalidate} />
      </div>
    ),
    'ticket.tasks': <Tasks t={t} onChange={invalidate} />,
    'ticket.timeline': (
      <div id="timeline" className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
        <WorkTimelineCard key={t.id} t={t} />
      </div>
    ),
    'ticket.lanes': (
      <div id="lanes" className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
        <Lanes t={t} filter={filter} onFilter={setFilter} onVerdict={decide} judging={judge.isPending} />
      </div>
    ),
    'ticket.activity': (
      <div id="activity" className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
        <ShownAnchor value={drawn ? anchor : null}>
          {/* Keyed by ticket: the tab and the draft do not follow to the next one. */}
          <Activity key={t.id} t={t} onChange={invalidate} laneFeed={laneFeed} onLaneFeed={setLaneFeed} />
        </ShownAnchor>
      </div>
    ),
    'ticket.runs': runs.shown ? <RunsCard t={t} git={git} onChange={invalidate} /> : null,
    'ticket.details': <Details key={t.id} t={t} includes={git?.includes} onSave={(p) => update.mutate(p)} />,
    'ticket.branch': <BranchPanel t={t} git={git} />,
    'ticket.workspaces': <WorkspacesPanel t={t} git={git} onChange={invalidate} />,
  }
  const main = layout ? shownIn(layout, 'ticket.main').filter((s) => sections[s] != null) : []
  const side = layout ? shownIn(layout, 'ticket.side').filter((s) => sections[s] != null) : []

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link to="/projects/$id/features" params={{ id }} className="hover:text-foreground">
          Ongoing features
        </Link>
        {t.ancestors.map((a) => (
          <span key={a.id} className="inline-flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0" />
            <Link
              to="/projects/$id/features/$ticketId"
              params={{ id, ticketId: String(a.id) }}
              // Back to the parent's list with the filter it had.
              search={a.id === t.parentId ? laneSearch(filter) : {}}
              className="max-w-64 truncate hover:text-foreground"
            >
              #{a.id} {a.title}
            </Link>
          </span>
        ))}
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">#{t.id}</span>
        {parent && <LaneNav projectId={id} lanes={parent.lanes} id={t.id} filter={filter} />}
        {!t.parentId && !t.prId && board && (
          <StageNav key={t.id} projectId={id} tickets={board} t={t} pageIsNewer={readAt >= boardReadAt} />
        )}
      </nav>

      {/* The header stays in view once scrolled up to the top bar (h-12 and its border), with the
            page scrolling under it: opaque, above the feed's positioned bits, below the top bar.
            Its padding keeps the title off the top bar's edge; the margins take it back at rest. */}
      <header
        ref={measureHeader}
        className="sticky top-[calc(3rem+1px)] z-10 -my-2 flex flex-wrap items-start gap-3 bg-background py-2"
      >
        {/* At least 12rem wide: a toolbar too wide to sit beside it wraps under it, not squeezes the title. */}
        <div className="min-w-48 flex-1">
          <InlineTitle key={t.id} t={t} onSave={(title) => update.mutate({ title })} />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              opened by <Actor name={t.createdBy} truncate short /> {ago(t.createdAt)}
            </span>
            <span>updated {ago(t.updatedAt)}</span>
            <InlineTags key={t.id} t={t} projectId={id} onSave={(tags) => update.mutate({ tags })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {t.archivedAt && (
            <Tip
              content={`Archived by ${t.archivedBy || 'someone'} ${ago(t.archivedAt)}${t.parentId ? ', with the ticket it is a lane of' : ''}`}
            >
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                <Archive className="size-3.5" /> Archived
              </span>
            </Tip>
          )}
          {t.archivedAt && !t.parentId && (
            <Button
              variant="outline"
              size="sm"
              disabled={archive.isPending}
              onClick={() => archive.mutate('restore')}
            >
              <ArchiveRestore /> Restore
            </Button>
          )}
          {lanesWarning && (
            <Tip content="This ticket is marked further along than its lanes">
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="size-3.5" /> {openLanes} lane{openLanes === 1 ? '' : 's'} not done
              </span>
            </Tip>
          )}
          <NeedsStatus t={t} />
          {t.updates.some((u) => u.decision && !u.decidedAt) && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
              <Scale className="size-3.5" /> decision needed
            </span>
          )}
          {(t.parentId || verdictOf(t)) && (
            <VerdictButtons t={t} disabled={judge.isPending} onSet={(verdict) => decide(t, verdict)} />
          )}
          <StatusSelect stages={stages} value={t.status} onChange={(status) => update.mutate({ status })} />
          <div className="flex items-center gap-1.5">
            <Label htmlFor="complexity" className="text-xs font-normal text-muted-foreground">
              Complexity
            </Label>
            <ComplexitySelect
              id="complexity"
              value={t.complexity}
              onChange={(complexity) => update.mutate({ complexity })}
            />
          </div>
          {!t.archivedAt && !t.parentId && isClosed(kind) && (
            <Tip content="Take it off the board, with its lanes; Archived on the features page brings it back">
              <Button
                variant="outline"
                size="sm"
                disabled={archive.isPending}
                onClick={() => archive.mutate('archive')}
              >
                <Archive /> Archive
              </Button>
            </Tip>
          )}
          {/* A PR's ticket cannot be deleted: it is archived instead. */}
          {!t.prId && (
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" />}>
                <Trash2 />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this ticket?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Tasks, updates, attachments and the thread go with it.
                    {t.lanes.length > 0 &&
                      ` It has ${t.lanes.length} lane${t.lanes.length === 1 ? '' : 's'}: delete them too, or keep them and move them up a level.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  {t.lanes.length > 0 && (
                    <AlertDialogAction variant="outline" onClick={() => remove.mutate(true)}>
                      Delete, keep lanes
                    </AlertDialogAction>
                  )}
                  <AlertDialogAction onClick={() => remove.mutate(false)}>
                    {t.lanes.length > 0 ? 'Delete with lanes' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </header>

      {/* One column when the layout leaves the other empty. */}
      <div
        className={cn(
          'grid grid-cols-1 gap-6',
          main.length > 0 && side.length > 0 && 'lg:grid-cols-[minmax(0,1fr)_18rem]',
        )}
      >
        {/* minmax(0,…) and min-w-0: a long line (a lane's last update, a code block) must not
              widen the page */}
        {main.length > 0 && (
          <div data-ticket-column="main" className="min-w-0 space-y-6">
            <TicketSectionNav hasSummary={Boolean(t.summary)} />
            {t.summary && (
              <div id="summary" className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
                <ShownAnchor value={drawn ? anchor : null}>
                  <SummaryCard t={t} />
                </ShownAnchor>
              </div>
            )}
            {main.map((s) => (
              <Fragment key={s}>{sections[s]}</Fragment>
            ))}
          </div>
        )}
        {side.length > 0 && (
          <aside data-ticket-column="side" className="min-w-0 space-y-4">
            {side.map((s) => (
              <Fragment key={s}>{sections[s]}</Fragment>
            ))}
          </aside>
        )}
      </div>
    </div>
  )
}

/** The anchor of the URL to the feed's posts, once the ticket it is on is the one shown. */
const ShownAnchor = createContext<Anchor | null>(null)

/**
 * How far down the stuck header reaches (the top bar and itself), as --ticket-header on the page: what
 * the page scrolls to (#resume) stops below it rather than behind it. Not the page's scroll padding,
 * which would count the header's own fields as hidden behind it and scroll away when they take focus.
 */
function measureHeader(header: HTMLElement | null) {
  const page = header?.parentElement
  if (!header || !page) return
  const measure = () =>
    page.style.setProperty(
      '--ticket-header',
      `${parseFloat(getComputedStyle(header).top) + header.offsetHeight}px`,
    )
  measure()
  const resized = new ResizeObserver(measure)
  resized.observe(header)
  return () => {
    resized.disconnect()
    page.style.removeProperty('--ticket-header')
  }
}

/** The title, renamed where it is: click it, Enter or leaving the field saves, Esc cancels. */
function InlineTitle({ t, onSave }: { t: TicketFull; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(t.title)
  const done = (save: boolean) => {
    setEditing(false)
    const title = value.trim()
    if (save && title && title !== t.title) onSave(title)
  }
  if (editing)
    return (
      <Input
        aria-label="Title"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done(true)
          if (e.key === 'Escape') done(false)
        }}
        className="h-9 text-lg font-semibold"
      />
    )
  return (
    <h1 className="text-xl font-semibold tracking-tight">
      <span className="text-muted-foreground">#{t.id}</span>{' '}
      <Tip content="Click to rename">
        <button
          type="button"
          onClick={() => {
            setValue(t.title)
            setEditing(true)
          }}
          className="cursor-text text-left decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:underline"
        >
          {t.title}
        </button>
      </Tip>
    </h1>
  )
}

/**
 * The tags, edited where they are as chips (`TagsInput`), with the project's suggestions and used tags
 * offered under them. Enter on an empty text or leaving the field and its chips saves, Esc cancels.
 */
function InlineTags({
  t,
  projectId,
  onSave,
}: {
  t: TicketFull
  projectId: string
  onSave: (tags: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState<string[]>([])
  const [text, setText] = useState('')
  const choices = useTagChoices(projectId, value)
  const focusText = useCallback((el: HTMLDivElement | null) => el?.querySelector('input')?.focus(), [])
  const done = (save: boolean) => {
    setEditing(false)
    const tags = addTags(value, text)
    const over = overTagLimits(tags)
    // Tags the server would refuse are not sent: the ticket keeps the ones it has.
    if (save && !over.tooMany && !over.tooLong && tags.join('\n') !== t.tags.join('\n')) onSave(tags)
  }
  if (editing)
    return (
      <div
        className="w-full max-w-sm min-w-0 space-y-1"
        ref={focusText}
        onBlur={(e) => {
          // Leaving for another window keeps the edit; leaving the field and its chips ends it.
          if (!document.hasFocus() || e.currentTarget.contains(e.relatedTarget as Node | null)) return
          done(true)
        }}
        onKeyDown={(e) => {
          if (e.defaultPrevented || e.nativeEvent.isComposing) return
          // Enter in the text saves; Enter on a suggested chip is the chip's own, and adds its tag.
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !text.trim()) {
            e.preventDefault()
            done(true)
          }
          if (e.key === 'Escape') done(false)
        }}
      >
        <TagsInput
          aria-label="Tags, comma separated"
          value={value}
          onChange={setValue}
          text={text}
          onTextChange={setText}
          placeholder="High, Forms"
          choices={choices}
          className="min-h-6 text-xs md:text-xs"
        />
      </div>
    )
  const open = () => {
    setValue(t.tags)
    setText('')
    setEditing(true)
  }
  return t.tags.length > 0 ? (
    <Tip content="Click to edit the tags">
      <button type="button" onClick={open} className="inline-flex flex-wrap gap-1">
        {[...t.tags].sort(compareTags).map((tag) => (
          <Tag key={tag} tag={tag} />
        ))}
      </button>
    </Tip>
  ) : (
    <button type="button" onClick={open} className="hover:text-foreground">
      + tags
    </button>
  )
}

/**
 * The instructions, edited where they are with the rich text editor (click the text, or "edit"), and
 * the files that go with them: attach (in the editor's toolbar while editing), paste or drop to add, ×
 * to remove. Files are kept as soon as they are added; the text when saved.
 */
function Instructions({
  t,
  onSave,
  onChange,
}: {
  t: TicketFull
  onSave: (body: string) => void
  onChange: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState(t.body)
  const fileInput = useRef<HTMLInputElement>(null)
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const attach = useMutation({
    mutationFn: async (files: File[]) => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      return post(`/api/tickets/${t.id}/attachments`, { attachmentIds })
    },
    onSuccess: onChange,
    onError,
  })
  const detach = useMutation({
    mutationFn: (attachmentId: number) => del(`/api/tickets/${t.id}/attachments/${attachmentId}`),
    onSuccess: onChange,
    onError,
  })
  const drop = useFileDrop((files) => attach.mutate(files))
  const open = () => {
    setBody(t.body)
    setEditing(true)
  }
  const save = () => {
    if (body !== t.body) onSave(body)
    setEditing(false)
  }
  return (
    <section
      {...drop.props}
      className={cn('rounded-lg border p-4', drop.className)}
      aria-label="Instructions"
    >
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm font-medium">Instructions</h2>
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length) attach.mutate(files)
              e.target.value = ''
            }}
          />
          {!editing && (
            <>
              <Button type="button" variant="ghost" size="xs" onClick={() => fileInput.current?.click()}>
                <Paperclip data-icon="inline-start" /> {attach.isPending ? 'attaching…' : 'attach'}
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={open}>
                <Pencil data-icon="inline-start" /> edit
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <RichEditor
            value={body}
            onChange={setBody}
            onFiles={(files) => attach.mutate(files)}
            onAttach={() => fileInput.current?.click()}
            attaching={attach.isPending}
            onSubmit={save}
            onCancel={() => setEditing(false)}
            autoFocus
            minHeight="min-h-40"
            label="Instructions"
            placeholder="What to do, how to know it is done, what never to do. Paste or drop files to attach them."
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : t.body ? (
        <>
          {/* Clicking the text edits it; a link inside still opens. */}
          <Tip content="Click to edit">
            <div
              role="button"
              tabIndex={0}
              className="cursor-text rounded-md hover:bg-muted/30"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('a, img')) open()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') open()
              }}
            >
              <div className={cn(!expanded && 'max-md:max-h-64 max-md:overflow-hidden')}>
                <Markdown>{t.body}</Markdown>
              </div>
            </div>
          </Tip>
          {t.body.length > 600 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 md:hidden"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show full instructions'}
            </Button>
          )}
        </>
      ) : (
        <button type="button" onClick={open} className="text-sm text-muted-foreground hover:text-foreground">
          No instructions yet. Click to write them.
        </button>
      )}
      {t.attachments.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <Attachments items={t.attachments} />
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {t.attachments.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1">
                <span className="max-w-48 truncate">{a.name}</span>
                <Tip content={`Remove ${a.name}`}>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    className="hover:text-destructive"
                    onClick={() => detach.mutate(a.id)}
                  >
                    <X className="size-3" />
                  </button>
                </Tip>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * "Resume here": the ticket's one current resume note, pinned above the instructions while the ticket
 * is open and has a note, or carried over from an earlier day without one. Alongside it, what is
 * true now: commits since the note, tasks left, open decisions and threads, which day of work this
 * is. Edited like the instructions; an empty note starts from the template. On any other open ticket
 * a one-line button writes the first one.
 */
/** Shown only on a ticket still open and not archived: the page leaves it out otherwise. */
function ResumeNote({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const r = t.resume
  const save = useMutation({
    mutationFn: () => put(`/api/tickets/${t.id}/resume`, { note }),
    onSuccess: () => {
      setEditing(false)
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const open = () => {
    setNote(r.note || RESUME_TEMPLATE)
    setEditing(true)
  }
  const submit = () => {
    if (note.trim() && !save.isPending) save.mutate()
  }
  if (!r.note && !r.noHandoff && !editing)
    return (
      <button
        type="button"
        onClick={open}
        className="-mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Bookmark className="size-3.5" /> Leave a resume note: where the work stands, for whoever picks it up
        next
      </button>
    )

  const own = t.updates.filter((u) => !u.lane)
  const tasksLeft = t.tasks.filter((x) => !x.done).length
  const decisions = own.filter((u) => u.decision && !u.decidedAt).length
  // Discussion where someone other than the assignee spoke last: waiting on whoever works the ticket.
  const waiting = t.assignee
    ? own.filter(
        (u) => !u.progress && !u.decision && !u.summary && (u.thread.lastAuthor ?? u.author) !== t.assignee,
      ).length
    : 0
  const commits = r.commitsSince ?? 0
  const chip = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5'
  const warn = `${chip} bg-amber-500/10 text-amber-700 dark:text-amber-400`
  return (
    // Linked to as #resume (from the summary's Carrying over), and brought into view as any anchor is.
    <section
      id="resume"
      className={cn(
        // Below the stuck header, as far as it is at rest; until that is measured, below the top bar.
        'scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-lg border p-4',
        r.noHandoff ? 'border-amber-500/60 bg-amber-500/5' : 'border-primary/30 bg-primary/5',
      )}
      aria-label="Resume here"
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Bookmark className="size-4" /> Resume here
        </h2>
        {r.at && (
          <Tip content={stamp(r.at)}>
            <span className="text-xs text-muted-foreground">
              by <Actor name={r.by} /> {ago(r.at)}
              {r.sha && <span className="font-mono"> at {shortSha(r.sha)}</span>}
            </span>
          </Tip>
        )}
        {!editing && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={open}>
            <Pencil data-icon="inline-start" /> {r.note ? 'edit' : 'write'}
          </Button>
        )}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
        {commits > 0 && (
          <Tip content="Commits on the ticket's branch after the note was written">
            <span className={warn}>
              <GitCommitHorizontal className="size-3.5" /> {plural(commits, 'commit')} since this note
            </span>
          </Tip>
        )}
        {r.stale && commits === 0 && (
          <Tip content="A progress post came after the note">
            <span className={warn}>
              <TriangleAlert className="size-3.5" /> progress posted since this note
            </span>
          </Tip>
        )}
        {r.noHandoff && r.note && (
          <Tip content="It was worked on a later day than this note was written">
            <span className={warn}>
              <TriangleAlert className="size-3.5" /> no resume note since the last session
            </span>
          </Tip>
        )}
        {t.tasks.length > 0 && (
          <span className={cn(chip, 'bg-muted')}>
            <ListTodo className="size-3.5" />{' '}
            {tasksLeft ? `${plural(tasksLeft, 'task')} left` : 'all tasks done'}
          </span>
        )}
        {decisions > 0 && (
          <span className={warn}>
            <Scale className="size-3.5" /> {plural(decisions, 'open decision')}
          </span>
        )}
        {waiting > 0 && (
          <Tip content={`Posts where someone spoke after ${t.assignee}, the assignee`}>
            <span className={cn(chip, 'bg-muted')}>
              <MessageSquare className="size-3.5" /> {plural(waiting, 'unanswered thread')}
            </span>
          </Tip>
        )}
        {r.day !== null && (
          <Tip content={t.startedAt ? `Work on it started ${stamp(t.startedAt)}` : undefined}>
            <span className={cn(chip, 'bg-muted')}>
              <CalendarDays className="size-3.5" /> day {r.day} in progress
            </span>
          </Tip>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <RichEditor
            value={note}
            onChange={setNote}
            onSubmit={submit}
            onCancel={() => setEditing(false)}
            autoFocus
            minHeight="min-h-40"
            label="Resume note"
            placeholder="Where the work stands, what is next, how to pick it up."
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              Saving also posts it to the feed, so earlier notes stay readable.
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!note.trim() || save.isPending} onClick={submit}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : r.note ? (
        <Markdown>{r.note}</Markdown>
      ) : (
        <div className="text-sm">
          <p className="font-medium">No resume note yet</p>
          <p className="text-muted-foreground">
            This ticket was already being worked on an earlier day, and nobody wrote down where it was left.{' '}
            <button
              type="button"
              onClick={open}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Write the resume note
            </button>{' '}
            so the next session can pick it up without asking.
          </p>
        </div>
      )}
    </section>
  )
}

/** A repo of the ticket as a write of its repos gives it back: what it has now. */
const repoInput = (r: TicketFull['repos'][number]) => ({
  repoId: r.repoId,
  branch: r.branch,
  baseBranch: r.baseBranch,
  prNumber: r.prNumber,
})

/**
 * The ticket's repos beyond the primary (the Repository field above): each with its own branch, and
 * a way to take one off or add another repo of the project. Each change saves the whole list.
 */
function OtherRepos({
  t,
  repos,
  onSave,
}: {
  t: TicketFull
  repos: { id: number; name: string }[]
  onSave: (p: Record<string, unknown>) => void
}) {
  const others = t.repos.filter((r) => !r.primary)
  const addable = repos.filter((r) => !t.repos.some((x) => x.repoId === r.id))
  const save = (next: TicketFull['repos']) => onSave({ repos: next.map(repoInput) })
  // A branch typed by hand saves once typing stops, as the primary's does.
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const [typed, setTyped] = useState<Record<number, string>>({})
  const setBranch = (repoId: number, branch: string) => {
    setTyped((b) => ({ ...b, [repoId]: branch }))
    clearTimeout(timers.current[repoId])
    timers.current[repoId] = setTimeout(() => {
      save(t.repos.map((r) => (r.repoId === repoId ? { ...r, branch } : r)))
      setTyped(({ [repoId]: _done, ...rest }) => rest)
    }, 700)
  }
  return (
    <div className="space-y-2">
      <Tip content="The ticket's work in other repos of the project, each on its own branch: they show in Branch and Runs">
        <Label className="text-xs text-muted-foreground">Other repositories</Label>
      </Tip>
      {others.map((r) => (
        <div key={r.repoId} className="space-y-1" role="group" aria-label={`Repository ${r.name}`}>
          <div className="flex items-center gap-2">
            <Label htmlFor={`branch-${r.repoId}`} className="font-mono text-xs">
              {r.name}
            </Label>
            <Tip content={`Take ${r.name} off the ticket (its runs for the ticket stop)`}>
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${r.name}`}
                onClick={() => save(t.repos.filter((x) => x.repoId !== r.repoId))}
              >
                <X className="size-3.5" />
              </button>
            </Tip>
          </div>
          <BranchSelect
            id={`branch-${r.repoId}`}
            value={typed[r.repoId] ?? r.branch}
            repoId={r.repoId}
            optional
            onChange={(v) => setBranch(r.repoId, v)}
          />
        </div>
      ))}
      {addable.length > 0 && (
        <Select
          value=""
          onValueChange={(v) => {
            if (v)
              save([
                ...t.repos,
                { repoId: Number(v), name: '', branch: '', baseBranch: '', prNumber: null, primary: false },
              ])
          }}
          items={Object.fromEntries(addable.map((r) => [String(r.id), r.name]))}
        >
          <SelectTrigger className="w-full" aria-label="Add a repository">
            <SelectValue placeholder="Add a repository…" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((r) => (
              <SelectItem key={r.id} value={String(r.id)}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

/** Who, where, and what it needs merged first: each field saves as soon as it changes. */
function Details({
  t,
  includes,
  onSave,
}: {
  t: TicketFull
  includes?: number[]
  onSave: (p: Record<string, unknown>) => void
}) {
  const { data: project } = useProject(t.projectId)
  const repos = project?.repos ?? []
  const repoId = String(t.repoId ?? repos[0]?.id ?? '')
  const [branch, setBranch] = useState(t.branch)
  const [baseBranch, setBaseBranch] = useState(t.baseBranch)
  // A branch typed by hand (when the repo's branches cannot be listed) saves once typing stops.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const later = (field: 'branch' | 'baseBranch', value: string) => {
    clearTimeout(timers.current[field])
    timers.current[field] = setTimeout(() => onSave({ [field]: value }), 700)
  }
  // Agents change these too; follow the ticket unless a field is being typed in.
  useEffect(() => setBranch(t.branch), [t.branch])
  useEffect(() => setBaseBranch(t.baseBranch), [t.baseBranch])
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Details">
      <div className="space-y-1">
        <Label htmlFor="assignee" className="text-xs text-muted-foreground">
          Assignee
          {t.reserved && (
            <Tip content="Reserved for this project agent: other agents cannot take it, only you can reassign it">
              <span className="ml-auto inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-normal">
                <Lock className="size-3" /> reserved
              </span>
            </Tip>
          )}
        </Label>
        <AssigneeSelect id="assignee" value={t.assignee} onChange={(assignee) => onSave({ assignee })} />
      </div>
      {repos.length > 1 && (
        <div className="space-y-1">
          <Label htmlFor="repo" className="text-xs text-muted-foreground">
            Repository
          </Label>
          <Select
            value={repoId}
            onValueChange={(v) => {
              if (!v || v === repoId) return
              // One of the ticket's other repos becomes its primary; any other repo replaces the primary.
              const picked = t.repos.find((r) => r.repoId === Number(v))
              onSave(
                picked
                  ? { repos: [picked, ...t.repos.filter((r) => r !== picked)].map(repoInput) }
                  : { repoId: Number(v) },
              )
            }}
            items={Object.fromEntries(repos.map((r) => [String(r.id), r.name]))}
          >
            <SelectTrigger id="repo" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="branch" className="text-xs text-muted-foreground">
          Branch
        </Label>
        <BranchSelect
          id="branch"
          value={branch}
          repoId={repoId}
          optional
          onChange={(v) => {
            setBranch(v)
            if (v !== t.branch) later('branch', v)
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="base" className="text-xs text-muted-foreground">
          Base branch
        </Label>
        <BranchSelect
          id="base"
          value={baseBranch}
          repoId={repoId}
          onChange={(v) => {
            setBaseBranch(v)
            if (v && v !== t.baseBranch) later('baseBranch', v)
          }}
        />
      </div>
      {repos.length > 1 && !t.prId && <OtherRepos t={t} repos={repos} onSave={onSave} />}
      <div className="space-y-1">
        <Tip content="Tickets whose branches must be merged into this one's base before it can be done">
          <Label htmlFor="needs" className="text-xs text-muted-foreground">
            Needs
            {t.neededBy.length > 0 && (
              <span className="ml-auto font-normal">
                needed by{' '}
                {t.neededBy.map((n, i) => (
                  <span key={n.id}>
                    {i > 0 && ', '}
                    <Tip content={n.title}>
                      <Link
                        to="/projects/$id/features/$ticketId"
                        params={{ id: String(t.projectId), ticketId: String(n.id) }}
                        className="hover:text-foreground hover:underline"
                      >
                        #{n.id}
                      </Link>
                    </Tip>
                  </span>
                ))}
              </span>
            )}
          </Label>
        </Tip>
        <NeedsField t={t} includes={includes} onSave={(needs) => onSave({ needs })} />
      </div>
    </section>
  )
}

/**
 * The ticket's tasks, two levels: each top-level task with its subtasks indented under it, and a way
 * to add subtasks to a top-level task. The counter takes in tasks and subtasks alike. The top level
 * holds the phases (a new ticket starts with its project's: Implementation, then the hand-off's) and
 * the concrete steps go under Implementation, as the empty state and the add field say. Any task can
 * be tagged blocked on the human, with what they must do; a task shows how many of its subtasks are.
 */
function Tasks({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const [text, setText] = useState('')
  // The task whose "add a subtask" field is open, and what is typed in it.
  const [subtaskOf, setSubtaskOf] = useState<number | null>(null)
  const [subtext, setSubtext] = useState('')
  // The task being marked blocked, and the reason typed for it.
  const [blocking, setBlocking] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: (v: { text: string; parentTaskId?: number }) =>
      post(`/api/tickets/${t.id}/tasks`, { tasks: [v.text], parentTaskId: v.parentTaskId }),
    onSuccess: (_data, v) => {
      if (v.parentTaskId) setSubtext('')
      else setText('')
      onChange()
    },
    onError,
  })
  const toggle = useMutation({
    mutationFn: (v: { id: number; done: boolean }) => patch(`/api/tasks/${v.id}`, { done: v.done }),
    onSuccess: onChange,
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/tasks/${id}`),
    onSuccess: onChange,
    onError,
  })
  // Tagging a done task reopens it, and ticking a blocked one clears the tag: the server keeps both.
  const tag = useMutation({
    mutationFn: (v: { id: number; blocked: boolean; reason?: string }) =>
      patch(
        `/api/tasks/${v.id}`,
        v.blocked && v.reason ? { blocked: true, blockedReason: v.reason } : { blocked: v.blocked },
      ),
    onSuccess: (_data, v) => {
      if (v.blocked) setBlocking(null)
      onChange()
    },
    onError,
  })
  const pct = t.progress.total ? Math.round((100 * t.progress.done) / t.progress.total) : 0
  const row = (task: TicketFull['tasks'][number], subtask: boolean) => {
    const blockedSubtasks = subtask ? 0 : t.tasks.filter((s) => s.parentId === task.id && s.blocked).length
    // A phase the board ticks from git, GitHub, the previews or the posts: no tick by hand.
    const auto = task.auto ? autoPhaseOf(task) : null
    return (
      // A summary's blocked task lands here as #task-<id> (src/lib/reveal.ts).
      <div id={`task-${task.id}`} className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)]">
        <div className="group flex items-center gap-2">
          <Checkbox
            checked={task.done}
            disabled={auto !== null}
            onCheckedChange={(v) => toggle.mutate({ id: task.id, done: Boolean(v) })}
            aria-label={task.text}
          />
          <span className={task.done ? 'text-muted-foreground line-through' : ''}>{task.text}</span>
          {auto && (
            <Tip content={autoPhaseTip(auto)}>
              <span
                role="img"
                tabIndex={0}
                aria-label="Ticked automatically"
                className="shrink-0 text-muted-foreground"
              >
                <RefreshCw className="size-3.5" />
              </span>
            </Tip>
          )}
          {task.blocked && <span className={BLOCKED_CHIP}>blocked</span>}
          {blockedSubtasks > 0 && (
            <span className={BLOCKED_CHIP}>
              {blockedSubtasks === 1 ? '1 subtask blocked' : `${blockedSubtasks} subtasks blocked`}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
            {/* Tagging a done phase blocked would untick it by hand. */}
            {!(auto && task.done) && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (task.blocked) tag.mutate({ id: task.id, blocked: false })
                  else {
                    setBlocking(task.id)
                    setReason('')
                  }
                }}
                aria-label={task.blocked ? `Unblock ${task.text}` : `Mark ${task.text} blocked`}
              >
                <Hand
                  className={cn(
                    'size-3.5',
                    task.blocked ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                  )}
                />
              </Button>
            )}
            {!subtask && (
              <Tip content="Add a subtask">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSubtaskOf(task.id)
                    setSubtext('')
                  }}
                  aria-label={`Add a subtask to ${task.text}`}
                >
                  <ListPlus className="size-3.5 text-muted-foreground" />
                </Button>
              </Tip>
            )}
            <Tip
              content={
                subtask || !t.tasks.some((s) => s.parentId === task.id)
                  ? 'remove'
                  : 'remove, with its subtasks'
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove.mutate(task.id)}
                aria-label={`Remove ${task.text}`}
              >
                <X className="size-3.5 text-muted-foreground" />
              </Button>
            </Tip>
          </span>
        </div>
        {task.blocked && task.blockedReason && (
          <p className="mt-0.5 ml-6 text-xs text-amber-700 dark:text-amber-400">{task.blockedReason}</p>
        )}
        {blocking === task.id && (
          <form
            className="mt-1.5 ml-6 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              tag.mutate({ id: task.id, blocked: true, reason: reason.trim() })
            }}
          >
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setBlocking(null)
              }}
              maxLength={500}
              placeholder="What the human must do (optional)"
              aria-label={`Why ${task.text} is blocked`}
              className="h-7"
            />
            <Button type="submit" size="sm" variant="outline" disabled={tag.isPending}>
              <Hand data-icon="inline-start" /> Mark blocked
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setBlocking(null)}
              aria-label="Close"
            >
              <X />
            </Button>
          </form>
        )}
      </div>
    )
  }
  return (
    // A link lands on it as #tasks (src/lib/reveal.ts), below the ticket page's stuck header.
    <section
      id="tasks"
      className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-lg border p-4"
      aria-label="Tasks"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Tasks</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t.progress.done}/{t.progress.total} · {pct}%
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      {t.tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No tasks yet. Add the phases a new ticket starts with: Implementation, then the hand-off&apos;s
          (Pushed, PR, CI, Preview, Summary, Merged). The concrete steps go under Implementation as subtasks.
          The board ticks Pushed, PR, CI, Preview, Summary and Merged itself.
        </p>
      )}
      <ul className="space-y-1.5">
        {t.tasks
          .filter((task) => !task.parentId)
          .map((task) => {
            const subtasks = t.tasks.filter((s) => s.parentId === task.id)
            return (
              <li key={task.id} className="text-sm">
                {row(task, false)}
                {subtasks.length > 0 && (
                  <ul className="mt-1.5 ml-6 space-y-1.5" aria-label={`Subtasks of ${task.text}`}>
                    {subtasks.map((s) => (
                      <li key={s.id}>{row(s, true)}</li>
                    ))}
                  </ul>
                )}
                {subtaskOf === task.id && (
                  <form
                    className="mt-1.5 ml-6 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (subtext.trim()) add.mutate({ text: subtext, parentTaskId: task.id })
                    }}
                  >
                    <Input
                      autoFocus
                      value={subtext}
                      onChange={(e) => setSubtext(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setSubtaskOf(null)
                      }}
                      placeholder="Add a subtask"
                      aria-label={`New subtask of ${task.text}`}
                      className="h-7"
                    />
                    <Button type="submit" size="sm" variant="outline" disabled={!subtext.trim()}>
                      <Plus data-icon="inline-start" /> Add
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSubtaskOf(null)}
                      aria-label="Close"
                    >
                      <X />
                    </Button>
                  </form>
                )}
              </li>
            )
          })}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) add.mutate({ text })
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a phase: Implementation, Pushed, PR…"
          className="h-8"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
          <Plus data-icon="inline-start" /> Add
        </Button>
      </form>
    </section>
  )
}

const BLOCKED_CHIP =
  'shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] leading-none font-medium text-amber-700 dark:text-amber-400'

const VERDICT_LABEL: Record<LaneVerdict, string> = {
  approved: 'Approved',
  disapproved: 'Disapproved',
  none: 'No call',
}
const VERDICT_TAG: Record<LaneVerdict, string> = {
  approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  disapproved: 'bg-red-500/15 text-red-700 dark:text-red-400',
  none: 'bg-muted text-muted-foreground',
}

/** One row of filter chips: "All" clears it, each chip toggles; a chip with nothing to show dims. */
function FilterRow<K extends string>({
  label,
  chips,
  active,
  onToggle,
  onClear,
}: {
  label: string
  chips: { key: K; label: ReactNode; count: number }[]
  active: K[]
  onToggle: (key: K) => void
  onClear: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={onClear}
        className={`rounded-full border px-2.5 py-0.5 transition-colors ${
          active.length ? 'text-muted-foreground hover:text-foreground' : 'border-foreground/40 bg-muted'
        }`}
      >
        All
      </button>
      {chips.map((c) => {
        const on = active.includes(c.key)
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(c.key)}
            className={`inline-flex items-center gap-1 rounded-full border px-1 py-0.5 pr-2.5 transition-colors ${
              on ? 'border-foreground/40 bg-muted' : 'border-transparent hover:border-border'
            } ${(active.length && !on) || c.count === 0 ? 'opacity-50 hover:opacity-100' : ''}`}
          >
            {c.label}
            <span className="tabular-nums text-muted-foreground">{c.count}</span>
          </button>
        )
      })}
    </div>
  )
}

/** "‹ 3 of 12 ›" among the parent's lanes, in the list's order and under its filter. */
function LaneNav({
  projectId,
  lanes,
  id,
  filter,
}: {
  projectId: string
  lanes: TicketFull['lanes']
  id: number
  filter: LaneFilter
}) {
  const stages = useStages(projectId)
  const { prev, next, index, count, filtered } = laneNeighbours(lanes, stages, id, filter)
  return (
    <StepNav projectId={projectId} prev={prev} next={next} search={laneSearch(filter)} noun="lane">
      {index >= 0 ? `lane ${index + 1} of ${count}` : `${count} lane${count === 1 ? '' : 's'}`}
      {filtered && ' (filtered)'}
    </StepNav>
  )
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** The tickets ‹ › were stepping through on the ticket page this one was stepped to from. */
    stepList?: StepList
  }
}

/**
 * "‹ 3 of 7 in In progress ›" among the top-level tickets in a board column, in its order: the list the
 * reader stepped here through, else this ticket's column. The list holds on through stage changes, like
 * the lanes do: a ticket moved out of its stage, this one too, keeps its place in it until the reader
 * leaves the steps. This ticket's own stage and place come from whichever was read last, its page or
 * the board's list: the page has a stage change made here before the list catches up, and the list has
 * a placement made on the board, which ranks the tickets above the moved one too, before their pages
 * are read again.
 */
function StageNav({
  projectId,
  tickets,
  t,
  pageIsNewer,
}: {
  projectId: string
  tickets: TicketRow[]
  t: TicketFull
  pageIsNewer: boolean
}) {
  const stages = useStages(projectId)
  const stepped = useLocation({ select: (l) => l.state.stepList })
  // The list as this page last had it (the page is keyed by ticket), so moving this ticket keeps it.
  const [kept, setKept] = useState<StepList>()
  const listed = tickets.find((x) => x.id === t.id)
  const self = pageIsNewer || !listed ? t : listed
  const rows = [...tickets.filter((x) => x.id !== t.id && x.parentId === null), self]
  const around = columnNeighbours(rows, t.id, kept ?? stepped)
  const list = around?.list
  const same = list && kept && list.stage === kept.stage && list.ids.join() === kept.ids.join()
  useEffect(() => {
    if (list && !same) setKept(list)
  }, [list, same])
  if (!around || !list) return null
  const stage = stageOf(stages, list.stage)
  return (
    <StepNav
      projectId={projectId}
      prev={around.prev}
      next={around.next}
      state={{ stepList: list }}
      noun={`ticket in ${stage.name}`}
    >
      {around.index + 1} of {around.count} in {stage.name}
    </StepNav>
  )
}

type Step = { id: number; title: string } | null

/** Focus on something that takes typing or its own keys: `[` and `]` are left to it. */
const keepsKeys = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    Boolean(
      el.closest(
        'input, textarea, select, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]',
      ),
    ))

/**
 * "‹ label ›": links to the previous and next ticket, each titled with its ticket, greyed out at the
 * ends. `[` and `]` follow them too, unless the reader is typing.
 */
function StepNav({
  projectId,
  prev,
  next,
  search = {},
  state,
  noun,
  children,
}: {
  projectId: string
  prev: Step
  next: Step
  search?: LaneSearch
  /** History state for the page stepped to. */
  state?: HistoryState
  noun: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || keepsKeys(e.target)) return
      const to = e.key === '[' ? prev : e.key === ']' ? next : null
      if (!to) return
      e.preventDefault()
      navigate({
        to: '/projects/$id/features/$ticketId',
        params: { id: projectId, ticketId: String(to.id) },
        search,
        state,
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, projectId, prev, next, search, state])
  const step = (to: Step, dir: 'prev' | 'next') => {
    const icon = dir === 'prev' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />
    return to ? (
      <Tip content={`#${to.id} ${to.title}`}>
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: projectId, ticketId: String(to.id) }}
          search={search}
          state={state}
          className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-muted hover:text-foreground"
          aria-label={`${dir === 'prev' ? 'Previous' : 'Next'} ${noun}`}
          aria-keyshortcuts={dir === 'prev' ? '[' : ']'}
        >
          {icon}
        </Link>
      </Tip>
    ) : (
      <span className="inline-flex size-7 items-center justify-center rounded-md border opacity-40">
        {icon}
      </span>
    )
  }
  return (
    <span className="ml-auto inline-flex items-center gap-2 text-xs">
      {step(prev, 'prev')}
      <Tip content="[ and ] step back and forward">
        <span className="tabular-nums">{children}</span>
      </Tip>
      {step(next, 'next')}
    </span>
  )
}

function Lanes({
  t,
  filter: wanted,
  onFilter,
  onVerdict,
  judging,
}: {
  t: TicketFull
  filter: LaneFilter
  onFilter: (f: LaneFilter) => void
  onVerdict: (lane: TicketFull['lanes'][number], verdict: Verdict) => void
  judging: boolean
}) {
  const stages = useStages(t.projectId)
  const kindOf = (l: { status: string }) => stageOf(stages, l.status).kind
  const done = t.lanes.filter((l) => kindOf(l) === 'done').length
  const cancelled = t.lanes.filter((l) => kindOf(l) === 'cancelled').length
  const approved = t.lanes.filter((l) => l.approvedAt).length
  const disapproved = t.lanes.filter((l) => l.disapprovedAt).length
  // Filter by stage, tag and verdict: within a row any picked chip matches, across rows all must.
  // Each row counts the lanes the other rows let through, so a number is what clicking it would show.
  const filter = effectiveFilter(t.lanes, wanted)
  const toggled = <T,>(list: T[], key: T) =>
    list.includes(key) ? list.filter((x) => x !== key) : [...list, key]

  const tagCounts = new Map<string, { tag: string; count: number }>()
  for (const l of t.lanes)
    for (const tag of l.tags) {
      const key = tag.toLowerCase()
      const entry = tagCounts.get(key) ?? { tag, count: 0 }
      if (stageOk(l, filter) && verdictOk(l, filter)) entry.count++
      tagCounts.set(key, entry)
    }
  const tags = [...tagCounts.values()].sort((a, b) => compareTags(a.tag, b.tag))
  const stageChips = laneStageOrder(stages)
    .filter((s) => t.lanes.some((l) => l.status === s.key))
    .map((s) => ({
      key: s.key,
      label: (
        <span className={`rounded-full px-1.5 py-px text-[11px] font-medium ${stageBadge(s)}`}>{s.name}</span>
      ),
      count: t.lanes.filter((l) => l.status === s.key && tagOk(l, filter) && verdictOk(l, filter)).length,
    }))
  const verdictChips = LANE_VERDICTS.filter((v) => t.lanes.some((l) => laneVerdict(l) === v)).map((v) => ({
    key: v,
    label: (
      <span className={`rounded-full px-1.5 py-px text-[11px] font-medium ${VERDICT_TAG[v]}`}>
        {VERDICT_LABEL[v]}
      </span>
    ),
    count: t.lanes.filter((l) => laneVerdict(l) === v && stageOk(l, filter) && tagOk(l, filter)).length,
  }))
  const filtering = isFiltering(filter)
  const lanes = sortLanes(
    t.lanes.filter((l) => stageOk(l, filter) && tagOk(l, filter) && verdictOk(l, filter)),
    stages,
  )
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Layers className="size-4 text-muted-foreground" /> Lanes
        </h2>
        {t.lanes.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {done}/{t.lanes.length - cancelled} done · {approved} approved
            {disapproved > 0 && ` · ${disapproved} disapproved`}
            {cancelled > 0 && ` · ${cancelled} cancelled`}
            {t.rollup.total > t.progress.total && ` · all tasks ${t.rollup.done}/${t.rollup.total}`}
          </span>
        )}
        <div className="ml-auto">
          <NewTicket projectId={String(t.projectId)} parent={t} />
        </div>
      </div>
      {t.lanes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No lanes. Split this ticket into lanes when parts of it run in parallel: each lane gets its own
          branch, assignee, tasks and updates.
        </p>
      ) : (
        <>
          <div className="mb-3 space-y-1.5">
            <FilterRow
              label="Stage"
              chips={stageChips}
              active={filter.stages}
              onToggle={(s) => onFilter({ ...filter, stages: toggled(filter.stages, s) })}
              onClear={() => onFilter({ ...filter, stages: [] })}
            />
            {verdictChips.length > 1 && (
              <FilterRow
                label="Verdict"
                chips={verdictChips}
                active={filter.verdicts}
                onToggle={(v) => onFilter({ ...filter, verdicts: toggled(filter.verdicts, v) })}
                onClear={() => onFilter({ ...filter, verdicts: [] })}
              />
            )}
            {tags.length > 0 && (
              <FilterRow
                label="Tags"
                chips={tags.map(({ tag, count }) => ({
                  key: tag.toLowerCase(),
                  label: <Tag tag={tag} className="rounded-full" />,
                  count,
                }))}
                active={filter.tags}
                onToggle={(key) => onFilter({ ...filter, tags: toggled(filter.tags, key) })}
                onClear={() => onFilter({ ...filter, tags: [] })}
              />
            )}
            {filtering && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                showing {lanes.length} of {t.lanes.length}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => onFilter(NO_FILTER)}
                >
                  clear filters
                </button>
              </div>
            )}
          </div>
          <ul className="divide-y rounded-md border sm:max-h-[36rem] sm:overflow-y-auto">
            {lanes.map((l) => (
              <li
                key={l.id}
                className="flex flex-col gap-1 p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:p-0"
              >
                <span className="order-3 shrink-0 pt-1 sm:order-none sm:py-2 sm:pr-1 sm:pl-3">
                  <VerdictButtons
                    t={l}
                    compact
                    disabled={judging}
                    onSet={(verdict) => onVerdict(l, verdict)}
                  />
                </span>
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: String(t.projectId), ticketId: String(l.id) }}
                  search={laneSearch(filter)}
                  className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3 sm:py-2.5 sm:pr-3 sm:pl-2"
                >
                  <Tip content={stageOf(stages, l.status).name}>
                    <span
                      className={`mt-px w-fit shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-medium sm:w-20 ${stageBadge(stageOf(stages, l.status))}`}
                    >
                      {stageOf(stages, l.status).name}
                    </span>
                  </Tip>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm leading-snug">
                      <span className="text-muted-foreground">#{l.id}</span>{' '}
                      <span className={kindOf(l) === 'cancelled' ? 'text-muted-foreground line-through' : ''}>
                        {l.title}
                      </span>
                      {l.tags.length > 0 && (
                        <span className="ml-2 inline-flex flex-wrap gap-1 align-[1px]">
                          {[...l.tags].sort(compareTags).map((tag) => (
                            <Tag key={tag} tag={tag} />
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {l.assignee && <Actor name={l.assignee} truncate short />}
                      {l.branch && (
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                          <GitBranch className="size-3 shrink-0" />{' '}
                          <span className="truncate">{l.branch}</span>
                        </span>
                      )}
                      {l.lanes.total > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3" /> {l.lanes.total} lane{l.lanes.total === 1 ? '' : 's'}
                        </span>
                      )}
                      {l.lastUpdate && (
                        <span className="min-w-0 truncate">
                          {l.lastUpdate.author}: {l.lastUpdate.text}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-row items-center gap-2 text-xs tabular-nums text-muted-foreground sm:flex-col sm:items-end sm:gap-1">
                    {l.rollup.total > 0 && (
                      <span>
                        {l.rollup.done}/{l.rollup.total}
                      </span>
                    )}
                    <span>{ago(l.updatedAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * When a post was last active: the post itself, or the last reply under it, so a reply brings it up in
 * Main. A decision card keeps its own time: its answer is a reply too.
 */
const lastActivity = (u: UpdateRow) =>
  !u.decision && u.thread.lastAt && u.thread.lastAt > u.createdAt ? u.thread.lastAt : u.createdAt

/** Where this browser keeps when it last opened the Agents tab of a ticket. */
const agentsSeenKey = (ticketId: number) => `ticket-agents-seen:${ticketId}`

/**
 * How many Agents posts are new to this browser: posted after it last opened the tab on this ticket,
 * or, before it ever did, after the human's own last post there (all of them when there is none).
 * Opening the tab marks them seen. Storage is read after mount only, and may be unavailable.
 */
function useNewAgentPosts(t: TicketFull, posts: UpdateRow[], open: boolean) {
  const kind = useActorKinds()
  const [seen, setSeen] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(agentsSeenKey(t.id))
    } catch {}
    setSeen(saved)
  }, [t.id])
  const newest = posts.reduce((m, u) => (u.createdAt > m ? u.createdAt : m), '')
  useEffect(() => {
    if (!open || seen === undefined || !newest || (seen && seen >= newest)) return
    try {
      localStorage.setItem(agentsSeenKey(t.id), newest)
    } catch {}
    setSeen(newest)
  }, [open, newest, seen, t.id])
  if (seen === undefined || open) return 0
  const since =
    seen ?? t.updates.find((u) => !u.lane && !u.via && kind(u.author) === 'human')?.createdAt ?? ''
  return posts.filter((u) => u.createdAt > since).length
}

/**
 * The ticket's feed in two tabs. Main, open on arrival, is the human's: the summary on top, then the
 * decisions still waiting on them, then the posts by their last activity, so a reply brings its post
 * up. Agents is the agents' working record, newest first: progress, the review phases, the builder's
 * notes, the resume note's versions. The board puts each post in one as it is posted; the box posts
 * in the tab that is open. A post marked progress is a step of the work; one written here is not,
 * until its mark progress action makes it one. Any post can have replies, which stay under it.
 */
function Activity({
  t,
  onChange,
  laneFeed,
  onLaneFeed,
}: {
  t: TicketFull
  onChange: () => void
  laneFeed: boolean
  onLaneFeed: (v: boolean) => void
}) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [tab, setTab] = useState<FeedTab>('main')
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop((added) => setFiles((prev) => [...prev, ...added]))

  // A link to a post (or to a reply under one) in the other tab opens that tab, once per link.
  const anchor = useContext(ShownAnchor)
  const anchored = anchorId(anchor?.holder ?? anchor?.target, 'post')
  const linkedTab = anchored === null ? undefined : t.updates.find((u) => u.id === anchored)?.tab
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    if (!anchor || !linkedTab || shownFor.current === anchor.hash) return
    shownFor.current = anchor.hash
    setTab(linkedTab)
  }, [anchor, linkedTab])

  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      // Said outright: the API makes a post progress unless told otherwise, as agents post.
      return post(`/api/tickets/${t.id}/updates`, { body, attachmentIds, progress: false, tab })
    },
    onSuccess: () => {
      setBody('')
      setFiles([])
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = () => body.trim() && !send.isPending && send.mutate()

  // The summary's versions are behind the summary card, not in the feed; a lane's newest one shows
  // in it as a post, marked with its lane.
  const laneSummary = new Map<number, number>()
  for (const u of t.updates)
    if (u.lane && u.summary && !laneSummary.has(u.ticketId)) laneSummary.set(u.ticketId, u.id)
  const shown = t.updates.filter((u) => !u.summary || laneSummary.get(u.ticketId) === u.id)
  const main = shown
    .filter((u) => u.tab === 'main')
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || b.id - a.id)
  const agents = shown.filter((u) => u.tab === 'agents')
  // Open decisions on top, newest first among them; the rest keep their order.
  const open = (u: UpdateRow) => u.decision && !u.decidedAt
  const list = tab === 'main' ? main : agents
  const feed = [...list.filter(open), ...list.filter((u) => !open(u))]
  const fresh = useNewAgentPosts(t, agents, tab === 'agents')

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium">Activity</h2>
        <Tabs value={tab} onValueChange={(v) => setTab(v as FeedTab)}>
          <TabsList aria-label="Feed">
            <Tip content="For you: your posts with the replies under them, decisions and questions">
              <TabsTrigger value="main" className="after:hidden">
                Main
              </TabsTrigger>
            </Tip>
            <Tip content="The agents' working record: progress, review phases, builder notes, resume notes">
              <TabsTrigger value="agents" className="after:hidden">
                Agents
                {fresh > 0 && (
                  <span
                    aria-label={`${fresh} new`}
                    className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums"
                  >
                    {fresh}
                  </span>
                )}
              </TabsTrigger>
            </Tip>
          </TabsList>
        </Tabs>
        {t.lanes.length > 0 && (
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Switch size="sm" checked={laneFeed} onCheckedChange={onLaneFeed} /> include lane posts
          </label>
        )}
      </div>
      <form
        {...drop.props}
        className={cn('mb-4 space-y-2 rounded-lg border p-3', drop.className)}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <RichEditor
          value={body}
          onChange={setBody}
          onFiles={(added) => setFiles((prev) => [...prev, ...added])}
          onAttach={() => fileInput.current?.click()}
          onSubmit={submit}
          label="New post"
          placeholder={
            tab === 'main'
              ? 'Write a post: a question, an answer, progress. Paste or drop screenshots and recordings.'
              : "Write in the agents' record: a note for whoever works it. Paste or drop files."
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setFiles([...files, ...Array.from(e.target.files ?? [])])
              // Clear it, so picking a file that was just removed registers again.
              e.target.value = ''
            }}
          />
          <PendingFiles files={files} onChange={setFiles} />
          <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Posting…' : tab === 'main' ? 'Post' : 'Post in Agents'}
          </Button>
        </div>
      </form>
      {feed.length === 0 ? (
        <Empty>
          {t.updates.length === 0
            ? 'No posts yet.'
            : tab === 'main'
              ? 'No posts here yet.'
              : 'No agent posts yet.'}
        </Empty>
      ) : (
        <Timeline>
          {feed.map((u) => (
            <TimelineRow key={u.id} at={u.createdAt} dot={u.progress ? undefined : 'bg-sky-500/70'}>
              <PostCard u={u} projectId={String(t.projectId)} onChange={onChange} />
            </TimelineRow>
          ))}
        </Timeline>
      )}
    </section>
  )
}

const SECTION_ITEMS = [
  { key: 'summary', label: 'Summary' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'activity', label: 'Activity' },
  { key: 'lanes', label: 'Lanes' },
] as const

/** The ticket's sections, one tap away on a phone instead of a long scroll. */
function TicketSectionNav({ hasSummary }: { hasSummary: boolean }) {
  const [active, setActive] = useState('summary')
  const go = (id: string) => {
    setActive(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div className="-mx-1 overflow-x-auto px-1 py-2">
      <Tabs value={active} onValueChange={(v) => go(String(v))}>
        <TabsList aria-label="Ticket sections" className="w-max">
          {SECTION_ITEMS.filter((s) => s.key !== 'summary' || hasSummary).map((s) => (
            <TabsTrigger key={s.key} value={s.key} className="after:hidden">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}

/**
 * The ticket's summary, on top of Main: what the change does and where it stands, written by the agents
 * and rewritten as the work moves on: "updated <when>: <what changed>" (the exact time on hover), its
 * earlier versions behind history, each as it was written. Until one is written, the newest agent
 * progress post stands in for it.
 */
function SummaryCard({ t }: { t: TicketFull }) {
  const s = t.summary!
  const [history, setHistory] = useState(false)
  // Every version's replies, from the feed (the versions are its posts).
  const replies = (postId: number) => t.updates.find((u) => u.id === postId)?.thread.count ?? 0
  // A link to an earlier version, or to a reply under one, opens the history, once per link.
  const anchor = useContext(ShownAnchor)
  const anchored = anchorId(anchor?.holder ?? anchor?.target, 'post')
  const older =
    anchored !== null && anchored !== s.postId && t.updates.some((u) => u.id === anchored && u.summary)
  useEffect(() => {
    if (older) setHistory(true)
  }, [older, anchor?.hash])
  const { data } = useQuery({
    queryKey: ['ticket', String(t.id), 'summary', s.postId],
    queryFn: () => get<SummaryHistory>(`/api/tickets/${t.id}/summary`),
    enabled: history,
  })
  const earlier = data?.versions.filter((v) => v.postId !== s.postId) ?? []
  const when = s.fallback ? 'posted' : s.versions > 1 ? 'updated' : 'written'
  return (
    // A link to the summary's post (#post-<id>) lands here, below the stuck header. Not the stand-in's:
    // that post is in the feed too (in Agents, with its replies), and a link to it opens that tab, which
    // would take this card away from under the mark, so the id stays with the post.
    <article
      id={s.fallback ? undefined : `post-${s.postId}`}
      aria-label="Summary"
      className="mb-4 scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ScrollText className="size-4" /> Summary
        </h3>
        <Actor name={s.by} via={s.via} className="text-foreground" />
        <Tip content={stamp(s.at)}>
          <span className="min-w-0 break-words">
            {when} {ago(s.at)}
            {s.change && `: ${s.change}`}
          </span>
        </Tip>
        {s.versions > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            aria-expanded={history}
            onClick={() => setHistory((v) => !v)}
          >
            <History data-icon="inline-start" /> {history ? 'hide history' : `history (${s.versions - 1})`}
          </Button>
        )}
      </div>
      {s.fallback && (
        <p className="mt-1 text-xs text-muted-foreground">
          No summary yet: the latest progress post stands in for it until an agent writes one.
        </p>
      )}
      <Markdown className="mt-2">{s.body}</Markdown>
      <Attachments items={s.attachments} />
      {/* The stand-in's replies are under the post itself, in Agents. */}
      {/* Keyed by version: a rewrite swaps in a new post, and a draft or a reply-to begun under the
          old one must not go to the new one. */}
      {!s.fallback && <SummaryReplies key={s.postId} postId={s.postId} count={replies(s.postId)} />}
      {history && (
        <ol aria-label="Earlier versions" className="mt-3 space-y-3 border-t pt-3">
          {!data && <li className="text-xs text-muted-foreground">Loading…</li>}
          {earlier.map((v) => (
            <li
              key={v.postId}
              id={`post-${v.postId}`}
              className="min-w-0 scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-md border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Actor name={v.by} via={v.via} className="text-foreground" />
                <Tip content={stamp(v.at)}>
                  <span className="min-w-0 break-words">
                    {ago(v.at)}: {v.change || 'the first version'}
                  </span>
                </Tip>
              </div>
              <Markdown className="mt-2">{v.body}</Markdown>
              <Attachments items={v.attachments} />
              <SummaryReplies postId={v.postId} count={replies(v.postId)} />
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

/**
 * The replies under a version of the summary, as under any post: the toggle with their count, then
 * the thread and its Reply box. Each reply stays with the version it was written under. A link to one
 * of them (#post-<id>-reply-<id>) opens the thread, once per link.
 */
function SummaryReplies({ postId, count }: { postId: number; count: number }) {
  const [open, setOpen] = useState(false)
  const anchor = useContext(ShownAnchor)
  const opensFor = anchor?.holder === `post-${postId}` ? anchor.hash : null
  useEffect(() => {
    if (opensFor) setOpen(true)
  }, [opensFor])
  const label = `${count} ${count === 1 ? 'reply' : 'replies'}`
  return (
    <>
      <div role="group" aria-label="Summary actions" className="mt-2 flex items-center gap-0.5">
        <ActionButton
          label={open ? 'hide replies' : count ? label : 'reply'}
          tip={open ? 'Hide replies' : count ? `Show ${label}` : 'Reply to the summary'}
          size={count && !open ? 'xs' : 'icon-xs'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <MessageSquare />
          {!open && count > 0 && count}
        </ActionButton>
      </div>
      {open && (
        <div className="mt-3 min-w-0 border-t pt-3">
          <Thread parentType="update" parentId={postId} compact />
        </div>
      )}
    </>
  )
}

/**
 * The minutes a Timeline has been open. Its rows are its caller's elements, which its own re-render
 * leaves alone: each row reads this so it re-renders, and its "5 minutes ago" counts, as it changes.
 */
const TimelineMinute = createContext(0)

/** A rail down the left of its rows; moves them on every minute so "5 minutes ago" keeps counting. */
function Timeline({ children }: { children: ReactNode }) {
  const [minute, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  return (
    <TimelineMinute value={minute}>
      <ol>{children}</ol>
    </TimelineMinute>
  )
}

/**
 * One row of a Timeline: how long ago on the left (the exact time on hover), a dot on the rail. The
 * two lines run top to bottom down the rail from beside the dot, so the post keeps the width; a long
 * one makes its row taller rather than spill into the next. Their column is as wide as the two lines,
 * 2.25rem at least: wider when a browser's minimum font size makes them bigger than the rem sizes. Its
 * padding is pt/pb: py pads the block axis, which runs sideways in vertical text.
 */
function TimelineRow({
  at,
  dot = 'bg-muted-foreground/60',
  children,
}: {
  at: string
  dot?: string
  children: ReactNode
}) {
  useContext(TimelineMinute)
  const today = new Date(at).toDateString() === new Date().toDateString()
  return (
    <li className="group grid grid-cols-[minmax(2.25rem,max-content)_1.25rem_minmax(0,1fr)] sm:grid-cols-[minmax(2.25rem,max-content)_1.5rem_minmax(0,1fr)]">
      <Tip content={stamp(at)}>
        <time
          dateTime={at}
          suppressHydrationWarning
          className="pt-3 pb-3 text-xs whitespace-nowrap text-muted-foreground [writing-mode:vertical-rl]"
        >
          {agoLong(at)}
          <span className="block text-[11px] opacity-70" suppressHydrationWarning>
            {today
              ? clock(at)
              : new Date(at).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
          </span>
        </time>
      </Tip>
      <div className="relative">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-first:top-4 group-last:bottom-auto group-last:h-4" />
        <span
          className={cn(
            'absolute top-3.5 left-1/2 size-2.5 -translate-x-1/2 rounded-full border-2 border-background ring-1 ring-border',
            dot,
          )}
        />
      </div>
      <div className="min-w-0 pb-3">{children}</div>
    </li>
  )
}

/**
 * One post: who, progress or not, the text and files, then its actions as icons, and its replies behind
 * the first of them, opening right under the row.
 */
function PostCard({ u, projectId, onChange }: { u: UpdateRow; projectId: string; onChange: () => void }) {
  const [thread, setThread] = useState(false)
  const [editing, setEditing] = useState(false)
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const edit = useMutation({
    mutationFn: (p: { body?: string; progress?: boolean }) => patch(`/api/updates/${u.id}`, p),
    onSuccess: () => {
      setEditing(false)
      onChange()
    },
    onError,
  })
  const remove = useMutation({ mutationFn: () => del(`/api/updates/${u.id}`), onSuccess: onChange, onError })
  // A link to one of its replies (#post-<id>-reply-<id>) opens the thread, once per link.
  const anchor = useContext(ShownAnchor)
  const opensFor = anchor?.holder === `post-${u.id}` ? anchor.hash : null
  useEffect(() => {
    if (opensFor) setThread(true)
  }, [opensFor])
  const replies = u.thread.count
  const count = `${replies} ${replies === 1 ? 'reply' : 'replies'}`
  return (
    // A link lands on it as #post-<id>, below the stuck header.
    <article
      id={`post-${u.id}`}
      className={cn(
        'scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-lg border',
        !u.progress && 'bg-muted/30',
        u.decision && !u.decidedAt && 'border-amber-500/60 bg-amber-500/5',
      )}
    >
      {/* The post without its thread: hovering it shows its actions, hovering one of its replies does not. */}
      <div className="group/post p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Actor name={u.author} via={u.via} truncate className="text-foreground" />
          {u.summary ? (
            <Tip content="The lane's summary: where its work stands, as its agents keep it">
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
                <ScrollText className="size-3" /> summary
              </span>
            </Tip>
          ) : u.handoff ? (
            <Tip content="A resume note as it was saved: where the work was left off then">
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
                <Bookmark className="size-3" /> resume note
              </span>
            </Tip>
          ) : (
            u.progress && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">progress</span>
            )
          )}
          {u.lane && (
            <Link
              to="/projects/$id/features/$ticketId"
              params={{ id: projectId, ticketId: String(u.lane.id) }}
              className="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 hover:text-foreground"
            >
              <Layers className="size-3 shrink-0" /> <span className="max-w-48 truncate">{u.lane.title}</span>
            </Link>
          )}
          <Edited at={u.editedAt} />
        </div>
        {editing ? (
          <EditBox
            value={u.body}
            pending={edit.isPending}
            onSave={(body) => edit.mutate({ body })}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Markdown className="mt-2">{u.body}</Markdown>
        )}
        {u.decision && <DecisionCard u={u} onChange={onChange} />}
        <Attachments items={u.attachments} />
        <div role="group" aria-label="Post actions" className="mt-2 flex items-center gap-0.5">
          <ActionButton
            label={thread ? 'hide replies' : replies ? count : 'reply'}
            tip={thread ? 'Hide replies' : replies ? `Show ${count}` : 'Reply'}
            size={replies && !thread ? 'xs' : 'icon-xs'}
            aria-expanded={thread}
            onClick={() => setThread((v) => !v)}
          >
            <MessageSquare />
            {!thread && replies > 0 && replies}
          </ActionButton>
          {!u.lane && (
            <PostActions
              what="this post"
              group="post"
              onEdit={() => setEditing(true)}
              onDelete={() => remove.mutate()}
            >
              <ActionButton
                label={u.progress ? 'not progress' : 'mark progress'}
                tip={u.progress ? 'Not progress: make it a plain post' : 'Mark as progress'}
                onClick={() => edit.mutate({ progress: !u.progress })}
              >
                {u.progress ? <FlagOff /> : <Flag />}
              </ActionButton>
            </PostActions>
          )}
        </div>
      </div>
      {thread && (
        <div className="mx-3 mb-3 border-t pt-3">
          <Thread parentType="update" parentId={u.id} compact />
        </div>
      )}
    </article>
  )
}

/**
 * A decision an agent asked the human to make: its options as choices, one maybe recommended. Picking
 * one (and an optional note) answers it; once decided the choice stays marked and can be changed. An
 * answer the orchestrator relayed from the chat shows the words the human said there, as they were.
 */
/** What answering a card returns that the card reads: an archive request's result, null on any other card. */
type DecideResult = {
  archive: { archived: number[]; already: number[]; skipped: { id: number; why: string }[] } | null
}

function DecisionCard({ u, onChange }: { u: UpdateRow; onChange: () => void }) {
  const options = u.decision!
  const decided = u.decidedOption !== null && u.decidedAt !== null
  // Relayed: the words are the human's, and no one on the board picked the option (decidedBy is '').
  const relayed = decided && u.relayedBy !== ''
  const [changing, setChanging] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const choosing = !decided || changing
  const decide = useMutation({
    mutationFn: () => put<DecideResult>(`/api/updates/${u.id}/decision`, { option: picked, note }),
    onSuccess: (res) => {
      setChanging(false)
      setPicked(null)
      setNote('')
      onChange()
      // An agent's archive request answered Archive: what came off the board, and what could not. Those
      // archived already are as asked: the reply under the card lists them, no toast.
      const ids = (list: number[]) => list.map((id) => `#${id}`).join(', ')
      if (res.archive?.archived.length)
        toast.success(`Archived ${ids(res.archive.archived)}: off the board, under Archived`)
      if (res.archive?.skipped.length)
        toast.error(`Not archived: ${res.archive.skipped.map((s) => s.why).join('; ')}`)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <div className="mt-3 space-y-2" role="group" aria-label="Decision">
      <div className="flex items-center gap-2 text-xs">
        <Scale className="size-3.5 text-amber-600 dark:text-amber-400" />
        {decided && !changing ? (
          <span className="text-muted-foreground">
            {relayed ? (
              <>
                Decided in chat by you ·{' '}
                <Tip content="The orchestrator recorded your answer from the chat. Nothing was clicked on the card.">
                  <span className="cursor-help underline decoration-dotted underline-offset-2">relayed</span>
                </Tip>{' '}
                by <Actor name={u.relayedBy} /> {ago(u.decidedAt!)} ·{' '}
              </>
            ) : (
              <>
                decided by <Actor name={u.decidedBy} /> {ago(u.decidedAt!)} ·{' '}
              </>
            )}
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() => setChanging(true)}
            >
              change
            </button>
          </span>
        ) : (
          <span className="font-medium text-amber-700 dark:text-amber-400">Your decision is needed</span>
        )}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {options.map((o, i) => {
          const chosen = decided && u.decidedOption === i
          const selected = choosing ? picked === i : chosen
          return (
            <li key={i}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!choosing}
                onClick={() => setPicked(i)}
                className={cn(
                  'flex h-full w-full flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors',
                  choosing && 'hover:border-foreground/40',
                  selected && 'border-primary ring-2 ring-primary/30',
                  !choosing && !chosen && 'opacity-50',
                )}
              >
                <span className="flex w-full items-center gap-2 font-medium">
                  {chosen && !choosing && <Check className="size-4 text-primary" />}
                  {o.label}
                  {o.recommended && (
                    <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                      recommended
                    </span>
                  )}
                </span>
                {o.detail && <span className="text-xs text-muted-foreground">{o.detail}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {relayed && !changing && (
        <p className="text-sm">
          <span className="text-xs text-muted-foreground">What you said in chat:</span>{' '}
          <span className="whitespace-pre-wrap break-words">“{u.relayedText}”</span>
        </p>
      )}
      {choosing && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A note for the agent (optional)"
            aria-label="Note for the agent"
            className="h-8 min-w-48 flex-1 text-sm"
          />
          {changing && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={picked === null || decide.isPending}
            onClick={() => decide.mutate()}
          >
            {decide.isPending ? 'Saving…' : 'Decide'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Where a branch's head is: its last commit, how far from the base, how far it has gone. */
function Info({ info }: { info: TicketGit['info'] }) {
  return info.exists ? (
    <div className="text-xs text-muted-foreground">
      <span className="font-mono">{shortSha(info.sha!)}</span> {info.subject}
      <div>
        {info.ahead != null && (
          <>
            +{info.ahead} / −{info.behind} vs base ·{' '}
          </>
        )}
        {ago(info.authoredAt)}
      </div>
      {info.reach && <ReachBadge reach={info.reach} className="mt-1" />}
    </div>
  ) : (
    <div className="text-xs text-muted-foreground">branch not in the checkout yet</div>
  )
}

/** A PR of the ticket's: its link, where it is in the queue, its latest review. */
function PrLine({ pr }: { pr: NonNullable<TicketFull['pr']> }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {pr.url ? (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          PR #{pr.number} <ExternalLink className="size-3 text-muted-foreground" />
        </a>
      ) : (
        <span className="font-medium">PR #{pr.number}</span>
      )}
      {pr.queue && <span className="text-muted-foreground">{STATUS_LABEL[pr.queue.status]}</span>}
      {pr.latestReview && (
        <ReviewResultButton
          resultId={pr.latestReview.id}
          className={`rounded bg-muted px-1 hover:underline ${pr.latestReview.fresh === false ? 'opacity-60' : ''}`}
          tip={pr.latestReview.fresh === false ? 'review is for an older SHA' : 'latest review'}
        >
          {pr.latestReview.verdict}
        </ReviewResultButton>
      )}
    </div>
  )
}

/** The ticket's branch: its git state and its PR; one panel per repo when it spans several. */
function BranchPanel({ t, git }: { t: TicketFull; git?: TicketGit }) {
  if ((git?.repos.length ?? 0) > 1)
    return (
      <>
        {git!.repos.map((r) => (
          <section key={r.repo.id} className="rounded-lg border p-3" aria-label={`Branch in ${r.repo.name}`}>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              Branch
              <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">
                {r.repo.name}
              </span>
            </h2>
            {r.branch ? (
              <>
                <div className="inline-flex items-center gap-1 font-mono text-sm">
                  <GitBranch className="size-3.5" /> {r.branch}
                </div>
                <div className="text-xs text-muted-foreground">base {r.baseBranch}</div>
                <div className="flex min-w-0 items-center gap-1">
                  <PushBadge push={r.info.push} />
                  {r.primary && <RefreshPush projectId={t.projectId} className="-my-1" />}
                </div>
                <Info info={r.info} />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No branch yet: pick one above, or the agent sets it.
              </p>
            )}
            {r.pr && <PrLine pr={r.pr} />}
            {r.pr?.queue?.open && <PrState pr={r.pr.queue} className="mt-1.5" />}
          </section>
        ))}
      </>
    )
  return (
    <section className="rounded-lg border p-3">
      <h2 className="mb-2 flex items-center text-sm font-medium">
        Branch
        {git?.repo && (
          <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">{git.repo.name}</span>
        )}
      </h2>
      {t.branch ? (
        <>
          <div className="inline-flex items-center gap-1 font-mono text-sm">
            <GitBranch className="size-3.5" /> {t.branch}
          </div>
          <div className="text-xs text-muted-foreground">base {t.baseBranch}</div>
          {git?.repo && (
            <div className="flex min-w-0 items-center gap-1">
              <PushBadge push={git.info.push} />
              <RefreshPush projectId={t.projectId} className="-my-1" />
            </div>
          )}
          {git && <Info info={git.info} />}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No branch yet: pick one above, or the agent sets it.</p>
      )}
      {t.pr && <PrLine pr={t.pr} />}
      {t.pr?.queue?.open && <PrState pr={t.pr.queue} className="mt-1.5" />}
    </section>
  )
}

/** The worktrees, sub-branches and sandboxes opened for the ticket and its lanes. */
function WorkspacesPanel({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/workspaces/${id}`),
    onSuccess: onChange,
    onError: (err: unknown) => toast.error(errorMessage(err)),
  })
  return (
    <section className="rounded-lg border p-3">
      <h2 className="mb-2 text-sm font-medium">Workspaces</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Worktrees, sub-branches and subagent sandboxes the agents opened for this ticket
        {t.lanes.length > 0 && ' and its lanes'}.
      </p>
      <ul className="space-y-2">
        {(git?.workspaces ?? t.workspaces.map((w) => ({ ...w, info: null, worktree: null, lane: null }))).map(
          (w) => (
            <li key={w.id} className="group text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{w.name}</span>
                {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
                {(git?.repos.length ?? 0) > 1 && 'repo' in w && w.repo && (
                  <span className="font-mono text-[11px] text-muted-foreground">{w.repo.name}</span>
                )}
                <Tip content="remove">
                  <button
                    type="button"
                    className="ml-auto opacity-0 group-hover:opacity-100"
                    onClick={() => remove.mutate(w.id)}
                    aria-label="remove"
                  >
                    <X className="size-3.5 text-muted-foreground" />
                  </button>
                </Tip>
              </div>
              {w.lane && (
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: String(t.projectId), ticketId: String(w.lane.id) }}
                  className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Layers className="size-3 shrink-0" /> <span className="truncate">{w.lane.title}</span>
                </Link>
              )}
              {w.branch && (
                <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  {w.info && <PushDot push={w.info.push} />}
                  <span className="truncate">{w.branch}</span>
                </div>
              )}
              {w.info && <Info info={w.info} />}
              {w.worktree && (
                <Tip content={w.worktree.path}>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {w.worktree.path}
                  </div>
                </Tip>
              )}
            </li>
          ),
        )}
      </ul>
      {t.workspaces.length === 0 && !git?.workspaces.length && (
        <p className="text-xs text-muted-foreground">None yet.</p>
      )}
    </section>
  )
}
