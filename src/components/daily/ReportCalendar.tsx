import { useQuery } from '@tanstack/react-query'

import { REPORT_STATUS } from '#/components/daily/status'
import { get, type ReportList, type ReportSettingsView } from '#/lib/api'
import type { ReportCadence } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { periodOf } from '#/lib/reports'
import { cn } from '#/lib/utils'

/**
 * Which periods are reported: the recent ones up to the day on show, green when reported, red when due
 * without a report, grey until due. A period opens that day on the page (`onDate`).
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
  const { data: list } = useQuery({
    queryKey: ['reports', projectId, date],
    queryFn: () => get<ReportList>(`/api/projects/${projectId}/reports?to=${date}`),
    enabled: tracked,
    refetchInterval: 60_000,
  })
  if (!settings || settings.cadence === 'off') return null
  const periods = list?.periods ?? []
  const open = periodOf(settings.cadence, date)
  const counts = { done: 0, missing: 0, upcoming: 0, off: 0 }
  for (const p of periods) counts[p.status]++

  return (
    <section className="min-w-0 rounded-lg border p-4" aria-label="Report calendar">
      {/* Oldest on the left, so the strip reads like a calendar. */}
      <ol className="flex flex-wrap items-end gap-1" aria-label="Report periods">
        {[...periods].reverse().map((p) => (
          <li key={p.period}>
            <button
              type="button"
              onClick={() => onDate(p.period)}
              title={`${p.label}: ${REPORT_STATUS[p.status].label}, due ${stamp(p.due)}`}
              aria-label={`${p.label}: ${REPORT_STATUS[p.status].label}`}
              aria-current={open === p.period}
              className={cn(
                'flex min-w-8 flex-col items-center gap-1 rounded-md px-1 py-1 text-[10px] text-muted-foreground hover:bg-muted',
                open === p.period && 'bg-muted font-medium text-foreground',
              )}
            >
              <span className={cn('h-4 w-6 rounded-sm', REPORT_STATUS[p.status].dot)} />
              {shortLabel(settings.cadence, p.period)}
            </button>
          </li>
        ))}
      </ol>
      {periods.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {counts.done} done · {counts.missing} missing
        </p>
      )}
      {list && !periods.length && (
        <p className="text-sm text-muted-foreground">No periods to show up to {date}.</p>
      )}
    </section>
  )
}

/** "4" for a day, "Sep 28" for a week. */
function shortLabel(cadence: ReportCadence, period: string) {
  const d = new Date(`${period}T00:00:00`)
  return cadence === 'weekly'
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : String(d.getDate())
}
