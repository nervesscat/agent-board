import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { ReportPromptSettings } from '#/components/daily/ReportPromptSettings'
import { ShiftSettings } from '#/components/daily/ShiftSettings'
import { get, type ReportSettingsView } from '#/lib/api'
import { describeSchedule } from '#/lib/reports'

/**
 * How the project's reports are made, folded away until opened: what they must say (the prompt and the
 * template) and when they are due (the cadence and the shift). Each part saves on its own.
 */
export function ReportSettingsPanel({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false)
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettingsView>(`/api/projects/${projectId}/report-settings`),
  })
  if (!settings) return null

  return (
    <section className="rounded-lg border" aria-label="Report settings">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-4 py-3 text-left hover:bg-muted/30"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">Report settings</span>
        <span className="text-xs text-muted-foreground">{describeSchedule(settings)}</span>
      </button>
      {open && (
        <div className="space-y-6 border-t p-4">
          <ReportPromptSettings projectId={projectId} settings={settings} />
          <ShiftSettings projectId={projectId} settings={settings} />
        </div>
      )}
    </section>
  )
}
