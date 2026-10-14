import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { ChangeDiff } from '#/components/daily/SettingsChangeDiff'
import { refreshReports } from '#/components/daily/refresh'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, post, type ReportSettingsView } from '#/lib/api'
import { ago, stamp } from '#/lib/format'

/**
 * An agent's change of the project's report prompt or template, waiting on the human: "changed by
 * <agent>, revert?", with Accept and Revert.
 */
export function SettingsChangeNotice({ projectId }: { projectId: number }) {
  const { data: settings } = useQuery({
    queryKey: ['report-settings', projectId],
    queryFn: () => get<ReportSettingsView>(`/api/projects/${projectId}/report-settings`),
    // An agent may change them at any time; the notice shows up without a reload.
    refetchInterval: 30_000,
  })
  if (!settings?.pending.length) return null

  return (
    <section aria-label="Changes by agents to review" className="space-y-2">
      {settings.pending.map((change) => (
        <Notice key={change.id} projectId={projectId} change={change} />
      ))}
    </section>
  )
}

function Notice({ projectId, change }: { projectId: number; change: ReportSettingsView['pending'][number] }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const settle = useMutation({
    mutationFn: (action: 'accept' | 'revert') => post(`/api/report-settings/changes/${change.id}/${action}`),
    onSuccess: (_, action) => {
      toast.success(
        action === 'accept' ? `Kept the new report ${change.field}` : `Reverted the report ${change.field}`,
      )
      void qc.invalidateQueries({ queryKey: ['report-settings-change', change.id] })
      refreshReports(qc, projectId)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  // The server says whether a later change of the field stands: that one is reverted first.
  const later = !change.revertable

  return (
    <article
      aria-label={`The report ${change.field} changed by ${change.changedBy}`}
      className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TriangleAlert className="size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
        <p className="min-w-0 flex-1 basis-48">
          The report {change.field} was changed by <span className="font-medium">{change.changedBy}</span>,
          revert?{' '}
          <Tip content={stamp(change.createdAt)}>
            <span className="text-xs text-muted-foreground">{ago(change.createdAt)}</span>
          </Tip>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide the change' : 'Show the change'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={settle.isPending}
            onClick={() => settle.mutate('accept')}
          >
            Accept
          </Button>
          <Tip
            content={later ? `The ${change.field} changed again since: revert that change first` : undefined}
          >
            <span className="inline-flex">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={settle.isPending || later}
                onClick={() => settle.mutate('revert')}
              >
                Revert
              </Button>
            </span>
          </Tip>
        </div>
      </div>
      {open && <ChangeDiff change={change} className="mt-3 bg-background" />}
    </article>
  )
}
