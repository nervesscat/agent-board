import { cn } from 'cn'
import { useTranslation } from 'react-i18next'

import { Tip } from '#/components/ui/tooltip'
import type { Reach } from '#/lib/api'

const REACH: Record<Reach['state'], { className: string }> = {
  merged: {
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  rebased: {
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  edited: {
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  },
  unique: {
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  },
}

/** Whether a branch's work reached its base, and which base. */
export function ReachBadge({ reach, className }: { reach: Reach; className?: string }) {
  const { t } = useTranslation()
  const r = REACH[reach.state]
  const count = reach.state === 'unique' ? ` · ${reach.unique.length}` : ''
  return (
    <Tip
      content={`${t(`reach.${reach.state}.title`)}${reach.unique.length ? `\n\n${reach.unique.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n')}` : ''}`}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
          r.className,
          className,
        )}
      >
        {t(`reach.${reach.state}.label`)}
        {count} <span className="font-mono opacity-80">→ {reach.into}</span>
      </span>
    </Tip>
  )
}
