import { useQuery } from '@tanstack/react-query'
import { SkipForward } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import type { DayButton } from 'react-day-picker'

import { REPORT_STATUS } from '#/components/daily/status'
import { Button } from '#/components/ui/button'
import { Calendar, CalendarDayButton } from '#/components/ui/calendar'
import { get, type ReportList, type ReportSettingsView, type ReportStatus } from '#/lib/api'
import { localDate } from '#/lib/format'
import { periodOf } from '#/lib/reports'
import { cn } from '#/lib/utils'

const STATUSES = ['done', 'missing', 'upcoming', 'off'] as const

/**
 * A month of the project's reports: each day (each week, for a weekly report) marked done, missing,
 * upcoming or off (not a workday, or before tracking began). A day opens on the page (`onDate`); the
 * month's missing count, and a jump to the nearest missing period, sit under it.
 */
export function ReportCalendar({
  projectId,
  date,
  onDate,
}: {
  projectId: number
  date: string
  onDate: (date: string) => void
}) {
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettingsView>(`/api/projects/${projectId}/report-settings`),
  })
  const tracked = Boolean(settings && settings.cadence !== 'off')
  // The month on show follows the day on show, and moves on its own with the arrows.
  const [month, setMonth] = useState(() => monthOf(date))
  const [shownDate, setShownDate] = useState(date)
  if (shownDate !== date) {
    setShownDate(date)
    setMonth(monthOf(date))
  }
  const last = lastDay(month)
  const { data: list } = useQuery({
    queryKey: ['reports', projectId, 'month', month],
    queryFn: () => get<ReportList>(`/api/projects/${projectId}/reports?from=${month}&to=${last}`),
    enabled: tracked,
    refetchInterval: 60_000,
  })
  // Every period since tracking began, for the jump to a missing one in any month.
  const today = localDate()
  const since = settings?.since ?? ''
  const { data: all } = useQuery({
    queryKey: ['reports', projectId, 'tracked', since, today],
    queryFn: () =>
      get<ReportList>(`/api/projects/${projectId}/reports?${since ? `from=${since}&` : ''}to=${today}`),
    enabled: tracked,
    refetchInterval: 5 * 60_000,
  })
  if (!settings || settings.cadence === 'off') return null
  const cadence = settings.cadence

  const byPeriod = new Map((list?.periods ?? []).map((p) => [p.period, p.status]))
  // A day the list leaves out came before tracking began: off.
  const statusOf = (d: Date): ReportStatus | null =>
    list ? (byPeriod.get(periodOf(cadence, localDate(d))) ?? 'off') : null
  const counts = { done: 0, missing: 0, upcoming: 0, off: 0 }
  for (const p of list?.periods ?? []) counts[p.status]++

  const open = periodOf(cadence, date)
  const missing = (all?.periods ?? []).filter((p) => p.status === 'missing').map((p) => p.period)
  const nextMissing =
    missing.filter((p) => p > open).sort()[0] ??
    missing
      .filter((p) => p < open)
      .sort()
      .at(-1)

  return (
    <section className="min-w-0 rounded-lg border p-3" aria-label="Report calendar">
      <Calendar
        mode="single"
        required
        selected={new Date(`${date}T00:00:00`)}
        onSelect={(d) => onDate(localDate(d))}
        month={new Date(`${month}T00:00:00`)}
        onMonthChange={(m) => setMonth(monthOf(localDate(m)))}
        weekStartsOn={1}
        showOutsideDays={false}
        // A day still to come has nothing to open.
        disabled={{ after: new Date() }}
        modifiers={{
          ...Object.fromEntries(STATUSES.map((s) => [s, (d: Date) => statusOf(d) === s])),
          open: (d: Date) => cadence === 'weekly' && periodOf(cadence, localDate(d)) === open,
        }}
        labels={{
          labelDayButton: (d) => {
            const s = statusOf(d)
            const day = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
            return s ? `${day}: ${REPORT_STATUS[s].label}` : day
          },
        }}
        components={{ DayButton: StatusDay }}
        className="mx-auto p-0 [--cell-size:--spacing(9)]"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {list ? `${counts.done} done · ${counts.missing} missing` : '…'}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!nextMissing}
          onClick={() => nextMissing && onDate(nextMissing)}
          title={nextMissing ? `Open ${nextMissing}, the nearest missing report` : 'Nothing is missing'}
        >
          <SkipForward data-icon="inline-start" /> Next missing
        </Button>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-hidden>
        {STATUSES.map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span className={cn('size-2 rounded-full', MARK[s])} />
            {REPORT_STATUS[s].label}
          </li>
        ))}
      </ul>
    </section>
  )
}

// A day's mark: a tint behind its number and a dot under it, in the status' colour.
const MARK: Record<ReportStatus, string> = {
  done: REPORT_STATUS.done.dot,
  missing: REPORT_STATUS.missing.dot,
  upcoming: 'bg-muted-foreground/40',
  off: 'border border-muted-foreground/40',
}
const TINT: Record<ReportStatus, string> = {
  done: 'bg-emerald-500/15 dark:bg-emerald-400/15',
  missing: 'bg-rose-500/15 dark:bg-rose-400/20',
  upcoming: '',
  off: 'text-muted-foreground',
}

function StatusDay({ className, children, ...props }: ComponentProps<typeof DayButton>) {
  const s = STATUSES.find((x) => props.modifiers[x])
  return (
    <CalendarDayButton
      {...props}
      className={cn(
        className,
        // The day on show keeps its own colours; its dot still says its status.
        s && !props.modifiers.selected && TINT[s],
        // Hovered (or last tapped, on a touch screen) it stays readable.
        props.modifiers.selected &&
          'hover:bg-primary/90 hover:text-primary-foreground dark:hover:text-primary-foreground',
        props.modifiers.open && 'ring-1 ring-ring/60',
      )}
    >
      {children}
      <i aria-hidden data-status={s} className={cn('size-1.5 rounded-full', s && MARK[s])} />
    </CalendarDayButton>
  )
}

const monthOf = (day: string) => `${day.slice(0, 7)}-01`
/** The month's last day, YYYY-MM-DD. */
function lastDay(first: string) {
  const d = new Date(`${first}T00:00:00`)
  return localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}
