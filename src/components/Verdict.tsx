import { Check, X } from 'lucide-react'

import { ago } from '#/lib/format'

export type Verdict = 'approved' | 'disapproved' | null

type Judged = {
  approvedAt: string | null
  approvedBy: string
  disapprovedAt: string | null
  disapprovedBy: string
}

export const verdictOf = (t: Judged): Verdict =>
  t.approvedAt ? 'approved' : t.disapprovedAt ? 'disapproved' : null

const ON = {
  approved: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  disapproved: 'border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400',
}

/**
 * Approve or disapprove, one at a time; clicking the active one takes the call back. Disapproving
 * cancels the lane on the server. `compact` is the icon pair for list rows.
 */
export function VerdictButtons({
  t,
  onSet,
  disabled,
  compact = false,
}: {
  t: Judged
  onSet: (v: Verdict) => void
  disabled?: boolean
  compact?: boolean
}) {
  const current = verdictOf(t)
  const button = (v: 'approved' | 'disapproved') => {
    const on = current === v
    const Icon = v === 'approved' ? Check : X
    const label = v === 'approved' ? 'Approve' : 'Disapprove'
    const title = on
      ? v === 'approved'
        ? `Approved by ${t.approvedBy} ${ago(t.approvedAt)}. Click to take it back.`
        : `Disapproved by ${t.disapprovedBy} ${ago(t.disapprovedAt)}. Click to take it back (reopens it).`
      : v === 'approved'
        ? 'Approve'
        : 'Disapprove: cancels this lane'
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => onSet(on ? null : v)}
        className={`inline-flex items-center justify-center gap-1 rounded-md border font-medium transition-colors disabled:opacity-50 ${
          compact ? 'size-6' : 'h-7 px-2.5 text-[0.8rem]'
        } ${on ? ON[v] : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <Icon className={compact ? 'size-3.5' : 'size-3.5'} />
        {!compact && (on ? (v === 'approved' ? 'Approved' : 'Disapproved') : label)}
      </button>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {button('approved')}
      {button('disapproved')}
    </span>
  )
}
