import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Layers,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { BranchSelect } from '#/components/BranchSelect'
import { StatusSelect } from '#/components/StatusSelect'
import { Attachments } from '#/components/Attachments'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { NewTicket } from '#/components/NewTicket'
import { Tag, compareTags } from '#/components/Tag'
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
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
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
  type UpdateRow,
} from '#/lib/api'
import type { TicketStatus } from '#/lib/constants'
import { STATUS_LABEL, ago, shortSha, stamp } from '#/lib/format'
import {
  LANE_ORDER,
  type LaneFilter,
  effectiveFilter,
  laneFilter,
  laneNeighbours,
  laneSearch,
  sortLanes,
  stageOk,
  tagOk,
  validateLaneSearch,
} from '#/lib/lanes'
import { useProject } from '#/lib/project'

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
  const { data: git } = useQuery({
    queryKey: ['ticket-git', ticketId],
    queryFn: () => get<TicketGit>(`/api/tickets/${ticketId}/git`),
    refetchInterval: 30_000,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['tickets', id] })
    qc.invalidateQueries({ queryKey: ['ticket-git', ticketId] })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const update = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch(`/api/tickets/${ticketId}`, p),
    onSuccess: invalidate,
    onError,
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
  const judge = useMutation({
    mutationFn: (v: { ticketId: number; verdict: Verdict }) =>
      put(`/api/tickets/${v.ticketId}/approval`, { verdict: v.verdict }),
    onSuccess: (_d, v) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
      // The parent's lanes list shows the same call.
      if (t?.parentId) qc.invalidateQueries({ queryKey: ['ticket', String(t.parentId)] })
    },
    onError,
  })
  // On a lane: the parent's lanes, for previous / next under the same filter. Same query as the
  // parent's own page, so it is usually cached already.
  const { data: parent } = useQuery({
    queryKey: ['ticket', String(t?.parentId), false],
    queryFn: () => get<TicketFull>(`/api/tickets/${t!.parentId}`),
    enabled: Boolean(t?.parentId),
    refetchInterval: 10_000,
  })
  const [editing, setEditing] = useState(false)

  if (error) return <p className="text-sm text-destructive">{errorMessage(error)}</p>
  if (!t) return null
  const openLanes = t.lanes.filter((l) => l.status !== 'done' && l.status !== 'cancelled').length
  const lanesWarning = openLanes > 0 && (t.status === 'review' || t.status === 'done')

  return (
    <div className="space-y-6">
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
      </nav>

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="text-muted-foreground">#{t.id}</span> {t.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              opened by <Actor name={t.createdBy} /> {ago(t.createdAt)}
            </span>
            <span>updated {ago(t.updatedAt)}</span>
            {t.tags.length > 0 && (
              <span className="inline-flex flex-wrap gap-1">
                {[...t.tags].sort(compareTags).map((tag) => (
                  <Tag key={tag} tag={tag} />
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lanesWarning && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
              title="This ticket is marked further along than its lanes"
            >
              <TriangleAlert className="size-3.5" /> {openLanes} lane{openLanes === 1 ? '' : 's'} not done
            </span>
          )}
          {(t.parentId || verdictOf(t)) && (
            <VerdictButtons
              t={t}
              disabled={judge.isPending}
              onSet={(verdict) => judge.mutate({ ticketId: t.id, verdict })}
            />
          )}
          <StatusSelect value={t.status} onChange={(status) => update.mutate({ status })} />
          <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
            <Pencil data-icon="inline-start" /> Edit
          </Button>
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
      </div>

      {editing ? (
        <EditTicket
          t={t}
          onSave={(p) => update.mutate(p, { onSuccess: () => setEditing(false) })}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          {/* minmax(0,…) and min-w-0: a long line (a lane's last update, a code block) must not
              widen the page */}
          <div className="min-w-0 space-y-6">
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 text-sm font-medium">Instructions</h2>
              {t.body ? (
                <Markdown>{t.body}</Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">No instructions yet.</p>
              )}
            </section>
            <Tasks t={t} onChange={invalidate} />
            <Lanes
              t={t}
              filter={filter}
              onFilter={setFilter}
              onVerdict={(ticketId, verdict) => judge.mutate({ ticketId, verdict })}
              judging={judge.isPending}
            />
            <Updates t={t} onChange={invalidate} laneFeed={laneFeed} onLaneFeed={setLaneFeed} />
            <section>
              <h2 className="mb-3 text-sm font-medium">Thread</h2>
              <Thread parentType="ticket" parentId={t.id} />
            </section>
          </div>
          <aside className="min-w-0 space-y-4">
            <GitPanel t={t} git={git} onChange={invalidate} />
          </aside>
        </div>
      )}
    </div>
  )
}

function EditTicket({
  t,
  onSave,
  onCancel,
}: {
  t: TicketFull
  onSave: (p: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(t.title)
  const [body, setBody] = useState(t.body)
  const [assignee, setAssignee] = useState(t.assignee)
  const [branch, setBranch] = useState(t.branch)
  const [baseBranch, setBaseBranch] = useState(t.baseBranch)
  const [tags, setTags] = useState(t.tags.join(', '))
  const { data: project } = useProject(t.projectId)
  const repos = project?.repos ?? []
  const [repoId, setRepoId] = useState(String(t.repoId ?? repos[0]?.id ?? ''))
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          title,
          body,
          assignee,
          branch,
          baseBranch,
          tags: tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(repoId ? { repoId: Number(repoId) } : {}),
        })
      }}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        placeholder="Instructions (markdown)"
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="repo">Repository</Label>
          <Select
            value={repoId}
            onValueChange={(v) => setRepoId(v as string)}
            items={Object.fromEntries(repos.map((r) => [String(r.id), r.name]))}
            disabled={repos.length < 2}
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
        <div className="space-y-1">
          <Label htmlFor="assignee">Assignee</Label>
          <Input
            id="assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="claude, codex…"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="branch">Branch</Label>
          <BranchSelect id="branch" value={branch} onChange={setBranch} repoId={repoId} optional />
        </div>
        <div className="space-y-1">
          <Label htmlFor="base">Base branch</Label>
          <BranchSelect id="base" value={baseBranch} onChange={setBaseBranch} repoId={repoId} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tags">Tags, comma separated</Label>
        <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="High, Forms" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
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

const STAGE_TAG: Record<TicketStatus, string> = {
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  review: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  in_progress: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  todo: 'bg-muted text-foreground/80',
  backlog: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
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
  const { prev, next, index, count, filtered } = laneNeighbours(lanes, id, filter)
  const step = (lane: (typeof lanes)[number] | null, dir: 'prev' | 'next') =>
    lane ? (
      <Link
        to="/projects/$id/features/$ticketId"
        params={{ id: projectId, ticketId: String(lane.id) }}
        search={laneSearch(filter)}
        title={`#${lane.id} ${lane.title}`}
        className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-muted hover:text-foreground"
        aria-label={dir === 'prev' ? 'Previous lane' : 'Next lane'}
      >
        {dir === 'prev' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
      </Link>
    ) : (
      <span className="inline-flex size-7 items-center justify-center rounded-md border opacity-40">
        {dir === 'prev' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
      </span>
    )
  return (
    <span className="ml-auto inline-flex items-center gap-2 text-xs">
      {step(prev, 'prev')}
      <span className="tabular-nums">
        {index >= 0 ? `lane ${index + 1} of ${count}` : `${count} lane${count === 1 ? '' : 's'}`}
        {filtered && ' (filtered)'}
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
  onVerdict: (ticketId: number, verdict: Verdict) => void
  judging: boolean
}) {
  const done = t.lanes.filter((l) => l.status === 'done').length
  const cancelled = t.lanes.filter((l) => l.status === 'cancelled').length
  const approved = t.lanes.filter((l) => l.approvedAt).length
  const disapproved = t.lanes.filter((l) => l.disapprovedAt).length
  // Filter by stage and by tag: within a row any picked chip matches, across rows all must. Each
  // row counts the lanes the other row lets through, so a number is what clicking it would show.
  const filter = effectiveFilter(t.lanes, wanted)
  const toggled = <T,>(list: T[], key: T) =>
    list.includes(key) ? list.filter((x) => x !== key) : [...list, key]

  const tagCounts = new Map<string, { tag: string; count: number }>()
  for (const l of t.lanes)
    for (const tag of l.tags) {
      const key = tag.toLowerCase()
      const entry = tagCounts.get(key) ?? { tag, count: 0 }
      if (stageOk(l, filter)) entry.count++
      tagCounts.set(key, entry)
    }
  const tags = [...tagCounts.values()].sort((a, b) => compareTags(a.tag, b.tag))
  const stageChips = LANE_ORDER.filter((s) => t.lanes.some((l) => l.status === s)).map((s) => ({
    key: s,
    label: (
      <span className={`rounded-full px-1.5 py-px text-[11px] font-medium ${STAGE_TAG[s]}`}>
        {STATUS_LABEL[s]}
      </span>
    ),
    count: t.lanes.filter((l) => l.status === s && tagOk(l, filter)).length,
  }))
  const filtering = filter.stages.length > 0 || filter.tags.length > 0
  const lanes = sortLanes(t.lanes.filter((l) => stageOk(l, filter) && tagOk(l, filter)))
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
                  onClick={() => onFilter({ stages: [], tags: [] })}
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
                    onSet={(verdict) => onVerdict(l.id, verdict)}
                  />
                </span>
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: String(t.projectId), ticketId: String(l.id) }}
                  search={laneSearch(filter)}
                  className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-3 pl-2"
                >
                  <span
                    className={`mt-px w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${STAGE_TAG[l.status]}`}
                  >
                    {STATUS_LABEL[l.status]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm leading-snug">
                      <span className="text-muted-foreground">#{l.id}</span>{' '}
                      <span className={l.status === 'cancelled' ? 'text-muted-foreground line-through' : ''}>
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

function Updates({
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
  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      return post(`/api/tickets/${t.id}/updates`, { body, attachmentIds })
    },
    onSuccess: () => {
      setBody('')
      setFiles([])
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-medium">Updates</h2>
        {t.lanes.length > 0 && (
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Switch size="sm" checked={laneFeed} onCheckedChange={onLaneFeed} /> include lanes
          </label>
        )}
      </div>
      <form
        className="mb-4 space-y-2 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) send.mutate()
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="Post progress (markdown). Agents post here too, with screenshots and recordings."
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,.md,.txt,.log,.pdf"
            onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
            <Paperclip data-icon="inline-start" /> attach
          </Button>
          {files.map((f, i) => (
            <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {f.name}
            </span>
          ))}
          <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Posting…' : 'Post update'}
          </Button>
        </div>
      </form>
      {t.updates.length === 0 ? (
        <Empty>No updates yet.</Empty>
      ) : (
        <div className="space-y-3">
          {t.updates.map((u) => (
            <UpdateCard key={u.id} u={u} projectId={String(t.projectId)} />
          ))}
        </div>
      )}
    </section>
  )
}

function UpdateCard({ u, projectId }: { u: UpdateRow; projectId: string }) {
  const [thread, setThread] = useState(false)
  return (
    <article className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Actor name={u.author} className="text-foreground" />
        <span title={stamp(u.createdAt)}>{ago(u.createdAt)}</span>
        {u.lane && (
          <Link
            to="/projects/$id/features/$ticketId"
            params={{ id: projectId, ticketId: String(u.lane.id) }}
            className="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 hover:text-foreground"
          >
            <Layers className="size-3 shrink-0" /> <span className="max-w-48 truncate">{u.lane.title}</span>
          </Link>
        )}
        <button type="button" className="ml-auto hover:text-foreground" onClick={() => setThread((v) => !v)}>
          {thread ? 'hide thread' : 'thread'}
        </button>
      </div>
      <Markdown className="mt-2">{u.body}</Markdown>
      <Attachments items={u.attachments} />
      {thread && (
        <div className="mt-3 border-t pt-3">
          <Thread parentType="update" parentId={u.id} compact />
        </div>
      )}
    </article>
  )
}

function GitPanel({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: () => post(`/api/tickets/${t.id}/workspaces`, { name, branch }),
    onSuccess: () => {
      setName('')
      setBranch('')
      onChange()
    },
    onError,
  })
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
            {git && <Info info={git.info} />}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No branch yet. Edit the ticket or let the agent set it.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs">
          {t.assignee ? (
            <>
              <span className="text-muted-foreground">assignee</span> <Actor name={t.assignee} />
            </>
          ) : (
            <span className="text-muted-foreground">unassigned</span>
          )}
        </div>
      </section>
      <section className="rounded-lg border p-3">
        <h2 className="mb-2 text-sm font-medium">Workspaces</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Worktrees, sub-branches and subagent sandboxes opened for this ticket
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
              {w.branch && <div className="font-mono text-xs">{w.branch}</div>}
              {w.info && <Info info={w.info} />}
              {w.worktree && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={w.worktree.path}>
                  {w.worktree.path}
                </div>
              )}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className="h-7 text-xs"
          />
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch"
            className="h-7 font-mono text-xs"
          />
          <Button type="submit" size="xs" variant="outline" disabled={!name.trim()}>
            <Plus data-icon="inline-start" /> Add workspace
          </Button>
        </form>
      </section>
    </>
  )
}
