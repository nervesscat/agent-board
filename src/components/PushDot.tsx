import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { errorMessage, get, post, type ProjectPush, type Push } from '#/lib/api'
import { ago } from '#/lib/format'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const DOT: Record<Push['state'], string> = {
  pushed: 'bg-emerald-500',
  ahead: 'bg-red-500',
  'local-only': 'bg-red-500',
  'remote-only': 'bg-sky-500',
  none: 'bg-muted-foreground/40',
}

/** Not pushed: red on the board. */
export const isUnpushed = (p: Push | undefined) => p?.state === 'ahead' || p?.state === 'local-only'

/** A short label and the sentence behind it, for a branch's push state. */
export function pushText(p: Push): { label: string; title: string } {
  switch (p.state) {
    case 'pushed':
      return p.behind
        ? {
            label: `pushed, behind ${p.behind}`,
            title: `pushed; origin has ${plural(p.behind, 'commit')} more`,
          }
        : { label: 'pushed', title: 'pushed' }
    case 'ahead':
      return {
        label: `${p.ahead} not pushed`,
        title: `not pushed: ${plural(p.ahead, 'commit')} only here${p.behind ? `; origin also has ${p.behind} this branch lacks` : ''}`,
      }
    case 'local-only':
      return {
        label: 'not on origin',
        title: `not pushed: no such branch on origin${p.ahead ? `, ${plural(p.ahead, 'commit')} only here` : ''}`,
      }
    case 'remote-only':
      return { label: 'only on origin', title: 'only on origin: no local branch' }
    case 'none':
      return { label: 'not found', title: 'no such branch here or on origin' }
  }
}

/** When origin was last fetched into the checkout. */
export const checkedText = (p: Pick<Push, 'checkedAt'>) =>
  p.checkedAt ? `checked ${ago(p.checkedAt)}` : 'origin not fetched yet'

/** A red or green dot for whether a branch is on origin, the details in its tooltip. */
export function PushDot({ push, className }: { push: Push; className?: string }) {
  const title = `${pushText(push).title}\n${checkedText(push)}`
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[push.state], className)}
    />
  )
}

/** The dot with its label and when origin was last fetched, for the ticket page. */
export function PushBadge({ push, className }: { push: Push; className?: string }) {
  const { label, title } = pushText(push)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)} title={title}>
      <PushDot push={push} />
      <span className={isUnpushed(push) ? 'font-medium text-red-700 dark:text-red-400' : ''}>{label}</span>
      <span className="truncate text-muted-foreground">· {checkedText(push)}</span>
    </span>
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
      title="Fetch origin now"
      aria-label="Fetch origin now"
    >
      <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} />
    </Button>
  )
}
