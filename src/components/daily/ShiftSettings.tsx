import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { refreshReports } from '#/components/daily/refresh'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { errorMessage, patch, type ReportSettingsView } from '#/lib/api'
import type { ReportCadence } from '#/lib/constants'
import { WEEKDAYS } from '#/lib/reports'

const CADENCES: Record<ReportCadence, string> = { off: 'Off', daily: 'Daily', weekly: 'Weekly' }
const WEEKDAY_ITEMS = Object.fromEntries(WEEKDAYS.map((d, i) => [String(i + 1), d]))

/** When the report is due: how often, and for a weekly one on which day. Kept on Save. */
export function ShiftSettings({ projectId, settings }: { projectId: number; settings: ReportSettingsView }) {
  const qc = useQueryClient()
  const [cadence, setCadence] = useState<ReportCadence>(settings.cadence)
  const [weekday, setWeekday] = useState(String(settings.weekday))
  const changed = cadence !== settings.cadence || Number(weekday) !== settings.weekday
  const save = useMutation({
    mutationFn: () =>
      patch(`/api/projects/${projectId}/report-settings`, { cadence, weekday: Number(weekday) }),
    onSuccess: () => refreshReports(qc, projectId),
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <div role="group" aria-label="Schedule" className="space-y-2">
      <h3 className="text-sm font-medium">Schedule</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="report-cadence" className="text-xs">
            Due
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
              On
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
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => save.mutate()}
          disabled={!changed || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
