import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ExternalLink, MessageSquare, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
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

export const Route = createFileRoute('/projects/$id/prs')({ component: PrQueue })

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'on_hold', label: 'On hold' },
] as const

function PrQueue() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const key = ['prs', id]
  const { data: project } = useProject(id)
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">PR queue</h1>
          <p className="text-sm text-muted-foreground">
            Open pull requests where your review is requested, across every repo of the project. Read-only
            against GitHub; holds and threads live here.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending || isFetching}
        >
          <RefreshCw data-icon="inline-start" className={refresh.isPending ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <Tabs defaultValue="pending">
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
                <span className="ml-1.5 rounded-full bg-background px-1.5 text-xs tabular-nums">
                  {data?.filter((p) => p.status === t.key).length ?? 0}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map((t) => (
            <TabsContent key={t.key} value={t.key} className="space-y-2">
              {data?.filter((p) => p.status === t.key).length ? (
                data
                  .filter((p) => p.status === t.key)
                  .map((pr) => (
                    <PrCard key={pr.id} pr={pr} projectId={id} repo={repoLabel(project, pr.repoId)} />
                  ))
              ) : (
                <Empty>Nothing {t.label.toLowerCase()}.</Empty>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  )
}

function PrCard({ pr, projectId, repo }: { pr: PrRow; projectId: string; repo: string | null }) {
  const qc = useQueryClient()
  const [thread, setThread] = useState(false)
  const [holdOpen, setHoldOpen] = useState(false)
  const [note, setNote] = useState(pr.holdNote)
  const hold = useMutation({
    mutationFn: (v: { hold: boolean; holdNote: string }) => patch<PrRow>(`/api/prs/${pr.id}`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prs', projectId] })
      setHoldOpen(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const verdictTone = pr.latestReview?.verdict.startsWith('SHIP')
    ? 'default'
    : pr.latestReview
      ? 'destructive'
      : 'secondary'

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              #{pr.number} {pr.title}
            </a>
            <ExternalLink className="size-3 text-muted-foreground" />
            {repo && <Badge variant="secondary">{repo}</Badge>}
            {pr.isDraft && <Badge variant="outline">draft</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{pr.author}</span>
            <span className="font-mono">
              {pr.headRef} → {pr.baseRef}
            </span>
            <span className="font-mono">{shortSha(pr.headSha)}</span>
            <span>updated {ago(pr.updatedAt)}</span>
            {pr.myReview !== 'none' && <span>· my review: {pr.myReview.replace('_', ' ')}</span>}
          </div>
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
              to="/projects/$id/reviews"
              params={{ id: projectId }}
              search={{ result: pr.latestReview.id }}
              title={pr.latestReview.fresh ? 'reviewed at this SHA' : 'review is for an older SHA'}
            >
              <Badge variant={verdictTone} className={pr.latestReview.fresh ? '' : 'opacity-60'}>
                {pr.latestReview.verdict}
              </Badge>
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={() => setThread((v) => !v)}>
            <MessageSquare data-icon="inline-start" /> thread
          </Button>
          {pr.hold ? (
            <Button variant="ghost" size="sm" onClick={() => hold.mutate({ hold: false, holdNote: '' })}>
              <PlayCircle data-icon="inline-start" /> release
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setHoldOpen(true)}>
              <PauseCircle data-icon="inline-start" /> hold
            </Button>
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
