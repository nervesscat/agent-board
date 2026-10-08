import { cn } from 'cn'
import type { ReactNode } from 'react'

// Severity words read the same everywhere; any other tag gets a steady colour from its name.
const SEVERITY: Record<string, { rank: number; className: string }> = {
  blocker: { rank: 0, className: 'bg-red-600/20 text-red-700 dark:text-red-300' },
  critical: { rank: 0, className: 'bg-red-600/20 text-red-700 dark:text-red-300' },
  high: { rank: 1, className: 'bg-red-500/15 text-red-700 dark:text-red-400' },
  medium: { rank: 2, className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  low: { rank: 3, className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400' },
  cosmetic: { rank: 4, className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
  nit: { rank: 4, className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
  trivial: { rank: 4, className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
}
const PALETTE = [
  'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  'bg-teal-500/15 text-teal-700 dark:text-teal-400',
  'bg-pink-500/15 text-pink-700 dark:text-pink-400',
  'bg-lime-500/15 text-lime-700 dark:text-lime-400',
  'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
]

export function tagClass(tag: string) {
  const known = SEVERITY[tag.toLowerCase()]
  if (known) return known.className
  let h = 0
  for (const ch of tag.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

/** Severity tags first (critical → cosmetic), then the rest alphabetically. */
export function compareTags(a: string, b: string) {
  const ra = SEVERITY[a.toLowerCase()]?.rank ?? 9
  const rb = SEVERITY[b.toLowerCase()]?.rank ?? 9
  return ra - rb || a.localeCompare(b)
}

/** A tag's chip. `children` go after its name, inside the chip (a remove button). */
export function Tag({ tag, className, children }: { tag: string; className?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
        tagClass(tag),
        className,
      )}
    >
      {tag}
      {children}
    </span>
  )
}
