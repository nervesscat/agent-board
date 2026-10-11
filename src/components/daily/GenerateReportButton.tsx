import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { refreshReports } from '#/components/daily/refresh'
import { Button } from '#/components/ui/button'
import { errorMessage, post, type ReportList, type ReportView } from '#/lib/api'

/**
 * Asks claude for the report of `period` (from the prompt, the template and the period's activity),
 * stored as a new version. `period` is null while the project has no period to report (cadence off);
 * `list` is the card's report list, with `generating` and `generateError`. The run is the server's: a
 * page that comes back while it lasts shows it busy, and why the last one failed shows here until one
 * succeeds.
 */
export function GenerateReportButton({
  projectId,
  period,
  list,
}: {
  projectId: number
  period: string | null
  list: ReportList | undefined
}) {
  const qc = useQueryClient()
  const generate = useMutation({
    mutationFn: () => post<ReportView>(`/api/projects/${projectId}/reports/generate`, { period }),
    // The project's report lists say it is being written from now on, before the server is asked: a
    // read racing the request would say it is not, and a page left and come back to would show that.
    // While a list says so, the card reads it closely, and so learns when the report lands.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['reports', projectId] })
      qc.setQueriesData<ReportList | ReportView[]>({ queryKey: ['reports', projectId] }, (old) =>
        old && !Array.isArray(old) ? { ...old, generating: period, generateError: null } : old,
      )
    },
    onSuccess: () => toast.success('claude wrote the report'),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => refreshReports(qc, projectId),
  })

  const busy = generate.isPending || Boolean(list?.generating)
  const why = !list
    ? 'Loading…'
    : list.cadence === 'off'
      ? 'Reports are off: set a cadence in the report settings first'
      : list.format === 'file'
        ? "This project's reports are files: claude only writes text reports"
        : !period
          ? 'No report is asked for on this day'
          : null
  const failed =
    !busy && list?.generateError && list.generateError.period === period ? list.generateError : null

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      {/* The reason is on the wrapper: a disabled button takes no pointer, so shows no title. */}
      <span title={why ?? 'claude writes the report from the prompt, the template and the activity'}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={busy || Boolean(why)}
          aria-description={why ?? undefined}
          onClick={() => generate.mutate()}
        >
          {busy ? (
            <>
              <LoaderCircle data-icon="inline-start" className="animate-spin" /> claude is writing…
            </>
          ) : (
            <>
              <Sparkles data-icon="inline-start" /> Generate with claude
            </>
          )}
        </Button>
      </span>
      {failed && (
        <p role="alert" className="max-w-full text-right sm:max-w-80 text-xs wrap-anywhere text-destructive">
          claude could not write it: {failed.message}
        </p>
      )}
    </div>
  )
}
