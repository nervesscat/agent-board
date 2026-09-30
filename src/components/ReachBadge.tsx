import { cn } from 'cn'

import type { Reach } from '#/lib/api'

const REACH: Record<Reach['state'], { label: string; title: string; className: string }> = {
  merged: {
    label: 'merged',
    title: 'Every commit is in the base as is. Safe to delete.',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  rebased: {
    label: 'rebased',
    title: 'The commits were rebased or cherry-picked; the same patches are in the base. Safe to delete.',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  edited: {
    label: 'edited in',
    title: 'The patches differ, but merging the branch would change nothing in the base. Safe to delete.',
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  },
  unique: {
    label: 'unique work',
    title: 'The branch still has changes the base does not. Keep it.',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  },
}

/** Whether a branch's work reached its base, and which base. */
export function ReachBadge({ reach, className }: { reach: Reach; className?: string }) {
  const r = REACH[reach.state]
  const count = reach.state === 'unique' ? ` · ${reach.unique.length}` : ''
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
        r.className,
        className,
      )}
      title={`${r.title}${reach.unique.length ? `\n\n${reach.unique.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n')}` : ''}`}
    >
      {r.label}
      {count} <span className="font-mono opacity-80">→ {reach.into}</span>
    </span>
  )
}
