import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import type { TFunction } from 'i18next'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { shared } from '#/i18n'
import { errorMessage, get, post, type ProjectPush, type Push } from '#/lib/api'
import { ago } from '#/lib/format'

const DOT: Record<Push['state'], string> = {
  pushed: 'bg-emerald-500',
  ahead: 'bg-red-500',
  'local-only': 'bg-red-500',
  merged: 'bg-emerald-500/50',
  'remote-only': 'bg-sky-500',
  none: 'bg-muted-foreground/40',
}

/** Not pushed: red on the board. A merged branch gone from origin is not one. */
export const isUnpushed = (p: Push | undefined) => p?.state === 'ahead' || p?.state === 'local-only'

/** A short label and the sentence behind it, for a branch's push state. */
export function pushText(p: Push, t: TFunction = shared.t): { label: string; title: string } {
  switch (p.state) {
    case 'pushed':
      return p.behind
        ? {
            label: t('pushDot.pushedBehind', { count: p.behind }),
            title: t('pushDot.pushedBehindTitle', { count: p.behind }),
          }
        : { label: t('pushDot.pushed'), title: t('pushDot.pushed') }
    case 'ahead':
      return {
        label: t('pushDot.ahead', { count: p.ahead }),
        title: p.behind
          ? t('pushDot.aheadBehindTitle', { count: p.ahead, behind: p.behind })
          : t('pushDot.aheadTitle', { count: p.ahead }),
      }
    case 'local-only':
      return {
        label: t('pushDot.localOnly'),
        title: p.ahead ? t('pushDot.localOnlyAheadTitle', { count: p.ahead }) : t('pushDot.localOnlyTitle'),
      }
    case 'merged': {
      const into = p.into ?? t('pushDot.itsBase')
      return {
        label: t('pushDot.merged', { into }),
        title: t('pushDot.mergedTitle', { into }),
      }
    }
    case 'remote-only':
      return { label: t('pushDot.remoteOnly'), title: t('pushDot.remoteOnlyTitle') }
    case 'none':
      return { label: t('pushDot.none'), title: t('pushDot.noneTitle') }
  }
}

/** When origin was last fetched into the checkout. */
export const checkedText = (p: Pick<Push, 'checkedAt'>, t: TFunction = shared.t) =>
  p.checkedAt ? t('pushDot.checked', { ago: ago(p.checkedAt) }) : t('pushDot.notFetched')

/** A red or green dot for whether a branch is on origin, the details in its tooltip. */
export function PushDot({ push, className }: { push: Push; className?: string }) {
  const { t } = useTranslation()
  const title = `${pushText(push, t).title}\n${checkedText(push, t)}`
  return (
    <Tip content={title}>
      <span
        role="img"
        aria-label={title}
        className={cn('inline-block size-2 shrink-0 rounded-full', DOT[push.state], className)}
      />
    </Tip>
  )
}

/** The dot with its label and when origin was last fetched, for the ticket page. */
export function PushBadge({ push, className }: { push: Push; className?: string }) {
  const { t } = useTranslation()
  const { label, title } = pushText(push, t)
  return (
    <Tip content={title}>
      <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)}>
        <PushDot push={push} />
        <span className={isUnpushed(push) ? 'font-medium text-red-700 dark:text-red-400' : ''}>{label}</span>
        <span className="truncate text-muted-foreground">· {checkedText(push, t)}</span>
      </span>
    </Tip>
  )
}

/** Every ticket in work with its branch's push state, one request per project. */
export function useProjectPush(projectId: string) {
  return useQuery({
    queryKey: ['push', projectId],
    queryFn: () => get<ProjectPush>(`/api/projects/${projectId}/push`),
    refetchInterval: 60_000,
  })
}

/** Fetches origin into the project's checkouts now, then refreshes what shows push states. */
export function RefreshPush({ projectId, className }: { projectId: string | number; className?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => post<ProjectPush>(`/api/projects/${projectId}/push/refresh`),
    onSuccess: (res) => {
      qc.setQueryData(['push', String(projectId)], res)
      const failed = res.repos.filter((r) => r.error)
      if (failed.length) toast.error(failed.map((r) => `${r.name}: ${r.error}`).join('\n'))
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ticket-git'] })
      qc.invalidateQueries({ queryKey: ['ticket'] })
    },
  })
  return (
    <Tip content={t('pushDot.fetchNow')}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={className}
        disabled={refresh.isPending}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          refresh.mutate()
        }}
        aria-label={t('pushDot.fetchNow')}
      >
        <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} />
      </Button>
    </Tip>
  )
}
