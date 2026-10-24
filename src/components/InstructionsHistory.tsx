import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

const STATE: Record<ProjectInstructionChange['state'], string> = {
  pending: 'waiting on you',
  accepted: 'reviewed',
  reverted: 'reverted',
}

export const instructionChangesKey = (projectId: number | string) => [
  'instruction-changes',
  String(projectId),
]

/**
 * Reviewed and Revert, the human's two answers to a change of the project's instructions: either one
 * refreshes the history, the project (its instructions) and Needs you.
 */
export function useSettleInstructions(projectId: number | string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'review' | 'revert' }) =>
      post<RevertedInstructions | ProjectInstructionChange>(`/api/instructions/changes/${id}/${action}`),
    onSuccess: (_, { action }) => {
      toast.success(action === 'review' ? 'Marked reviewed' : 'Reverted the project instructions')
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
    <section id="instructions-history" aria-label="Instructions history" className="space-y-2">
      <h2 className="text-sm font-medium">Instructions history</h2>
      <p className="text-xs text-muted-foreground">
        Every change, by you or an orchestrator, with the text before it. An orchestrator&apos;s change
        applies at once and waits on your review.
      </p>
      {error && <p className="text-xs text-destructive">{errorMessage(error)}</p>}
      {data?.length === 0 && <p className="text-xs text-muted-foreground">No changes yet.</p>}
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
  const [open, setOpen] = useState(openAtFirst)
  const reverted = change.state === 'reverted'
  return (
    <li
      aria-label={`Change by ${change.changedBy}`}
      className="space-y-2 rounded-md border p-3 text-sm"
      data-state={change.state}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Actor name={change.changedBy} />
        <Tip content={stamp(change.createdAt)}>
          <span className="text-xs text-muted-foreground">{ago(change.createdAt)}</span>
        </Tip>
        <Badge variant={change.state === 'pending' ? 'default' : 'secondary'}>{STATE[change.state]}</Badge>
        {change.revertOf !== null && <span className="text-xs text-muted-foreground">a revert</span>}
        {change.resolvedBy && change.resolvedAt && (
          <span className="text-xs text-muted-foreground">
            {reverted ? 'reverted' : 'reviewed'} by {change.resolvedBy} {ago(change.resolvedAt)}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide the change' : 'Show the change'}
          </Button>
          {human && change.state === 'pending' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onSettle('review')}
            >
              Reviewed
            </Button>
          )}
          {human && !reverted && (
            <Tip
              content={
                change.revertable
                  ? 'Put the instructions back as they were before this change'
                  : 'The instructions changed again since: revert the later change first'
              }
            >
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy || !change.revertable}
                  onClick={() => onSettle('revert')}
                >
                  Revert
                </Button>
              </span>
            </Tip>
          )}
        </div>
      </div>
      {open && <ChangeDiff change={change} label="What changed in the instructions" />}
    </li>
  )
}
