import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { ChangeDiff } from '#/components/daily/SettingsChangeDiff'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import {
  errorMessage,
  get,
  type Me,
  post,
  type ProjectInstructionChange,
  type RevertedInstructions,
} from '#/lib/api'
import { ago, stamp } from '#/lib/format'

/** A change of the project's instructions, with whether the human can revert it now. */
export type InstructionChangeRow = ProjectInstructionChange & { revertable: boolean }

export const instructionChangesKey = (projectId: number | string) => [
  'instruction-changes',
  String(projectId),
]

/**
 * Reviewed and Revert, the human's two answers to a change of the project's instructions: either one
 * refreshes the history, the project (its instructions) and Needs you.
 */
export function useSettleInstructions(projectId: number | string) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'review' | 'revert' }) =>
      post<RevertedInstructions | ProjectInstructionChange>(`/api/instructions/changes/${id}/${action}`),
    onSuccess: (_, { action }) => {
      toast.success(action === 'review' ? t('instructions.markedReviewed') : t('instructions.reverted'))
      void qc.invalidateQueries({ queryKey: instructionChangesKey(projectId) })
      void qc.invalidateQueries({ queryKey: ['project', String(projectId)] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['summary'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

/**
 * Every change of the project's instructions, newest first: who made it (with their role), when, its
 * state and the diff, old against new. The human reviews an orchestrator's change or reverts any change
 * whose text still stands (a later one is reverted first).
 */
export function InstructionsHistory({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  const { data, error } = useQuery({
    queryKey: instructionChangesKey(projectId),
    queryFn: () => get<InstructionChangeRow[]>(`/api/projects/${projectId}/instructions/changes`),
    // An orchestrator may change them at any time.
    refetchInterval: 30_000,
  })
  const settle = useSettleInstructions(projectId)
  const human = me ? !me.agent : false
  return (
    <section id="instructions-history" aria-label={t('instructions.historyTitle')} className="space-y-2">
      <h2 className="text-sm font-medium">{t('instructions.historyTitle')}</h2>
      <p className="text-xs text-muted-foreground">{t('instructions.historyDescription')}</p>
      {error && <p className="text-xs text-destructive">{errorMessage(error)}</p>}
      {data?.length === 0 && <p className="text-xs text-muted-foreground">{t('instructions.noChanges')}</p>}
      {!!data?.length && (
        <ol className="space-y-3">
          {data.map((c, i) => (
            <Entry
              key={c.id}
              change={c}
              open={i === 0 || c.state === 'pending'}
              human={human}
              busy={settle.isPending}
              onSettle={(action) => settle.mutate({ id: c.id, action })}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

function Entry({
  change,
  open: openAtFirst,
  human,
  busy,
  onSettle,
}: {
  change: InstructionChangeRow
  open: boolean
  human: boolean
  busy: boolean
  onSettle: (action: 'review' | 'revert') => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(openAtFirst)
  const reverted = change.state === 'reverted'
  return (
    <li
      aria-label={t('instructions.changeBy', { name: change.changedBy })}
      className="space-y-2 rounded-md border p-3 text-sm"
      data-state={change.state}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Actor name={change.changedBy} />
        <Tip content={stamp(change.createdAt)}>
          <span className="text-xs text-muted-foreground">{ago(change.createdAt)}</span>
        </Tip>
        <Badge variant={change.state === 'pending' ? 'default' : 'secondary'}>
          {t(`instructions.state.${change.state}`)}
        </Badge>
        {change.revertOf !== null && (
          <span className="text-xs text-muted-foreground">{t('instructions.aRevert')}</span>
        )}
        {change.resolvedBy && change.resolvedAt && (
          <span className="text-xs text-muted-foreground">
            {t(reverted ? 'instructions.revertedBy' : 'instructions.reviewedBy', {
              name: change.resolvedBy,
              when: ago(change.resolvedAt),
            })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('instructions.hideChange') : t('instructions.showChange')}
          </Button>
          {human && change.state === 'pending' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onSettle('review')}
            >
              {t('instructions.reviewed')}
            </Button>
          )}
          {human && !reverted && (
            <Tip content={change.revertable ? t('instructions.revertTip') : t('instructions.revertBlocked')}>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy || !change.revertable}
                  onClick={() => onSettle('revert')}
                >
                  {t('instructions.revert')}
                </Button>
              </span>
            </Tip>
          )}
        </div>
      </div>
      {open && <ChangeDiff change={change} label={t('instructions.diffLabel')} />}
    </li>
  )
}
