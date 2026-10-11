import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { formatTime, useHour12 } from '#/components/AnalogClock'
import { get, type ReportSettingsView } from '#/lib/api'
import { localDate } from '#/lib/format'
import { isWorkday } from '#/lib/reports'
import { cn } from '#/lib/utils'

/**
 * Today's shift of the project as a small read-only dial of the whole day (midnight at the top): the
 * shift is the arc from its start to its end, and now is the hand. Only while reports are tracked.
 */
export function ShiftClock({ projectId }: { projectId: number }) {
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettingsView>(`/api/projects/${projectId}/report-settings`),
  })
  const hour12 = useHour12()
  const now = useMinuteClock()
  if (!settings || settings.cadence === 'off' || !now) return null

  const start = minutesOf(settings.shiftStart)
  const end = minutesOf(settings.shiftEnd)
  const current = now.getHours() * 60 + now.getMinutes()
  const working = isWorkday(settings, localDate(now))
  const where = !working
    ? 'not a workday'
    : current < start
      ? 'before the shift'
      : current < end
        ? 'on shift'
        : 'after the shift'
  const span = `${formatTime(start, hour12)}–${formatTime(end, hour12)}`
  const [nx, ny] = at(current, 15)

  return (
    <div
      role="img"
      aria-label={`Shift ${span}, now ${formatTime(current, hour12)}: ${where}`}
      title={`Today's shift ${span}; now ${formatTime(current, hour12)}, ${where}. The report is due at its end.`}
      className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
    >
      <svg viewBox="0 0 40 40" className="size-7 shrink-0" aria-hidden>
        <circle cx={20} cy={20} r={15} fill="none" strokeWidth={4} className="stroke-muted" />
        <path
          data-part="shift"
          d={arc(start, end, 15)}
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          className={working ? 'stroke-emerald-500' : 'stroke-muted-foreground/40'}
        />
        <line
          data-part="now"
          x1={20}
          y1={20}
          x2={nx}
          y2={ny}
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-foreground"
        />
        <circle cx={20} cy={20} r={2} className="fill-foreground" />
      </svg>
      <span className={cn('tabular-nums', where === 'on shift' && 'text-foreground')}>{span}</span>
    </div>
  )
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** A point on the day's dial, `minutes` after midnight, `r` from the centre. */
function at(minutes: number, r: number): [number, number] {
  const rad = (minutes / (24 * 60)) * 2 * Math.PI
  return [20 + r * Math.sin(rad), 20 - r * Math.cos(rad)]
}

function arc(from: number, to: number, r: number) {
  const [x1, y1] = at(from, r)
  const [x2, y2] = at(to, r)
  const large = to - from > 12 * 60 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

/** The time now, from the first render in the browser on (none on the server), again each minute. */
function useMinuteClock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}
