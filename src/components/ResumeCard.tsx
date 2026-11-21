import { useMutation, useQuery } from '@tanstack/react-query'
import { Play, RotateCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, post, type TicketFull, type TicketResume, type TicketResumeRow } from '#/lib/api'
import { ago, stamp } from '#/lib/format'

/**
 * The ticket's Resume card: what the board did to continue the ticket's work after the human's answer or
 * move (src/server/resume.ts): the state, when, the command's name, why it was skipped or failed, the
 * log's last lines, and Retry. Left out while resuming is off and nothing was ever tried.
 */

const STATE: Record<TicketResumeRow['state'], { label: string; className: string }> = {
  queued: { label: 'Starting', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400' },
  running: { label: 'Running', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  succeeded: { label: 'Finished', className: 'bg-muted text-muted-foreground' },
  failed: { label: 'Failed', className: 'bg-destructive/10 text-destructive' },
  skipped: { label: 'Not started', className: 'bg-muted text-muted-foreground' },
}

export function useTicketResume(t: TicketFull | undefined) {
  const { data, refetch } = useQuery({
    queryKey: ['ticket-resume', t?.id],
    queryFn: () => get<TicketResume>(`/api/tickets/${t!.id}/resume`),
    enabled: !!t,
    refetchInterval: (q) => {
      const state = q.state.data?.current?.state
      return state === 'running' || state === 'queued' ? 3_000 : 30_000
    },
  })
  return { data, refetch, shown: !!data && (data.enabled || data.current !== null) }
}

export function ResumeCard({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const { data, refetch } = useTicketResume(t)
  const retry = useMutation({
    mutationFn: () => post<TicketResumeRow>(`/api/tickets/${t.id}/resume`),
    onSuccess: () => {
      void refetch()
      onChange()
      toast.success('The board started the work again')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!data) return null
  const row = data.current
  const running = row?.state === 'running' || row?.state === 'queued'
  const state = row ? STATE[row.state] : null
  return (
    <section className="rounded-lg border p-3" aria-label="Resume">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Resume</h2>
        {data.enabled && (
          <Button
            className="ml-auto"
            variant="outline"
            size="sm"
            disabled={retry.isPending || running}
            onClick={() => retry.mutate()}
          >
            {row?.state === 'failed' ? <RotateCw /> : <Play />}
            {row?.state === 'failed' ? 'Retry' : 'Resume'}
          </Button>
        )}
      </div>
      {!row && <p className="text-xs text-muted-foreground">Nothing has resumed this ticket yet.</p>}
      {row && state && (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 font-medium ${state.className}`}>{state.label}</span>
            {row.command && <span className="font-mono">{row.command}</span>}
            <Tip content={stamp(row.startedAt ?? row.createdAt)}>
              <span className="text-muted-foreground">{ago(row.startedAt ?? row.createdAt)}</span>
            </Tip>
          </div>
          {row.state === 'skipped' && (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">
              {row.reason}
              {!data.enabled && ' The human sets it in the project’s settings.'}
            </p>
          )}
          {row.state === 'failed' && (
            <p className="text-destructive [overflow-wrap:anywhere]">
              The board could not resume: {row.reason}
            </p>
          )}
          {row.state === 'succeeded' && row.reason && (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{row.reason}</p>
          )}
          {row.tail.length > 0 && (
            <pre
              className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug"
              aria-label="Log"
            >
              {row.tail.join('\n')}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
