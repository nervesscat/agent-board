import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'

import { Actor } from '#/components/Actor'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { Thread } from '#/components/Thread'
import { Badge } from '#/components/ui/badge'
import { get, type ReviewResult, type ReviewsPayload } from '#/lib/api'
import { ago, shortSha } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/reviews')({
  component: Reviews,
  validateSearch: z.object({ result: z.number().optional() }),
})

function Reviews() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const { data: project } = useProject(id)
  const { data, isLoading } = useQuery({
    queryKey: ['reviews', id],
    queryFn: () => get<ReviewsPayload>(`/api/projects/${id}/reviews`),
    refetchInterval: 30_000,
  })
  const [openResult, setOpenResult] = useState<number | null>(search.result ?? null)

  if (isLoading || !data) return null
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reviews</h1>
        <p className="text-sm text-muted-foreground">
          PR reviews recorded by you or an agent, newest first. Nothing is posted to GitHub.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Findings</h2>
        {data.results.length === 0 ? (
          <Empty>No review results yet. An agent records one when it reviews a PR.</Empty>
        ) : (
          <div className="space-y-2">
            {data.results.map((r) => (
              <ResultCard
                key={r.id}
                r={r}
                repo={repoLabel(project, r.repoId)}
                open={openResult === r.id}
                onToggle={() => setOpenResult(openResult === r.id ? null : r.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function verdictTone(v: string): 'default' | 'destructive' | 'secondary' {
  if (v.startsWith('SHIP')) return 'default'
  if (v.startsWith('COULD NOT') || v.startsWith('STALE')) return 'secondary'
  return 'destructive'
}

function ResultCard({
  r,
  repo,
  open,
  onToggle,
}: {
  r: ReviewResult
  repo: string | null
  open: boolean
  onToggle: () => void
}) {
  const counts = r.counts as Record<string, number>
  const checks = r.checks as Record<string, string>
  return (
    <article className="rounded-lg border" id={`result-${r.id}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
      >
        <Badge variant={verdictTone(r.verdict)}>{r.verdict}</Badge>
        <span className="font-medium">
          {repo && <span className="text-muted-foreground">{repo} </span>}PR #{r.prNumber}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{shortSha(r.sha)}</span>
        <span className="text-xs text-muted-foreground">
          {counts.confirmed ?? 0} confirmed · {counts.plausible ?? 0} plausible · {counts.unverified ?? 0}{' '}
          unverified
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          <Actor name={r.author} /> · {ago(r.createdAt)}
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t p-4">
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
      )}
    </article>
  )
}
