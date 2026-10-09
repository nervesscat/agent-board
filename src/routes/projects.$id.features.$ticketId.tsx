import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
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
  Layers,
  ListTodo,
  Loader2,
  Lock,
  MessageSquare,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Scale,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { RichEditor } from '#/components/RichEditor'
import { AssigneeSelect } from '#/components/AssigneeSelect'
import { BranchSelect } from '#/components/BranchSelect'
import { StatusSelect } from '#/components/StatusSelect'
import { Attachments } from '#/components/Attachments'
import { Empty } from '#/components/Empty'
import { HandoffCard, toastHandoff } from '#/components/Handoff'
import { Markdown } from '#/components/Markdown'
import { NeedsField, NeedsStatus, toastRefusal } from '#/components/Needs'
import { NewTicket } from '#/components/NewTicket'
import { cn } from '#/lib/utils'
import { PendingFiles, useFileDrop } from '#/components/PendingFiles'
import { PrState } from '#/components/PrState'
import { RESUME_TEMPLATE } from '#/lib/constants'
import { PushBadge, PushDot, RefreshPush } from '#/components/PushDot'
import { Tag, compareTags } from '#/components/Tag'
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
import { Button, buttonVariants } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Switch } from '#/components/ui/switch'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import {
  del,
  errorMessage,
  get,
  patch,
  post,
  put,
  upload,
  type ManagedPreview,
  type TicketFull,
  type TicketGit,
  type TicketRow,
  type UpdateRow,
  type Workspace,
  type WorkspacePreview,
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
import { useProject, useStages } from '#/lib/project'
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
  const setFilter = (f: LaneFilter) =>
    navigate({
      to: '/projects/$id/features/$ticketId',
      params: { id, ticketId },
      search: laneSearch(f),
      replace: true,
      // A filter change is the same page: stay where the reader is.
      resetScroll: false,
    })
  const key = ['ticket', ticketId]
  // Fold the lanes' updates into this ticket's feed.
  const [laneFeed, setLaneFeed] = useState(false)
  const { data: t, error } = useQuery({
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
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const update = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch(`/api/tickets/${ticketId}`, p),
    onSuccess: (res) => {
      invalidate()
      toastHandoff(res)
    },
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
  const { data: board } = useQuery({
    ...ticketsQuery(id, 'root'),
    enabled: Boolean(t) && !t?.parentId,
    refetchInterval: 10_000,
  })

  if (error) return <p className="text-sm text-destructive">{errorMessage(error)}</p>
  if (!t) return null
  // Stepping to another ticket, the previous one stays on screen until the new one loads: its git state
  // may come first, and must not show under the previous ticket's branch.
  const git = t.id === Number(ticketId) ? ticketGit : undefined

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
        {!t.parentId && board && <StageNav key={t.id} projectId={id} tickets={board} t={t} />}
      </nav>

      {/* The header stays in view once scrolled up to the top bar (h-12 and its border), with the
            page scrolling under it: opaque, above the feed's positioned bits, below the top bar.
            Its padding keeps the title off the top bar's edge; the margins take it back at rest. */}
      <header
        ref={measureHeader}
        className="sticky top-[calc(3rem+1px)] z-10 -my-2 flex flex-wrap items-start gap-3 bg-background py-2"
      >
        <div className="min-w-0 flex-1">
          <InlineTitle key={t.id} t={t} onSave={(title) => update.mutate({ title })} />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              opened by <Actor name={t.createdBy} /> {ago(t.createdAt)}
            </span>
            <span>updated {ago(t.updatedAt)}</span>
            <InlineTags key={t.id} t={t} onSave={(tags) => update.mutate({ tags })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {t.archivedAt && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              title={`Archived by ${t.archivedBy || 'someone'} ${ago(t.archivedAt)}${t.parentId ? ', with the ticket it is a lane of' : ''}`}
            >
              <Archive className="size-3.5" /> Archived
            </span>
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
            <span
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
              title="This ticket is marked further along than its lanes"
            >
              <TriangleAlert className="size-3.5" /> {openLanes} lane{openLanes === 1 ? '' : 's'} not done
            </span>
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
          {!t.archivedAt && !t.parentId && isClosed(kind) && (
            <Button
              variant="outline"
              size="sm"
              disabled={archive.isPending}
              onClick={() => archive.mutate('archive')}
              title="Take it off the board, with its lanes; Archived on the features page brings it back"
            >
              <Archive /> Archive
            </Button>
          )}
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
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* minmax(0,…) and min-w-0: a long line (a lane's last update, a code block) must not
              widen the page */}
        <div className="min-w-0 space-y-6">
          <ResumeNote key={t.id} t={t} onChange={invalidate} />
          <Instructions key={t.id} t={t} onSave={(body) => update.mutate({ body })} onChange={invalidate} />
          <Tasks t={t} onChange={invalidate} />
          <Lanes t={t} filter={filter} onFilter={setFilter} onVerdict={decide} judging={judge.isPending} />
          <Activity t={t} onChange={invalidate} laneFeed={laneFeed} onLaneFeed={setLaneFeed} />
        </div>
        <aside className="min-w-0 space-y-4">
          {t.handoff && <HandoffCard handoff={t.handoff} />}
          <Previews t={t} git={git} onChange={invalidate} />
          <Details key={t.id} t={t} includes={git?.includes} onSave={(p) => update.mutate(p)} />
          <GitPanel t={t} git={git} onChange={invalidate} />
        </aside>
      </div>
    </div>
  )
}

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
      <button
        type="button"
        title="Click to rename"
        onClick={() => {
          setValue(t.title)
          setEditing(true)
        }}
        className="cursor-text text-left decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:underline"
      >
        {t.title}
      </button>
    </h1>
  )
}

/** The tags, edited where they are: comma separated, Enter or leaving the field saves, Esc cancels. */
function InlineTags({ t, onSave }: { t: TicketFull; onSave: (tags: string[]) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const done = (save: boolean) => {
    setEditing(false)
    const tags = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (save && tags.join('\n') !== t.tags.join('\n')) onSave(tags)
  }
  if (editing)
    return (
      <Input
        aria-label="Tags, comma separated"
        autoFocus
        value={value}
        placeholder="High, Forms"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done(true)
          if (e.key === 'Escape') done(false)
        }}
        className="h-6 w-56 text-xs"
      />
    )
  const open = () => {
    setValue(t.tags.join(', '))
    setEditing(true)
  }
  return t.tags.length > 0 ? (
    <button
      type="button"
      title="Click to edit the tags"
      onClick={open}
      className="inline-flex flex-wrap gap-1"
    >
      {[...t.tags].sort(compareTags).map((tag) => (
        <Tag key={tag} tag={tag} />
      ))}
    </button>
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
        // Clicking the text edits it; a link inside still opens.
        <div
          role="button"
          tabIndex={0}
          title="Click to edit"
          className="cursor-text rounded-md hover:bg-muted/30"
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('a, img')) open()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') open()
          }}
        >
          <Markdown>{t.body}</Markdown>
        </div>
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
                <button
                  type="button"
                  title={`Remove ${a.name}`}
                  aria-label={`Remove ${a.name}`}
                  className="hover:text-destructive"
                  onClick={() => detach.mutate(a.id)}
                >
                  <X className="size-3" />
                </button>
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
function ResumeNote({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const stages = useStages(t.projectId)
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
  // Linked to as #resume (from the summary's Carrying over): brought into view once it is there.
  const reveal = useCallback((el: HTMLElement | null) => {
    if (el && window.location.hash === '#resume') el.scrollIntoView({ block: 'start' })
  }, [])
  if (t.archivedAt || isClosed(stageOf(stages, t.status).kind)) return null
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
    ? own.filter((u) => !u.progress && !u.decision && (u.thread.lastAuthor ?? u.author) !== t.assignee).length
    : 0
  const commits = r.commitsSince ?? 0
  const chip = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5'
  const warn = `${chip} bg-amber-500/10 text-amber-700 dark:text-amber-400`
  return (
    <section
      id="resume"
      ref={reveal}
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
          <span className="text-xs text-muted-foreground" title={stamp(r.at)}>
            by <Actor name={r.by} /> {ago(r.at)}
            {r.sha && <span className="font-mono"> at {shortSha(r.sha)}</span>}
          </span>
        )}
        {!editing && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={open}>
            <Pencil data-icon="inline-start" /> {r.note ? 'edit' : 'write'}
          </Button>
        )}
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
        {commits > 0 && (
          <span className={warn} title="Commits on the ticket's branch after the note was written">
            <GitCommitHorizontal className="size-3.5" /> {plural(commits, 'commit')} since this note
          </span>
        )}
        {r.stale && commits === 0 && (
          <span className={warn} title="A progress post came after the note">
            <TriangleAlert className="size-3.5" /> progress posted since this note
          </span>
        )}
        {r.noHandoff && r.note && (
          <span className={warn} title="It was worked on a later day than this note was written">
            <TriangleAlert className="size-3.5" /> no handoff since the last session
          </span>
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
          <span
            className={cn(chip, 'bg-muted')}
            title={`Posts where someone spoke after ${t.assignee}, the assignee`}
          >
            <MessageSquare className="size-3.5" /> {plural(waiting, 'unanswered thread')}
          </span>
        )}
        {r.day !== null && (
          <span
            className={cn(chip, 'bg-muted')}
            title={t.startedAt ? `Work on it started ${stamp(t.startedAt)}` : undefined}
          >
            <CalendarDays className="size-3.5" /> day {r.day} in progress
          </span>
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
          <p className="font-medium">No handoff yet</p>
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
            <span
              className="ml-auto inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-normal"
              title="Reserved for this project agent: other agents cannot take it, only you can reassign it"
            >
              <Lock className="size-3" /> reserved
            </span>
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
            onValueChange={(v) => v && v !== repoId && onSave({ repoId: Number(v) })}
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
      <div className="space-y-1">
        <Label
          htmlFor="needs"
          className="text-xs text-muted-foreground"
          title="Tickets whose branches must be merged into this one's base before it can be done"
        >
          Needs
          {t.neededBy.length > 0 && (
            <span className="ml-auto font-normal">
              needed by{' '}
              {t.neededBy.map((n, i) => (
                <span key={n.id}>
                  {i > 0 && ', '}
                  <Link
                    to="/projects/$id/features/$ticketId"
                    params={{ id: String(t.projectId), ticketId: String(n.id) }}
                    className="hover:text-foreground hover:underline"
                    title={n.title}
                  >
                    #{n.id}
                  </Link>
                </span>
              ))}
            </span>
          )}
        </Label>
        <NeedsField t={t} includes={includes} onSave={(needs) => onSave({ needs })} />
      </div>
    </section>
  )
}

