import { Skeleton } from '#/components/ui/skeleton'
import { useDelayedFlag } from '#/lib/useDelayedFlag'

/**
 * The inside of a control (a select's trigger) whose options are still on their way: a labeled skeleton
 * line, drawn only once the load has been slow for 150 ms. Mount it while loading.
 */
export function ControlSkeleton({ label }: { label: string }) {
  const slow = useDelayedFlag(true)
  return slow ? (
    <span role="status" aria-label={label} aria-busy="true" className="flex-1">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-3 w-24" />
    </span>
  ) : null
}
