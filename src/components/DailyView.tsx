import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { DatePicker } from '#/components/DatePicker'
import { ActivityLog } from '#/components/daily/ActivityLog'
import { AllProjectsReports } from '#/components/daily/AllProjectsReports'
import { PushedTodayBadge } from '#/components/daily/PushedToday'
import { ReportCalendar } from '#/components/daily/ReportCalendar'
import { ReportCard } from '#/components/daily/ReportCard'
import { ReportSettingsPanel } from '#/components/daily/ReportSettingsPanel'
import { SettingsChangeNotice } from '#/components/daily/SettingsChangeNotice'
import { ShiftClock } from '#/components/daily/ShiftClock'
import { Button } from '#/components/ui/button'
import { get, type DailyPayload } from '#/lib/api'
import { localDate, shiftDate } from '#/lib/format'

/**
 * One day on the board. A project's page puts its report for the period first (with its calendar,
 * its settings and its shift), then what everyone did that day, hour by hour; the all-projects page
 * has every project's report and the whole board's activity.
 */
export function DailyView({ projectId }: { projectId?: number }) {
  const [date, setDate] = useState(localDate())
  const { data } = useQuery({
    queryKey: ['daily', date, projectId ?? 'all'],
    queryFn: () => get<DailyPayload>(`/api/daily?date=${date}${projectId ? `&projectId=${projectId}` : ''}`),
    refetchInterval: 15_000,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daily</h1>
          <p className="text-sm text-muted-foreground">
            {projectId
              ? "The period's report, and what got done hour by hour."
              : "Every project's report, and what got done hour by hour."}
          </p>
        </div>
        {projectId !== undefined && (
          <div className="flex items-center gap-2">
            <PushedTodayBadge projectId={projectId} />
            <ShiftClock projectId={projectId} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous day"
            onClick={() => setDate(shiftDate(date, -1))}
          >
            <ChevronLeft />
          </Button>
          <DatePicker value={date} onChange={setDate} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next day"
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={date >= localDate()}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {projectId !== undefined ? (
        <>
          <SettingsChangeNotice projectId={projectId} />
          {/* The report beside its calendar; stacked on a phone. */}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <ReportCard projectId={projectId} date={date} />
            <ReportCalendar projectId={projectId} date={date} onDate={setDate} />
          </div>
          <ReportSettingsPanel projectId={projectId} />
        </>
      ) : (
        <AllProjectsReports date={date} />
      )}

      <ActivityLog activity={data?.activity} projectId={projectId} date={date} />
    </div>
  )
}
