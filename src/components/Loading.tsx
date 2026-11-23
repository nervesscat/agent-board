import type { ReactNode } from 'react'

import { Skeleton } from '#/components/ui/skeleton'
import { useDelayedFlag } from '#/lib/useDelayedFlag'
import { cn } from 'cn'

/**
 * A loading region: marks its placeholders busy for assistive tech, with a visually hidden `label`
 * ("Loading ticket…") announced as a status. Wrap the skeletons of one thing that loads, and render it
 * only after `useDelayedFlag` says the load is slow.
 */
export function Loading({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/**
 * Lines of placeholder text, the last one shorter. Use in place of a paragraph or a list that is still
 * loading.
 */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

/** A bordered card with a heading line and placeholder lines: a card that is still loading. */
export function SkeletonCard({
  lines = 3,
  className,
  children,
}: {
  lines?: number
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('rounded-lg border p-4', className)} aria-hidden>
      <Skeleton className="mb-3 h-4 w-28" />
      {children ?? <SkeletonText lines={lines} />}
    </div>
  )
}

/**
 * A slim bar across the top of the content while the next page loads, next to its skeleton. Static
 * (not pulsing) under reduced motion.
 */
export function LoadingBar({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('h-0.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full w-1/3 rounded-full bg-primary/70 motion-safe:animate-pulse" />
    </div>
  )
}

/**
 * A small loading state for one part of a page whose data is still on its way (a card's rows, a panel's
 * details): mount it while loading, and it draws its placeholder only once the load has been slow for
 * `ms` (150 by default), so a fast load shows nothing.
 */
export function DelayedLoading({
  label,
  ms,
  className,
  children,
}: {
  label: string
  ms?: number
  className?: string
  children: ReactNode
}) {
  const slow = useDelayedFlag(true, ms)
  return slow ? (
    <Loading label={label} className={className}>
      {children}
    </Loading>
  ) : null
}
