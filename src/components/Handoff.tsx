import { Check } from 'lucide-react'
import { toast } from 'sonner'

import type { Handoff } from '#/lib/api'

/**
 * The hand-off checklist of a ticket in review, as the board sees it: a green tick per item that is
 * there, an amber dot per item that is missing, what was found in each item's line.
 */
export function HandoffCard({ handoff }: { handoff: Handoff }) {
  const missing = handoff.missing.length
  return (
    <section className="rounded-lg border p-3" aria-label="Hand-off">
      <h2 className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        Hand-off
        <span
          className={
            missing
              ? 'text-xs font-normal text-amber-700 dark:text-amber-400'
              : 'text-xs font-normal text-emerald-700 dark:text-emerald-400'
          }
        >
          {missing ? `${missing} missing` : 'complete'}
        </span>
      </h2>
      <ul className="space-y-1.5 text-xs">
        {handoff.checks.map((c) => (
          <li key={c.code} data-code={c.code} data-ok={c.ok} className="flex items-start gap-2">
            {c.ok ? (
              <Check
                role="img"
                aria-label="done"
                className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            ) : (
              <span
                role="img"
                aria-label="missing"
                className="flex size-3.5 shrink-0 items-center justify-center"
              >
                <span className="size-2 rounded-full bg-amber-500" />
              </span>
            )}
            <span className="min-w-0">
              <span className="font-medium">{c.label}</span>
              <span className="block break-words text-muted-foreground">{c.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** After a move to review: what the hand-off still lacks, as a warning that does not undo the move. */
export function toastHandoff(res: unknown) {
  const handoff = (res as { handoff?: Handoff } | null)?.handoff
  if (!handoff?.missing.length) return
  toast.warning('In review, but the hand-off lacks:', {
    description: handoff.missing.map((m) => m.text).join('; '),
    duration: 10_000,
  })
}
