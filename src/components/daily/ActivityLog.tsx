import { Actor } from '#/components/Actor'
import { Empty } from '#/components/Empty'
import { ReviewResultButton } from '#/components/ReviewResult'
import { SettingsChangeDiff } from '#/components/daily/SettingsChangeDiff'
import type { DailyPayload } from '#/lib/api'
import { clock } from '#/lib/format'

const KIND_LABEL: Record<string, string> = {
  ticket: 'tickets',
  task: 'tasks',
  update: 'updates',
  comment: 'comments',
  pr: 'PRs',
  review: 'reviews',
  workspace: 'workspaces',
  agent: 'agents',
  project: 'projects',
  summary: 'summaries',
  report: 'reports',
}

/**
 * What everyone did on the day, hour by hour, with how many actions of each kind and by whom on top.
 * On the all-projects page each line names its project.
 */
export function ActivityLog({
  activity,
  projectId,
  date,
}: {
  /** The day's activity; undefined while it loads. */
  activity: DailyPayload['activity'] | undefined
  projectId?: number
  date: string
}) {
  if (!activity) return null
  if (!activity.length) return <Empty>Nothing happened on {date}.</Empty>

  const hours = new Map<string, DailyPayload['activity']>()
  for (const a of activity) {
    const h = `${String(new Date(a.createdAt).getHours()).padStart(2, '0')}:00`
    hours.set(h, [...(hours.get(h) ?? []), a])
  }
  const kinds = new Map<string, number>()
  for (const a of activity) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
  const actors = new Set(activity.map((a) => a.actor))

  return (
    <section className="space-y-4" aria-label="Activity">
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{activity.length} actions</span>
        {[...kinds].map(([k, n]) => (
          <span key={k} className="rounded bg-muted px-1.5 py-0.5">
            {n} {KIND_LABEL[k] ?? k}
          </span>
        ))}
        <span className="ml-auto">by {[...actors].join(', ')}</span>
      </div>

      <ol className="space-y-4">
        {[...hours].map(([hour, items]) => (
          <li key={hour} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3">
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
                  {/* A long word (a URL, a path) breaks anywhere rather than widen the page on a phone. */}
                  {a.refType === 'review' && a.refId ? (
                    <ReviewResultButton
                      resultId={a.refId}
                      className="min-w-0 text-left wrap-anywhere hover:underline"
                      title="Open the review result"
                    >
                      {a.text}
                    </ReviewResultButton>
                  ) : a.refType === 'report-settings-change' && a.refId ? (
                    <SettingsChangeDiff changeId={a.refId}>{a.text}</SettingsChangeDiff>
                  ) : (
                    <span className="min-w-0 wrap-anywhere">{a.text}</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  )
}
