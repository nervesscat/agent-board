import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { AnalogClock } from '#/components/AnalogClock'
import { NotifyMe } from '#/components/ReportDueBanner'
import { refreshReports } from '#/components/daily/refresh'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { errorMessage, patch, type ReportSettingsView } from '#/lib/api'
import type { ReportCadence } from '#/lib/constants'
import { weekdayName, weekdayShort } from '#/lib/reports'

const DAYS = [1, 2, 3, 4, 5, 6, 7]

/**
 * When the report is due: how often (a weekly one on which day), the shift whose end it is due at,
 * the days a daily one is asked for, and how long before the end the board starts reminding. Kept on
 * Save.
 */
export function ShiftSettings({ projectId, settings }: { projectId: number; settings: ReportSettingsView }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const CADENCES: Record<ReportCadence, string> = {
    off: t('shift.cadence.off'),
    daily: t('shift.cadence.daily'),
    weekly: t('shift.cadence.weekly'),
  }
  const WEEKDAY_ITEMS = Object.fromEntries(DAYS.map((d) => [String(d), weekdayName(d, t)]))
  const [cadence, setCadence] = useState<ReportCadence>(settings.cadence)
  const [weekday, setWeekday] = useState(String(settings.weekday))
  const [shiftStart, setShiftStart] = useState(settings.shiftStart)
  const [shiftEnd, setShiftEnd] = useState(settings.shiftEnd)
  const [workdays, setWorkdays] = useState(settings.workdays)
  const [alert, setAlert] = useState(String(settings.alertMinutes))

  const next = {
    cadence,
    weekday: Number(weekday),
    shiftStart,
    shiftEnd,
    workdays: [...workdays].sort((a, b) => a - b),
    alertMinutes: Number(alert),
  }
  const badAlert = !/^\d+$/.test(alert) || next.alertMinutes > 720
  const problem =
    shiftEnd <= shiftStart
      ? t('shift.badOrder')
      : !workdays.length
        ? t('shift.noWorkday')
        : badAlert
          ? t('shift.badAlert')
          : null
  const changed =
    next.cadence !== settings.cadence ||
    next.weekday !== settings.weekday ||
    next.shiftStart !== settings.shiftStart ||
    next.shiftEnd !== settings.shiftEnd ||
    next.workdays.join() !== settings.workdays.join() ||
    next.alertMinutes !== settings.alertMinutes
  const save = useMutation({
    mutationFn: () => patch(`/api/projects/${projectId}/report-settings`, next),
    onSuccess: () => refreshReports(qc, projectId),
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <div role="group" aria-label={t('shift.schedule')} className="space-y-4">
      <h3 className="text-sm font-medium">{t('shift.schedule')}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="report-cadence" className="text-xs">
            {t('shift.due')}
          </Label>
          <Select value={cadence} onValueChange={(v) => setCadence(v as ReportCadence)} items={CADENCES}>
            <SelectTrigger id="report-cadence" size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CADENCES).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {cadence === 'weekly' && (
          <div className="space-y-1">
            <Label htmlFor="report-weekday" className="text-xs">
              {t('shift.weekdayLabel')}
            </Label>
            <Select value={weekday} onValueChange={(v) => setWeekday(v as string)} items={WEEKDAY_ITEMS}>
              <SelectTrigger id="report-weekday" size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WEEKDAY_ITEMS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {cadence === 'weekly' ? t('shift.hintWeekly') : t('shift.hintDaily')}
        </p>
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <AnalogClock label={t('shift.start')} value={shiftStart} onChange={setShiftStart} />
          <AnalogClock label={t('shift.end')} value={shiftEnd} onChange={setShiftEnd} />
        </div>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">{t('shift.workdays')}</legend>
        <p className="text-xs text-muted-foreground">{t('shift.workdaysHint')}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {DAYS.map((day) => {
            const name = weekdayName(day, t)
            return (
              <label key={day} className="flex min-h-7 items-center gap-1.5 text-sm">
                <Checkbox
                  aria-label={name}
                  checked={workdays.includes(day)}
                  onCheckedChange={(on) =>
                    setWorkdays(on ? [...workdays, day] : workdays.filter((d) => d !== day))
                  }
                />
                <span aria-hidden>{weekdayShort(day, t)}</span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="report-alert-minutes" className="text-xs">
            {t('shift.remind')}
          </Label>
          <Input
            id="report-alert-minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            step={5}
            value={alert}
            aria-invalid={badAlert || undefined}
            onChange={(e) => setAlert(e.target.value)}
            className="w-24"
          />
        </div>
        <NotifyMe />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {problem && (
          <p role="alert" className="mr-auto text-xs text-destructive">
            {problem}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!changed || Boolean(problem) || save.isPending}
        >
          {save.isPending ? t('shift.saving') : t('shift.save')}
        </Button>
      </div>
    </div>
  )
}
