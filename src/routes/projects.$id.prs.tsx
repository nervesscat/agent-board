import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ExternalLink, GitMerge, MessageSquare, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Empty } from '#/components/Empty'
import { PrAlert, PrState } from '#/components/PrState'
import { ReviewResultDialog, verdictTone } from '#/components/ReviewResult'
import { Thread } from '#/components/Thread'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, get, patch, type PrRow } from '#/lib/api'
import { ago, shortSha } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'
import { recall, remember, useRestoreRemembered } from '#/lib/remembered'
import { anchorId, useAnchor, useReveal } from '#/lib/reveal'

const FILTER_KEYS = ['me', 'others'] as const
type Filter = (typeof FILTER_KEYS)[number]

// ?result=<id> opens that review result over the queue (a verdict on a card links there); ?filter= is
// the filter picked (none, or one no longer offered such as an old `all`: the one this browser
// remembers, else To review). A link lands on a PR's card as #pr-<id>, on a reply in its thread as
// #pr-<id>-reply-<id>, on a reply to the review result as #reply-<id> (src/lib/reveal.ts).
export const Route = createFileRoute('/projects/$id/prs')({
  component: PrQueue,
  validateSearch: z.object({
    result: z.number().int().positive().optional().catch(undefined),
    filter: z.enum(FILTER_KEYS).optional().catch(undefined),
  }),
})

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'done', label: 'Done' },
] as const

const FILTERS: { key: Filter; label: string; title: string }[] = [
  {
    key: 'me',
    label: 'To review',
    title: 'PRs by others you review: pending your approval, approved by you, or on hold on your comments',
  },
  {
    key: 'others',
    label: 'Waiting on others',
    title:
      "Your PRs (agents' too): pending approvals, approved by every reviewer, or on hold on their comments",
  },
]
// A tab's underline, drawn by the line style only (these are the default style), hangs 5px below it:
// without it, nothing of a tab reaches outside its list, so the list has nothing to scroll.
const NO_UNDERLINE = 'after:hidden'
// The last filter picked is remembered in this browser, for a visit whose URL names none.
const FILTER_KEY = 'prs.filter'