function Tasks({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const [text, setText] = useState('')
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: () => post(`/api/tickets/${t.id}/tasks`, { tasks: [text] }),
    onSuccess: () => {
      setText('')
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
  const pct = t.progress.total ? Math.round((100 * t.progress.done) / t.progress.total) : 0
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Tasks</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t.progress.done}/{t.progress.total} · {pct}%
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="space-y-1.5">
        {t.tasks.map((task) => (
          <li key={task.id} className="group flex items-center gap-2 text-sm">
            <Checkbox
              checked={task.done}
              onCheckedChange={(v) => toggle.mutate({ id: task.id, done: Boolean(v) })}
            />
            <span className={task.done ? 'text-muted-foreground line-through' : ''}>{task.text}</span>
            <button
              type="button"
              className="ml-auto opacity-0 group-hover:opacity-100"
              onClick={() => remove.mutate(task.id)}
              title="remove"
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) add.mutate()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task"
          className="h-8"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
          <Plus data-icon="inline-start" /> Add
        </Button>
      </form>
    </section>
  )
}

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
 * leaves the steps.
 */
function StageNav({ projectId, tickets, t }: { projectId: string; tickets: TicketRow[]; t: TicketFull }) {
  const stages = useStages(projectId)
  const stepped = useLocation({ select: (l) => l.state.stepList })
  // The list as this page last had it (the page is keyed by ticket), so moving this ticket keeps it.
  const [kept, setKept] = useState<StepList>()
  // This ticket as its own page has it, so a stage change shows here before the board's list catches up.
  const rows = [...tickets.filter((x) => x.id !== t.id && x.parentId === null), t]
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
      <Link
        to="/projects/$id/features/$ticketId"
        params={{ id: projectId, ticketId: String(to.id) }}
        search={search}
        state={state}
        title={`#${to.id} ${to.title}`}
        className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-muted hover:text-foreground"
        aria-label={`${dir === 'prev' ? 'Previous' : 'Next'} ${noun}`}
        aria-keyshortcuts={dir === 'prev' ? '[' : ']'}
      >
        {icon}
      </Link>
    ) : (
      <span className="inline-flex size-7 items-center justify-center rounded-md border opacity-40">
        {icon}
      </span>
    )
  }
  return (
    <span className="ml-auto inline-flex items-center gap-2 text-xs">
      {step(prev, 'prev')}
      <span className="tabular-nums" title="[ and ] step back and forward">
        {children}
      </span>
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
          <ul className="max-h-[36rem] divide-y overflow-y-auto rounded-md border">
            {lanes.map((l) => (
              <li key={l.id} className="flex items-start transition-colors hover:bg-muted/50">
                <span className="shrink-0 py-2 pr-1 pl-3">
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
                  className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-3 pl-2"
                >
                  <span
                    className={`mt-px w-20 shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${stageBadge(stageOf(stages, l.status))}`}
                    title={stageOf(stages, l.status).name}
                  >
                    {stageOf(stages, l.status).name}
                  </span>
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
                      {l.assignee && <Actor name={l.assignee} />}
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
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums text-muted-foreground">
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
 * The ticket's feed: one kind of post, newest first, with one box to write one. A post marked
 * progress is a step of the work (what agents post as they go); one written here is not, until its
 * mark progress action makes it one. Any post can have replies.
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
  const fileInput = useRef<HTMLInputElement>(null)
  const drop = useFileDrop((added) => setFiles((prev) => [...prev, ...added]))

  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      // Said outright: the API makes a post progress unless told otherwise, as agents post.
      return post(`/api/tickets/${t.id}/updates`, { body, attachmentIds, progress: false })
    },
    onSuccess: () => {
      setBody('')
      setFiles([])
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = () => body.trim() && !send.isPending && send.mutate()

  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-medium">Activity</h2>
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
          placeholder="Write a post: a question, an answer, progress. Paste or drop screenshots and recordings."
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
            {send.isPending ? 'Posting…' : 'Post'}
          </Button>
        </div>
      </form>
      {t.updates.length === 0 ? (
        <Empty>No posts yet.</Empty>
      ) : (
        <Timeline>
          {t.updates.map((u) => (
            <TimelineRow key={u.id} at={u.createdAt} dot={u.progress ? undefined : 'bg-sky-500/70'}>
              <PostCard u={u} projectId={String(t.projectId)} onChange={onChange} />
            </TimelineRow>
          ))}
        </Timeline>
      )}
    </section>
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
      <time
        dateTime={at}
        title={stamp(at)}
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
  const replies = u.thread.count
  const count = `${replies} ${replies === 1 ? 'reply' : 'replies'}`
  return (
    <article
      className={cn(
        'rounded-lg border',
        !u.progress && 'bg-muted/30',
        u.decision && !u.decidedAt && 'border-amber-500/60 bg-amber-500/5',
      )}
    >
      {/* The post without its thread: hovering it shows its actions, hovering one of its replies does not. */}
      <div className="group/post p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Actor name={u.author} via={u.via} className="text-foreground" />
          {u.handoff ? (
            <span
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium"
              title="A resume note as it was saved: where the work was left off then"
            >
              <Bookmark className="size-3" /> resume note
            </span>
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
 * one (and an optional note) answers it; once decided the choice stays marked and can be changed.
 */
function DecisionCard({ u, onChange }: { u: UpdateRow; onChange: () => void }) {
  const options = u.decision!
  const decided = u.decidedOption !== null && u.decidedAt !== null
  const [changing, setChanging] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const choosing = !decided || changing
  const decide = useMutation({
    mutationFn: () => put(`/api/updates/${u.id}/decision`, { option: picked, note }),
    onSuccess: () => {
      setChanging(false)
      setPicked(null)
      setNote('')
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <div className="mt-3 space-y-2" role="group" aria-label="Decision">
      <div className="flex items-center gap-2 text-xs">
        <Scale className="size-3.5 text-amber-600 dark:text-amber-400" />
        {decided && !changing ? (
          <span className="text-muted-foreground">
            decided by <Actor name={u.decidedBy} /> {ago(u.decidedAt!)} ·{' '}
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

/** A preview the board is building or running (and so can stop). */
const previewActive = (m: ManagedPreview | null | undefined) =>
  !!m && (m.status === 'building' || m.status === 'starting' || m.status === 'running')

const STEP_LABEL: Record<NonNullable<ManagedPreview['step']>, string> = {
  install: 'installing dependencies',
  build: 'building',
  copy: 'copying the live data',
  server: 'starting the server',
}

/**
 * Where the ticket's work runs for the human to try: a row per workspace with a preview link, or one
 * the board can build and run a preview of (its own worktree on this machine).
 */
function Previews({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const candidates = [
    ...t.workspaces.filter((w) => w.previewUrl || w.path).map((w) => ({ ...w, lane: null })),
    // The lanes' come with the git state, tagged with their lane.
    ...(git?.workspaces ?? []).filter((w) => w.lane && w.previewUrl),
  ]
  // Polled only while the page is in view: TanStack Query pauses intervals in a hidden tab. Faster
  // while the board builds or starts one.
  const previews = useQueries({
    queries: candidates.map((w) => ({
      queryKey: ['preview', w.id, w.previewUrl],
      queryFn: () => get<WorkspacePreview>(`/api/workspaces/${w.id}/preview`),
      refetchInterval: (q: { state: { data?: WorkspacePreview } }) =>
        previewActive(q.state.data?.managed) && q.state.data?.managed?.status !== 'running' ? 2_000 : 15_000,
      retry: false,
    })),
  })
  const rows = candidates
    .map((w, i) => ({ w, query: previews[i]! }))
    // A worktree shows only once the board says it could run it, or ran it before.
    .filter(({ w, query: { data } }) => w.previewUrl || data?.managed || data?.cannotStart === null)
  if (!rows.length) return null
  return (
    <section className="rounded-lg border p-3" aria-label="Preview">
      <h2 className="mb-2 text-sm font-medium">Preview</h2>
      <ul className="space-y-3">
        {rows.map(({ w, query }) => (
          <PreviewRow
            key={w.id}
            w={w}
            data={query.data}
            error={query.error}
            projectId={t.projectId}
            onChange={() => {
              void query.refetch()
              onChange()
            }}
          />
        ))}
      </ul>
    </section>
  )
}

function PreviewRow({
  w,
  data,
  error,
  projectId,
  onChange,
}: {
  w: Workspace & { lane: { id: number; title: string } | null }
  data: WorkspacePreview | undefined
  error: Error | null
  projectId: number
  onChange: () => void
}) {
  const action = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') => post(`/api/workspaces/${w.id}/preview/${what}`),
    onSuccess: onChange,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const url = data?.url ?? w.previewUrl
  const m = data?.managed ?? null
  const active = previewActive(m)
  const state = !url
    ? null
    : data
      ? data.running
        ? {
            label: 'Running',
            title: `Answered with HTTP ${data.status} at ${clock(data.checkedAt)}`,
            className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          }
        : {
            label: 'Not running',
            title: `No answer at ${clock(data.checkedAt)}`,
            className: 'bg-muted text-muted-foreground',
          }
      : error
        ? { label: 'Not checked', title: errorMessage(error), className: 'bg-muted text-muted-foreground' }
        : { label: 'Checking…', title: 'Checking whether it answers', className: 'text-muted-foreground' }
  const logUrl = (name: 'build' | 'server') => `/api/workspaces/${w.id}/preview/log?name=${name}`
  return (
    <li className="space-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm' })}>
            Open preview <ExternalLink />
          </a>
        )}
        {!active && data?.cannotStart === null && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate('start')}
            title="Build this worktree and run it on a free port, with a fresh copy of the live data"
          >
            <Play /> Start
          </Button>
        )}
        {active && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('stop')}
              title="Stop the preview and free its port"
            >
              <Square /> Stop
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate('restart')}
              title="Stop it, build again and start it with a fresh copy of the data"
            >
              <RotateCw /> Restart
            </Button>
          </>
        )}
        {state && (
          <span
            className={cn(
              'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]',
              state.className,
            )}
            title={state.title}
          >
            {data && <span className="size-1.5 rounded-full bg-current" />}
            {state.label}
          </span>
        )}
      </div>
      {url && (
        <div className="truncate font-mono text-xs text-muted-foreground" title={url}>
          {url}
        </div>
      )}
      {m && <ManagedLine m={m} logUrl={logUrl} />}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span
          className="inline-flex min-w-0 items-center gap-1 font-mono"
          title={`workspace ${w.name}${w.path ? ` in ${w.path}` : ''}`}
        >
          <GitBranch className="size-3 shrink-0" /> <span className="truncate">{w.branch || w.name}</span>
        </span>
        {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
      </div>
      {w.lane && (
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: String(projectId), ticketId: String(w.lane.id) }}
          className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Layers className="size-3 shrink-0" /> <span className="truncate">{w.lane.title}</span>
        </Link>
      )}
    </li>
  )
}

/** What the board's own preview of the workspace is doing, and why it failed or stopped. */
function ManagedLine({ m, logUrl }: { m: ManagedPreview; logUrl: (name: 'build' | 'server') => string }) {
  const log = (name: 'build' | 'server', label = 'full log') => (
    <a href={logUrl(name)} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
      {label}
    </a>
  )
  if (m.status === 'building' || m.status === 'starting')
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {m.status === 'starting' && m.port ? `Starting on :${m.port}…` : 'Building…'}
        {m.step && ` ${STEP_LABEL[m.step]}`} · {log(m.step === 'server' ? 'server' : 'build', 'log')}
      </div>
    )
  if (m.status === 'running')
    return (
      <div className="text-xs text-muted-foreground">
        Run by the board on :{m.port}
        {m.runningAt && `, since ${clock(m.runningAt)}`} · {log('server', 'server log')}
      </div>
    )
  if (m.status === 'failed')
    return (
      <div className="space-y-1 text-xs">
        <div className="text-destructive">
          Failed: {m.reason}
          {m.tailLog && <> · {log(m.tailLog)}</>}
        </div>
        {m.tail.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
            {m.tail.join('\n')}
          </pre>
        )}
      </div>
    )
  return (
    <div className="text-xs text-muted-foreground">
      {m.reason?.startsWith('stopped')
        ? m.reason.charAt(0).toUpperCase() + m.reason.slice(1)
        : `Stopped${m.reason ? `: ${m.reason}` : ''}`}
      {m.stoppedAt && ` (${clock(m.stoppedAt)})`}
    </div>
  )
}

function GitPanel({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/workspaces/${id}`),
    onSuccess: onChange,
    onError,
  })
  const Info = ({ info }: { info: TicketGit['info'] }) =>
    info.exists ? (
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
  return (
    <>
      <section className="rounded-lg border p-3">
        <h2 className="mb-2 flex items-center text-sm font-medium">
          Branch
          {git?.repo && (
            <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">
              {git.repo.name}
            </span>
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
          <p className="text-xs text-muted-foreground">
            No branch yet: pick one above, or the agent sets it.
          </p>
        )}
        {t.pr && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {t.pr.url ? (
              <a
                href={t.pr.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium hover:underline"
              >
                PR #{t.pr.number} <ExternalLink className="size-3 text-muted-foreground" />
              </a>
            ) : (
              <span className="font-medium">PR #{t.pr.number}</span>
            )}
            {t.pr.queue && <span className="text-muted-foreground">{STATUS_LABEL[t.pr.queue.status]}</span>}
            {t.pr.latestReview && (
              <ReviewResultButton
                resultId={t.pr.latestReview.id}
                className={`rounded bg-muted px-1 hover:underline ${t.pr.latestReview.fresh === false ? 'opacity-60' : ''}`}
                title={t.pr.latestReview.fresh === false ? 'review is for an older SHA' : 'latest review'}
              >
                {t.pr.latestReview.verdict}
              </ReviewResultButton>
            )}
          </div>
        )}
        {t.pr?.queue?.open && <PrState pr={t.pr.queue} className="mt-1.5" />}
      </section>
      <section className="rounded-lg border p-3">
        <h2 className="mb-2 text-sm font-medium">Workspaces</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Worktrees, sub-branches and subagent sandboxes the agents opened for this ticket
          {t.lanes.length > 0 && ' and its lanes'}.
        </p>
        <ul className="space-y-2">
          {(
            git?.workspaces ?? t.workspaces.map((w) => ({ ...w, info: null, worktree: null, lane: null }))
          ).map((w) => (
            <li key={w.id} className="group text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{w.name}</span>
                {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
                <button
                  type="button"
                  className="ml-auto opacity-0 group-hover:opacity-100"
                  onClick={() => remove.mutate(w.id)}
                  title="remove"
                >
                  <X className="size-3.5 text-muted-foreground" />
                </button>
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
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={w.worktree.path}>
                  {w.worktree.path}
                </div>
              )}
            </li>
          ))}
        </ul>
        {t.workspaces.length === 0 && !git?.workspaces.length && (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
      </section>
    </>
  )
}
