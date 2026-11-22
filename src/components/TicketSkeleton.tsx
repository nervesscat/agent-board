import { Loading, LoadingBar, SkeletonCard, SkeletonText } from '#/components/Loading'
import { Skeleton } from '#/components/ui/skeleton'
import { type Layout, type LayoutId, shownIn } from '#/lib/layout'

/** Lines of text the real card of each section roughly has, so the page does not jump when it lands. */
const LINES: Partial<Record<LayoutId, number>> = {
  'ticket.instructions': 6,
  'ticket.tasks': 3,
  'ticket.timeline': 4,
  'ticket.lanes': 3,
  'ticket.activity': 5,
  'ticket.runs': 2,
  'ticket.details': 6,
  'ticket.branch': 2,
  'ticket.workspaces': 3,
}

/**
 * The ticket page while the next ticket loads: the breadcrumb, title, toolbar, section tabs and the
 * cards of the project's layout, as placeholders in the same two columns.
 */
export function TicketSkeleton({ layout }: { layout: Layout }) {
  const main = shownIn(layout, 'ticket.main')
  const side = shownIn(layout, 'ticket.side')
  return (
    <Loading label="Loading ticket…" className="flex flex-col gap-6">
      <LoadingBar />
      <Skeleton className="h-4 w-56" />
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-48 flex-1 space-y-2">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <div className="-mt-1 flex min-h-7 items-center gap-2">
        {main.slice(0, 4).map((s) => (
          <Skeleton key={s} className="h-5 w-16" />
        ))}
        <Skeleton className="ml-auto h-6 w-28" />
      </div>
      <div
        className={
          main.length > 0 && side.length > 0
            ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]'
            : 'grid grid-cols-1 gap-6'
        }
      >
        {main.length > 0 && (
          <div className="min-w-0 space-y-6">
            {main.map((s) => (
              <SkeletonCard key={s} lines={LINES[s] ?? 3} />
            ))}
          </div>
        )}
        {side.length > 0 && (
          <div className="min-w-0 space-y-4">
            {side.map((s) => (
              <SkeletonCard key={s} className="p-3">
                <SkeletonText lines={LINES[s] ?? 3} />
              </SkeletonCard>
            ))}
          </div>
        )}
      </div>
    </Loading>
  )
}
