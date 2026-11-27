import { useMutation, useQuery } from '@tanstack/react-query'
import { Play, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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

const STATE = {
  queued: { label: 'resumeCard.state.queued', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400' },
  running: {
    label: 'resumeCard.state.running',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  succeeded: { label: 'resumeCard.state.succeeded', className: 'bg-muted text-muted-foreground' },
  failed: { label: 'resumeCard.state.failed', className: 'bg-destructive/10 text-destructive' },
  skipped: { label: 'resumeCard.state.skipped', className: 'bg-muted text-muted-foreground' },
} as const satisfies Record<TicketResumeRow['state'], { label: string; className: string }>

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
  const { t: tr } = useTranslation()
  const { data, refetch } = useTicketResume(t)
  const { data: templates } = useQuery({
    queryKey: ['resume-templates'],
    queryFn: () => get<{ id: string; name: string; effortPassed: boolean }[]>('/api/resume/templates'),
  })
  const retry = useMutation({
    mutationFn: () => post<TicketResumeRow>(`/api/tickets/${t.id}/resume`),
    onSuccess: () => {
      void refetch()
      onChange()
      toast.success(tr('resumeCard.started'))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!data) return null
  const row = data.current
  const running = row?.state === 'running' || row?.state === 'queued'
  const state = row ? STATE[row.state] : null
  const template = row?.template ? templates?.find((x) => x.id === row.template) : undefined
  return (
    <section className="rounded-lg border p-3" aria-label={tr('resumeCard.title')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{tr('resumeCard.title')}</h2>
        {data.enabled && (
          <Button
            className="ml-auto"
            variant="outline"
            size="sm"
            disabled={retry.isPending || running}
            onClick={() => retry.mutate()}
          >
            {row?.state === 'failed' ? <RotateCw /> : <Play />}
            {row?.state === 'failed' ? tr('resumeCard.retry') : tr('resumeCard.resume')}
          </Button>
        )}
      </div>
      {!row && <p className="text-xs text-muted-foreground">{tr('resumeCard.empty')}</p>}
      {row && state && (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 font-medium ${state.className}`}>
              {tr(state.label)}
            </span>
            {row.command && <span className="font-mono">{row.command}</span>}
            <Tip content={stamp(row.startedAt ?? row.createdAt)}>
              <span className="text-muted-foreground">{ago(row.startedAt ?? row.createdAt)}</span>
            </Tip>
          </div>
          {row.template && (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">
              {tr('resumeCard.template', { name: template?.name ?? row.template })}
              {row.model && ` · ${tr('resumeCard.chosen', { model: row.model, effort: row.effort })}`}
              {row.choice === 'run' && ` · ${tr('resumeCard.whyRun')}`}
              {row.choice === 'complexity' && ` · ${tr('resumeCard.whyComplexity')}`}
              {row.choice === 'unrecorded' && ` · ${tr('resumeCard.whyUnrecorded')}`}
              {template && !template.effortPassed && ` · ${tr('resumeCard.noEffort')}`}
            </p>
          )}
          {row.state === 'skipped' && (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">
              {row.reason}
              {!data.enabled && ` ${tr('resumeCard.setInSettings')}`}
            </p>
          )}
          {row.state === 'failed' && (
            <p className="text-destructive [overflow-wrap:anywhere]">
              {tr('resumeCard.failed', { reason: row.reason })}
            </p>
          )}
          {row.state === 'succeeded' && row.reason && (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{row.reason}</p>
          )}
          {row.tail.length > 0 && (
            <pre
              className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug"
              aria-label={tr('resumeCard.log')}
            >
              {row.tail.join('\n')}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
