import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

import { Actor } from '#/components/Actor'
import { Markdown } from '#/components/Markdown'
import { Thread } from '#/components/Thread'
import { Badge } from '#/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { errorMessage, get, type ReviewResult } from '#/lib/api'
import { ago, shortSha, stamp } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'
import { cn } from '#/lib/utils'

export function verdictTone(v: string): 'default' | 'destructive' | 'secondary' {
  if (v.startsWith('SHIP')) return 'default'
  if (v.startsWith('COULD NOT') || v.startsWith('STALE')) return 'secondary'
  return 'destructive'
}

/** One review result in full: verdict, PR and SHA, who and when, checks, counts, summary and its thread. */
export function ReviewResultView({ r }: { r: ReviewResult }) {
  const { data: project } = useProject(r.projectId)
  const repo = repoLabel(project, r.repoId)
  const counts = r.counts as Record<string, number>
  const checks = r.checks as Record<string, string>
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={verdictTone(r.verdict)}>{r.verdict}</Badge>
        <span className="font-medium">
          {repo && <span className="text-muted-foreground">{repo} </span>}PR #{r.prNumber}
        </span>
        <span className="font-mono text-xs text-muted-foreground" title={r.sha}>
          {shortSha(r.sha)}
        </span>
        <span className="text-xs text-muted-foreground">
          {counts.confirmed ?? 0} confirmed · {counts.plausible ?? 0} plausible · {counts.unverified ?? 0}{' '}
          unverified
        </span>
        <span className="ml-auto text-xs text-muted-foreground" title={stamp(r.createdAt)}>
          <Actor name={r.author} /> · {ago(r.createdAt)}
        </span>
      </div>
      {Object.keys(checks).length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {Object.entries(checks).map(([k, v]) => (
            <span
              key={k}
              className={`rounded px-1.5 py-0.5 ${v === 'YES' ? 'bg-muted' : 'bg-destructive/10 text-destructive'}`}
            >
              {k}: {v}
            </span>
          ))}
        </div>
      )}
      <Markdown>{r.summaryMd}</Markdown>
      <div className="border-t pt-3">
        <Thread parentType="review" parentId={r.id} compact />
      </div>
    </div>
  )
}

/** A dialog with one review result, loaded by id; `resultId` null keeps it closed. */
export function ReviewResultDialog({ resultId, onClose }: { resultId: number | null; onClose: () => void }) {
  // Keeps showing the last result while the dialog animates closed.
  const [last, setLast] = useState(resultId)
  if (resultId !== null && resultId !== last) setLast(resultId)
  const shownId = resultId ?? last
  const { data, error } = useQuery({
    queryKey: ['review-result', shownId],
    queryFn: () => get<ReviewResult>(`/api/reviews/results/${shownId}`),
    enabled: shownId !== null,
  })
  return (
    <Dialog open={resultId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review result</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : data ? (
          <ReviewResultView r={data} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A clickable verdict (or anything else) that opens its review result in a dialog, in place. */
export function ReviewResultButton({
  resultId,
  className,
  title,
  children,
}: {
  resultId: number
  className?: string
  title?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={cn('cursor-pointer', className)}
        title={title}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <ReviewResultDialog resultId={open ? resultId : null} onClose={() => setOpen(false)} />
    </>
  )
}
