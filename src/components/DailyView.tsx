import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, get, post, type DailyPayload } from '#/lib/api'
import { clock, localDate, shiftDate } from '#/lib/format'

const KIND_LABEL: Record<string, string> = {
  ticket: 'tickets',
  task: 'tasks',
  update: 'updates',
  comment: 'comments',
  pr: 'PRs',
  review: 'reviews',
  workspace: 'workspaces',
  schedule: 'schedules',
  project: 'projects',
  summary: 'summaries',
}

/** One day, hour by hour: what every person and agent did, and the shortest possible summary on top. */
export function DailyView({ projectId }: { projectId?: number }) {
  const qc = useQueryClient()
  const [date, setDate] = useState(localDate())
  const key = ['daily', date, projectId ?? 'all']
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => get<DailyPayload>(`/api/daily?date=${date}${projectId ? `&projectId=${projectId}` : ''}`),
    refetchInterval: 15_000,
  })
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const [body, setBody] = useState('')
  const postSummary = useMutation({
    mutationFn: () => post('/api/daily/summaries', { date, projectId: projectId ?? null, body }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['daily'] })
    },
    onError,
  })
  const generate = useMutation({
    mutationFn: () => post('/api/daily/summaries/generate', { date, projectId: projectId ?? null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['daily'] }),
    onError,
  })

  const hours = new Map<string, DailyPayload['activity']>()
  for (const a of data?.activity ?? []) {
    const h = `${String(new Date(a.createdAt).getHours()).padStart(2, '0')}:00`
    hours.set(h, [...(hours.get(h) ?? []), a])
  }
  const kinds = new Map<string, number>()
  for (const a of data?.activity ?? []) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
  const actors = new Set((data?.activity ?? []).map((a) => a.actor))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daily</h1>
          <p className="text-sm text-muted-foreground">
            What got done, hour by hour, and the one-glance summary.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setDate(shiftDate(date, -1))}>
            <ChevronLeft />
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={date >= localDate()}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <section className="rounded-lg border p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">Summary</h2>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !data?.activity.length}
          >
            <Sparkles data-icon="inline-start" />{' '}
            {generate.isPending ? 'Asking claude…' : 'Summarize with claude'}
          </Button>
        </div>
        {data?.summaries.length ? (
          <div className="space-y-3">
            {data.summaries.map((s) => (
              <div key={s.id}>
                <div className="text-xs text-muted-foreground">
                  <Actor name={s.author} /> · {clock(s.createdAt)}
                  {!projectId &&
                    s.projectId &&
                    ` · ${data.projects.find((p) => p.id === s.projectId)?.name ?? ''}`}
                </div>
                <Markdown className="mt-0.5">{s.body}</Markdown>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody has summarized this day yet.</p>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (body.trim()) postSummary.mutate()
          }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Highest level, three lines at most."
          />
          <Button type="submit" size="sm" variant="outline" disabled={!body.trim()}>
            Post
          </Button>
        </form>
      </section>

      {data && data.activity.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{data.activity.length} actions</span>
          {[...kinds].map(([k, n]) => (
            <span key={k} className="rounded bg-muted px-1.5 py-0.5">
              {n} {KIND_LABEL[k] ?? k}
            </span>
          ))}
          <span className="ml-auto">by {[...actors].join(', ')}</span>
        </div>
      )}

      {!data ? null : data.activity.length === 0 ? (
        <Empty>Nothing happened on {date}.</Empty>
      ) : (
        <ol className="space-y-4">
          {[...hours].map(([hour, items]) => (
            <li key={hour} className="grid grid-cols-[3.5rem_1fr] gap-3">
              <div className="pt-0.5 text-right font-mono text-xs text-muted-foreground">
                {hour}
                <div className="text-[10px]">{items.length}</div>
              </div>
              <ul className="space-y-1 border-l pl-3">
                {items.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-mono text-[11px] text-muted-foreground">{clock(a.createdAt)}</span>
                    <Actor name={a.actor} />
                    {!projectId && a.project && (
                      <span className="text-xs text-muted-foreground">[{a.project}]</span>
                    )}
                    <span>{a.text}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
