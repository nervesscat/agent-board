import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '#/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { errorMessage, put, type TicketFull } from '#/lib/api'
import { SEND_BACK_REASONS, type SendBackReason } from '#/lib/constants'
import { stamp } from '#/lib/format'
import { useStages } from '#/lib/project'

const NONE = 'none'

/**
 * The ticket's stage history: each move between stages, oldest first, with who made it and how (the
 * human's move, the verdict, an agent, the board), the human's send-backs from review marked with their
 * reason (the human picks it here), and when its PR was merged. A ticket with nothing recorded says
 * that it has none.
 */
export function StageHistoryCard({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const { t: tr } = useTranslation()
  const stages = useStages(t.projectId)
  const stageName = (key: string) => stages.find((s) => s.key === key)?.name ?? key
  const sendBackOf = new Map(t.sendBacks.flatMap((b) => (b.eventId !== null ? [[b.eventId, b]] : [])))
  const setReason = useMutation({
    mutationFn: (v: { id: number; reason: SendBackReason | null }) =>
      put(`/api/tickets/${t.id}/send-backs/${v.id}`, { reason: v.reason }),
    onSuccess: onChange,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reasons = Object.fromEntries([
    [NONE, tr('stageHistory.reason.none')],
    ...SEND_BACK_REASONS.map((r) => [r, tr(`stageHistory.reason.${r}`)]),
  ])
  // A send-back whose stage event was not written still shows, after the moves.
  const unmatched = t.sendBacks.filter(
    (b) => b.eventId === null || !t.stageHistory.some((e) => e.id === b.eventId),
  )
  const reasonPicker = (b: TicketFull['sendBacks'][number]) => (
    <Select
      value={b.reason ?? NONE}
      items={reasons}
      onValueChange={(v) =>
        v && setReason.mutate({ id: b.id, reason: v === NONE ? null : (v as SendBackReason) })
      }
    >
      <SelectTrigger size="sm" aria-label={tr('stageHistory.reasonLabel')} disabled={setReason.isPending}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[NONE, ...SEND_BACK_REASONS].map((r) => (
          <SelectItem key={r} value={r}>
            {reasons[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <section className="mt-4 rounded-lg border p-4" aria-label={tr('stageHistory.title')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{tr('stageHistory.title')}</h2>
        <span className="text-xs text-muted-foreground" data-testid="send-back-count">
          {tr('stageHistory.sendBacks', { count: t.sendBackCount })}
        </span>
      </div>
      {t.mergedAt && (
        <p className="mb-2 text-sm" data-testid="merged-at">
          {tr('stageHistory.merged', { at: stamp(t.mergedAt) })}
        </p>
      )}
      {t.stageHistory.length === 0 && unmatched.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('stageHistory.empty')}</p>
      ) : (
        <ol className="space-y-1.5 text-xs" aria-label={tr('stageHistory.moves')}>
          {t.stageHistory.map((e) => {
            const back = sendBackOf.get(e.id)
            return (
              <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <time dateTime={e.at} className="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {stamp(e.at)}
                </time>
                <span className="min-w-0 break-words">
                  {e.from
                    ? tr('stageHistory.moved', { from: stageName(e.from), to: stageName(e.to) })
                    : tr('stageHistory.created', { to: stageName(e.to) })}
                </span>
                <span className="text-muted-foreground">
                  {!e.by || !e.how
                    ? tr('stageHistory.how.unrecorded')
                    : e.how === 'board' && e.by !== 'board'
                      ? tr('stageHistory.how.boardFor', { by: e.by })
                      : tr(`stageHistory.how.${e.how}`, { by: e.by })}
                </span>
                {back && (
                  <>
                    <Badge variant="outline">{tr('stageHistory.sentBack')}</Badge>
                    {reasonPicker(back)}
                  </>
                )}
              </li>
            )
          })}
          {unmatched.map((b) => (
            <li key={`b${b.id}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <time dateTime={b.at} className="shrink-0 font-mono text-muted-foreground tabular-nums">
                {stamp(b.at)}
              </time>
              <span className="min-w-0 break-words">
                {tr('stageHistory.moved', { from: stageName(b.from), to: stageName(b.to) })}
              </span>
              <span className="text-muted-foreground">{tr('stageHistory.how.human', { by: b.by })}</span>
              <Badge variant="outline">{tr('stageHistory.sentBack')}</Badge>
              {reasonPicker(b)}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