function PrQueue() {
  const { id } = Route.useParams()
  const { result, filter: picked } = Route.useSearch()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const key = ['prs', id]
  const { data: project } = useProject(id)
  // The tab and the list both follow the URL, so the server's render and the browser's agree.
  const filter = picked ?? 'me'
  // Put in the URL for the reader (the remembered one, or the one that shows a linked PR): the link's
  // anchor stays. A filter the reader picks ends what the link had to show.
  const showFilter = (f: Filter) =>
    navigate({ search: (s) => ({ ...s, filter: f }), hash: true, replace: true })
  useRestoreRemembered(FILTER_KEY, picked, FILTER_KEYS, showFilter)
  const pickFilter = (f: Filter) => {
    navigate({ search: (s) => ({ ...s, filter: f }), replace: true })
    remember(FILTER_KEY, f)
  }
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: key,
    queryFn: () => get<PrRow[]>(`/api/projects/${id}/prs`),
    refetchInterval: 60_000,
  })
  const refresh = useMutation({
    mutationFn: () => get<PrRow[]>(`/api/projects/${id}/prs?refresh=1`),
    onSuccess: (rows) => qc.setQueryData(key, rows),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const inFilter = (p: PrRow, f: Filter) => p.waitingOn === f
  const shown = data?.filter((p) => inFilter(p, filter)) ?? []

  const anchor = useAnchor()
  // The PR a link lands on: its stage's tab, once per link, and the filter that shows it (the side it
  // waits on) if the filter in the URL (once it is there, remembered or not) hides it.
  const linkedId = anchorId(anchor?.holder ?? anchor?.target, 'pr')
  const linked = data?.find((p) => p.id === linkedId)
  // The filter this browser remembers, read after mount: undefined for none, null until read.
  const [remembered, setRemembered] = useState<Filter | undefined | null>(null)
  useEffect(() => setRemembered(recall(FILTER_KEY, FILTER_KEYS)), [])
  // The filter the list stays on: the one in the URL, else To review once nothing remembered is to be
  // put there; null while that is not known yet.
  const staying = picked ?? (remembered === undefined ? 'me' : null)
  // The anchor is brought into view once the list it is in has settled: the remembered filter put in
  // the URL, then switched to the one that shows the linked PR if that hides it. Each switch redraws
  // the list, and an anchor revealed before them would be lost under them.
  const settled =
    staying !== null && (!linked || inFilter(linked, staying)) && (linkedId === null || data !== undefined)
  useReveal(anchor, { ready: settled })
  const [tab, setTab] = useState<string>('pending')
  const tabFor = useRef<string | null>(null)
  const switchedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!anchor || !linked) return
    if (tabFor.current !== anchor.hash) {
      tabFor.current = anchor.hash
      setTab(linked.status)
    }
    if (staying !== null && switchedFor.current !== anchor.hash) {
      switchedFor.current = anchor.hash
      if (!inFilter(linked, staying)) showFilter(linked.waitingOn)
    }
  }, [anchor, linked, staying])
  const suffix = FILTERS.find((f) => f.key === filter)!.label.toLowerCase()

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">PR queue</h1>
          <p className="text-sm text-muted-foreground">
            Pull requests by others that you review, and your own, across every repo of the project, by where
            their reviews stand; merged ones stay under Done for two weeks. Read-only against GitHub; holds
            and threads live here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Tabs value={filter} onValueChange={(v) => pickFilter(v as Filter)}>
            <TabsList>
              {FILTERS.map((f) => (
                <TabsTrigger key={f.key} value={f.key} title={f.title} className={NO_UNDERLINE}>
                  {f.label}
                  <span className="ml-1 rounded-full bg-background px-1.5 text-xs tabular-nums">
                    {data?.filter((p) => inFilter(p, f.key)).length ?? 0}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || isFetching}
          >
            <RefreshCw data-icon="inline-start" className={refresh.isPending ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          {/* Four stages do not fit one row on a phone: there they take two rows of two, so every stage
              and its count shows without the list or the page scrolling. */}
          <TabsList className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-auto sm:inline-flex sm:w-fit sm:group-data-horizontal/tabs:h-8">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className={NO_UNDERLINE}>
                {t.label}
                <span className="ml-1.5 rounded-full bg-background px-1.5 text-xs tabular-nums">
                  {shown.filter((p) => p.status === t.key).length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map((t) => (
            <TabsContent key={t.key} value={t.key} className="space-y-2">
              {shown.filter((p) => p.status === t.key).length ? (
                shown
                  .filter((p) => p.status === t.key)
                  .map((pr) => (
                    <PrCard key={pr.id} pr={pr} projectId={id} repo={repoLabel(project, pr.repoId)} />
                  ))
              ) : (
                <Empty>
                  Nothing {t.label.toLowerCase()} {suffix}.
                </Empty>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
      <ReviewResultDialog
        resultId={result ?? null}
        onClose={() => navigate({ search: (s) => ({ ...s, result: undefined }), replace: true })}
      />
    </div>
  )
}

/**
 * "merge after #12": the open PRs of tickets this PR's ticket needs, which have to land first. Each
 * links to its PR on GitHub.
 */
function MergeAfter({ pr }: { pr: PrRow }) {
  if (!pr.mergeAfter.length) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
      title={`Its ticket needs these merged first:\n${pr.mergeAfter.map((m) => `PR #${m.number} (from #${m.ticketId} ${m.title})`).join('\n')}`}
    >
      <GitMerge className="size-3" /> merge after{' '}
      {pr.mergeAfter.map((m, i) => (
        <span key={`${m.repoId}:${m.number}`}>
          {i > 0 && ', '}
          {m.url ? (
            <a href={m.url} target="_blank" rel="noreferrer" className="hover:underline">
              #{m.number}
            </a>
          ) : (
            `#${m.number}`
          )}
        </span>
      ))}
    </span>
  )
}

function PrCard({ pr, projectId, repo }: { pr: PrRow; projectId: string; repo: string | null }) {
  const qc = useQueryClient()
  const [thread, setThread] = useState(false)
  const [holdOpen, setHoldOpen] = useState(false)
  const [note, setNote] = useState(pr.holdNote)
  // A link to a reply in its thread (#pr-<id>-reply-<id>) opens the thread, once per link.
  const anchor = useAnchor()
  const opensFor = anchor?.holder === `pr-${pr.id}` ? anchor.hash : null
  useEffect(() => {
    if (opensFor) setThread(true)
  }, [opensFor])
  const hold = useMutation({
    mutationFn: (v: { hold: boolean; holdNote: string }) => patch<PrRow>(`/api/prs/${pr.id}`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prs', projectId] })
      setHoldOpen(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    // A link lands on it as #pr-<id>, below the top bar.
    <div
      id={`pr-${pr.id}`}
      className="scroll-mt-[calc(var(--ticket-header,4rem)+1rem)] rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PrAlert pr={pr} />
            <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              #{pr.number} {pr.title}
            </a>
            <ExternalLink className="size-3 text-muted-foreground" />
            {repo && <Badge variant="secondary">{repo}</Badge>}
            <MergeAfter pr={pr} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{pr.author}</span>
            <span className="font-mono">
              {pr.headRef} → {pr.baseRef}
            </span>
            <span className="font-mono">{shortSha(pr.headSha)}</span>
            <span>updated {ago(pr.updatedAt)}</span>
            {pr.mergedAt && <span>merged {ago(pr.mergedAt)}</span>}
            {pr.myReview !== 'none' && <span>· my review: {pr.myReview.replace('_', ' ')}</span>}
            <span>· {pr.waitingOn === 'me' ? 'for your review' : 'your PR'}</span>
          </div>
          {pr.open && <PrState pr={pr} className="mt-1.5" />}
          {pr.tickets.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
              {pr.tickets.map((t) => (
                <Link
                  key={t.id}
                  to="/projects/$id/features/$ticketId"
                  params={{ id: projectId, ticketId: String(t.id) }}
                  className="text-muted-foreground hover:text-foreground hover:underline"
                >
                  from #{t.id} {t.title}
                </Link>
              ))}
            </div>
          )}
          {pr.hold && pr.holdNote && <p className="mt-2 text-sm">{pr.holdNote}</p>}
        </div>
        <div className="flex items-center gap-1">
          {pr.latestReview && (
            <Link
              to="/projects/$id/prs"
              params={{ id: projectId }}
              search={{ result: pr.latestReview.id }}
              title={pr.latestReview.fresh ? 'reviewed at this SHA' : 'review is for an older SHA'}
            >
              <Badge
                variant={verdictTone(pr.latestReview.verdict)}
                className={pr.latestReview.fresh ? '' : 'opacity-60'}
              >
                {pr.latestReview.verdict}
              </Badge>
            </Link>
          )}
          <Button variant="ghost" size="sm" aria-expanded={thread} onClick={() => setThread((v) => !v)}>
            <MessageSquare data-icon="inline-start" /> thread
          </Button>
          {pr.hold ? (
            <Button variant="ghost" size="sm" onClick={() => hold.mutate({ hold: false, holdNote: '' })}>
              <PlayCircle data-icon="inline-start" /> release
            </Button>
          ) : (
            // A merged PR has nothing left to wait for.
            pr.open && (
              <Button variant="ghost" size="sm" onClick={() => setHoldOpen(true)}>
                <PauseCircle data-icon="inline-start" /> hold
              </Button>
            )
          )}
        </div>
      </div>
      {thread && (
        <div className="mt-3 border-t pt-3">
          <Thread parentType="pr" parentId={pr.id} compact />
        </div>
      )}
      <Dialog open={holdOpen} onOpenChange={setHoldOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Put #{pr.number} on hold</DialogTitle>
            <DialogDescription>A note for you and the agents. GitHub is not touched.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it waits…"
            rows={3}
            autoFocus
          />
          <DialogFooter>
            <Button onClick={() => hold.mutate({ hold: true, holdNote: note })} disabled={hold.isPending}>
              Hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
