import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

import { Badge } from '#/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, get, type ReportSettingsChange } from '#/lib/api'
import { lineDiff } from '#/lib/diff'
import { stamp } from '#/lib/format'
import { cn } from '#/lib/utils'

const STATE: Record<ReportSettingsChange['state'], string> = {
  pending: 'waiting on you',
  accepted: 'kept',
  reverted: 'reverted',
}

/** Old against new, line by line: removed lines in red marked −, added ones in green marked +, the rest as is. */
export function ChangeDiff({ change, className }: { change: ReportSettingsChange; className?: string }) {
  const lines = lineDiff(change.oldValue, change.newValue)
  return (
    <div
      role="group"
      aria-label={`What changed in the report ${change.field}`}
      className={cn(
        'max-h-[60vh] overflow-auto rounded-md border bg-muted/20 py-1 font-mono text-xs',
        className,
      )}
    >
      {lines.length === 0 && <p className="px-3 py-1 text-muted-foreground">Both are empty.</p>}
      {lines.map((l, i) =>
        l.op === 'same' ? (
          <div key={i} className="px-3 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            <span aria-hidden className="mr-2 select-none">
              {' '}
            </span>
            {l.text || ' '}
          </div>
        ) : l.op === 'del' ? (
          <del
            key={i}
            className="block bg-rose-500/10 px-3 whitespace-pre-wrap wrap-anywhere text-rose-800 no-underline dark:text-rose-300"
          >
            <span aria-hidden className="mr-2 select-none">
              −
            </span>
            {l.text || ' '}
          </del>
        ) : (
          <ins
            key={i}
            className="block bg-emerald-500/10 px-3 whitespace-pre-wrap wrap-anywhere text-emerald-800 no-underline dark:text-emerald-300"
          >
            <span aria-hidden className="mr-2 select-none">
              +
            </span>
            {l.text || ' '}
          </ins>
        ),
      )}
    </div>
  )
}

/** One change in a dialog, loaded by id; `changeId` null keeps it closed. */
function ChangeDialog({ changeId, onClose }: { changeId: number | null; onClose: () => void }) {
  // Keeps showing the last change while the dialog animates closed.
  const [last, setLast] = useState(changeId)
  if (changeId !== null && changeId !== last) setLast(changeId)
  const shownId = changeId ?? last
  const { data, error } = useQuery({
    queryKey: ['report-settings-change', shownId],
    queryFn: () => get<ReportSettingsChange>(`/api/report-settings/changes/${shownId}`),
    enabled: shownId !== null,
  })
  return (
    <Dialog open={changeId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {data ? `Change of the report ${data.field}` : 'Change of the report settings'}
          </DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                by <span className="font-medium text-foreground">{data.changedBy}</span>
                {data.byAgent && ' (an agent)'} · {stamp(data.createdAt)}
              </span>
              <Badge variant={data.state === 'pending' ? 'default' : 'secondary'}>{STATE[data.state]}</Badge>
              {data.resolvedBy && data.resolvedAt && (
                <span>
                  {data.state === 'reverted' ? 'reverted' : 'kept'} by {data.resolvedBy} ·{' '}
                  {stamp(data.resolvedAt)}
                </span>
              )}
            </div>
            <ChangeDiff change={data} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * An activity line that records a change of the report's prompt or template (`changeId`): opens the
 * change's diff, old against new.
 */
export function SettingsChangeDiff({ changeId, children }: { changeId: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tip content="Show what changed">
        <button
          type="button"
          className="min-w-0 cursor-pointer text-left wrap-anywhere hover:underline"
          onClick={() => setOpen(true)}
        >
          {children}
        </button>
      </Tip>
      <ChangeDialog changeId={open ? changeId : null} onClose={() => setOpen(false)} />
    </>
  )
}
