import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Play, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Actor } from '#/components/Actor'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { Thread } from '#/components/Thread'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Switch } from '#/components/ui/switch'
import {
  del,
  errorMessage,
  get,
  patch,
  post,
  type ReviewResult,
  type ReviewRun,
  type ReviewSchedule,
  type ReviewsPayload,
  type RunRow,
} from '#/lib/api'
import { WEEKDAYS, ago, shortSha, stamp } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/reviews')({
  component: Reviews,
  validateSearch: z.object({ result: z.number().optional(), run: z.number().optional() }),
})

function Reviews() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const qc = useQueryClient()
  const key = ['reviews', id]
  const { data: project } = useProject(id)
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<ReviewsPayload>(`/api/projects/${id}/reviews`),
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : 30_000),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: key })
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const [args, setArgs] = useState('mine')
  const run = useMutation({
    mutationFn: () => post(`/api/projects/${id}/reviews/run`, { args }),
    onSuccess: invalidate,
    onError,
  })
  const cancel = useMutation({
    mutationFn: () => post(`/api/projects/${id}/reviews/cancel`),
    onSuccess: invalidate,
    onError,
  })
  const [openRun, setOpenRun] = useState<number | null>(search.run ?? null)
  const [openResult, setOpenResult] = useState<number | null>(search.result ?? null)

  if (isLoading || !data) return null
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reviews</h1>
        <p className="text-sm text-muted-foreground">
          Runs <code className="rounded bg-muted px-1">/review-queue</code> unattended in each repo of the
          project, one after the other, and imports each PR's findings here. Nothing is posted to GitHub.
        </p>
      </div>

      <section className="rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Run now</h2>
          <Input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            className="h-8 max-w-xs font-mono text-xs"
            placeholder="mine deep drafts parallel=2 …"
          />
          {data.running ? (
            <Button size="sm" variant="destructive" onClick={() => cancel.mutate()}>
              <Square data-icon="inline-start" /> Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
              <Play data-icon="inline-start" /> Review my PRs
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            arguments after the repo path: <code>mine</code> = only PRs assigned to you (default)
          </span>
        </div>
      </section>

      <Schedules projectId={id} schedules={data.schedules} onChange={invalidate} />

      <section>
        <h2 className="mb-2 text-sm font-medium">Findings</h2>
        {data.results.length === 0 ? (
          <Empty>No review results yet. Run one, schedule one, or let an agent post one.</Empty>
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

      <section>
        <h2 className="mb-2 text-sm font-medium">Runs</h2>
        {data.runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <div className="space-y-2">
            {data.runs.map((r) => (
              <RunCard
                key={r.id}
                r={r}
                open={openRun === r.id}
                onToggle={() => setOpenRun(openRun === r.id ? null : r.id)}
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
          {r.reviewPath && <p className="font-mono text-[11px] text-muted-foreground">{r.reviewPath}</p>}
          <div className="border-t pt-3">
            <Thread parentType="review" parentId={r.id} compact />
          </div>
        </div>
      )}
    </article>
  )
}

function RunCard({ r, open, onToggle }: { r: RunRow; open: boolean; onToggle: () => void }) {
  const { data: full } = useQuery({
    queryKey: ['review-run', r.id],
    queryFn: () => get<ReviewRun>(`/api/reviews/runs/${r.id}`),
    enabled: open,
    refetchInterval: r.status === 'running' ? 2_000 : false,
  })
  return (
    <article className="rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left text-sm"
      >
        <Badge variant={r.status === 'done' ? 'default' : r.status === 'error' ? 'destructive' : 'secondary'}>
          {r.status}
        </Badge>
        <span className="font-mono text-xs">{r.args || 'default'}</span>
        <span className="text-xs text-muted-foreground">
          by <Actor name={r.startedBy} /> · {stamp(r.startedAt)}
          {r.finishedAt && ` → ${stamp(r.finishedAt)}`}
        </span>
        {r.queueDir && (
          <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{r.queueDir}</span>
        )}
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {full?.log || '…'}
        </pre>
      )}
    </article>
  )
}

function Schedules({
  projectId,
  schedules,
  onChange,
}: {
  projectId: string
  schedules: ReviewSchedule[]
  onChange: () => void
}) {
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState(0b0111110)
  const [args, setArgs] = useState('mine')
  const create = useMutation({
    mutationFn: () => post(`/api/projects/${projectId}/schedules`, { time, days, args }),
    onSuccess: onChange,
    onError,
  })
  const update = useMutation({
    mutationFn: (v: { id: number } & Partial<ReviewSchedule>) =>
      patch(`/api/schedules/${v.id}`, { ...v, id: undefined }),
    onSuccess: onChange,
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/schedules/${id}`),
    onSuccess: onChange,
    onError,
  })
  const [tz, setTz] = useState('')
  useEffect(() => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone), [])

  const DayPicker = ({ value, onToggle }: { value: number; onToggle: (bit: number) => void }) => (
    <div className="flex gap-1">
      {WEEKDAYS.map((d, i) => (
        <button
          key={d}
          type="button"
          onClick={() => onToggle(i)}
          className={`rounded px-1.5 py-0.5 text-[11px] ${(value >> i) & 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
        >
          {d}
        </button>
      ))}
    </div>
  )

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">Automatic reviews</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Local time{tz ? ` (${tz})` : ''}. The board process itself fires these, so it must be running —
        install it as a Windows task (README) and it runs whether you are logged on or not.
      </p>
      <ul className="space-y-2">
        {schedules.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 text-sm">
            <Switch
              checked={s.enabled}
              onCheckedChange={(v) => update.mutate({ id: s.id, enabled: Boolean(v) })}
            />
            <span className="font-mono">{s.time}</span>
            <DayPicker
              value={s.days}
              onToggle={(bit) => update.mutate({ id: s.id, days: s.days ^ (1 << bit) })}
            />
            <span className="font-mono text-xs text-muted-foreground">{s.args}</span>
            <span className="text-xs text-muted-foreground">
              last {s.lastRunAt ? ago(s.lastRunAt) : 'never'}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={() => remove.mutate(s.id)} title="remove">
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <Input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="h-8 w-28"
          required
        />
        <DayPicker value={days} onToggle={(bit) => setDays(days ^ (1 << bit))} />
        <Input
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          className="h-8 w-40 font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline">
          Add schedule
        </Button>
      </form>
    </section>
  )
}
