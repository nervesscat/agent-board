import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Actor } from '#/components/Actor'
import { Empty } from '#/components/Empty'
import { ReviewResultButton } from '#/components/ReviewResult'
import { SettingsChangeDiff } from '#/components/daily/SettingsChangeDiff'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '#/components/ui/accordion'
import { Button } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import type { DailyPayload } from '#/lib/api'
import { clock } from '#/lib/format'
import { remember } from '#/lib/remembered'

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
  handoff: 'handoffs',
}
const KIND_ONE: Record<string, string> = {
  ticket: 'ticket',
  task: 'task',
  update: 'update',
  comment: 'comment',
  pr: 'PR',
  review: 'review',
  workspace: 'workspace',
  agent: 'agent',
  project: 'project',
  summary: 'summary',
  report: 'report',
  handoff: 'handoff',
}
const kindCount = (kind: string, n: number) =>
  `${n} ${n === 1 ? (KIND_ONE[kind] ?? kind) : (KIND_LABEL[kind] ?? kind)}`

type Line = DailyPayload['activity'][number]

/**
 * What everyone did on the day, with how many actions of each kind and by whom on top, then hour by
 * hour: each hour closed until opened, on its own or all at once. This browser remembers which hours
 * of a day were open. On the all-projects page each line names its project.
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
  const [open, setOpen] = useOpenHours(projectId ?? 'all', date)
  if (!activity) return null
  if (!activity.length) return <Empty>Nothing happened on {date}.</Empty>

  const hours = new Map<string, Line[]>()
  for (const a of activity) {
    const h = `${String(new Date(a.createdAt).getHours()).padStart(2, '0')}:00`
    hours.set(h, [...(hours.get(h) ?? []), a])
  }
  const kinds = new Map<string, number>()
  for (const a of activity) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
  const actors = new Set(activity.map((a) => a.actor))
  const shown = open.filter((h) => hours.has(h))

  return (
    <section className="space-y-3" aria-label="Activity">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {activity.length} {activity.length === 1 ? 'action' : 'actions'}
        </span>
        {[...kinds].map(([k, n]) => (
          <span key={k} className="rounded bg-muted px-1.5 py-0.5">
            {kindCount(k, n)}
          </span>
        ))}
        <Popover>
          <PopoverTrigger
            render={
              <button type="button" className="underline-offset-4 hover:text-foreground hover:underline" />
            }
          >
            by {actors.size} contributor{actors.size === 1 ? '' : 's'}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 text-xs">
            <p className="mb-2 font-medium">Contributors</p>
            <ul className="space-y-1">
              {[...actors]
                .sort((a, b) => a.localeCompare(b))
                .map((a) => (
                  <li key={a} className="break-words">
                    {a}
                  </li>
                ))}
            </ul>
          </PopoverContent>
        </Popover>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={shown.length === hours.size}
            onClick={() => setOpen([...hours.keys()])}
          >
            Open all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!shown.length}
            onClick={() => setOpen([])}
          >
            Close all
          </Button>
        </div>
      </div>

      <Accordion
        multiple
        value={shown}
        onValueChange={(value) => setOpen(value as string[])}
        className="rounded-lg border px-3"
      >
        {[...hours].map(([hour, items]) => (
          <AccordionItem key={hour} value={hour}>
            <AccordionTrigger>
              <span className="font-mono text-xs">{hour}</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {items.length} {items.length === 1 ? 'action' : 'actions'}
              </span>
              <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                by {[...new Set(items.map((a) => a.actor))].join(', ')}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1 border-l pl-3">
                {items.map((a) => (
                  <ActivityLine key={a.id} line={a} withProject={!projectId} />
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  )
}

function ActivityLine({ line: a, withProject }: { line: Line; withProject: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="font-mono text-[11px] text-muted-foreground">{clock(a.createdAt)}</span>
      <Actor name={a.actor} />
      {withProject && a.project && <span className="text-xs text-muted-foreground">[{a.project}]</span>}
      {/* A long word (a URL, a path) breaks anywhere rather than widen the page on a phone. */}
      {a.refType === 'review' && a.refId ? (
        <ReviewResultButton
          resultId={a.refId}
          className="min-w-0 text-left wrap-anywhere hover:underline"
          tip="Open the review result"
        >
          {a.text}
        </ReviewResultButton>
      ) : a.refType === 'report-settings-change' && a.refId ? (
        <SettingsChangeDiff changeId={a.refId}>{a.text}</SettingsChangeDiff>
      ) : a.refType === 'instruction-change' && a.projectId ? (
        // The change in the project's instructions history, with its diff.
        <Link
          to="/projects/$id/settings"
          params={{ id: String(a.projectId) }}
          hash="instructions-history"
          className="min-w-0 wrap-anywhere hover:underline"
        >
          {a.text}
        </Link>
      ) : (
        <span className="min-w-0 wrap-anywhere">{a.text}</span>
      )}
    </li>
  )
}

// The hours left open on each day, per page (a project's, or every project's), for the last days opened.
const DAYS_KEPT = 14
const storageKey = (scope: number | 'all') => `daily-open-hours:${scope}`

function readOpen(scope: number | 'all'): Record<string, string[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(
      Object.entries(saved).flatMap(([day, hours]) =>
        Array.isArray(hours) ? [[day, hours.filter((h): h is string => typeof h === 'string')]] : [],
      ),
    )
  } catch {
    // Unavailable or unreadable: every hour starts closed.
    return {}
  }
}

function saveOpen(scope: number | 'all', date: string, hours: string[]) {
  // The day just changed goes last, so the oldest are the ones dropped.
  const { [date]: _old, ...rest } = readOpen(scope)
  const days = hours.length ? { ...rest, [date]: hours } : rest
  remember(storageKey(scope), JSON.stringify(Object.fromEntries(Object.entries(days).slice(-DAYS_KEPT))))
}

/**
 * The hours open on the page's day, all closed until opened. Storage is read only after mount: the
 * server has none, and the browser's first render must agree with the server's.
 */
function useOpenHours(scope: number | 'all', date: string) {
  const [state, setState] = useState<{ date: string; hours: string[] }>({ date, hours: [] })
  useEffect(() => {
    setState({ date, hours: readOpen(scope)[date] ?? [] })
  }, [scope, date])
  const change = (hours: string[]) => {
    setState({ date, hours })
    saveOpen(scope, date, hours)
  }
  return [state.date === date ? state.hours : [], change] as const
}
