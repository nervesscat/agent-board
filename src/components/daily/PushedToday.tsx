import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { GitCommitHorizontal } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { get, type PushedToday } from '#/lib/api'
import { ago } from '#/lib/format'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Lines added and removed, as `+340 −85`. */
const lines = (t: { added: number; removed: number }) => `+${t.added} −${t.removed}`

/**
 * What reached origin today on the project's repos: green with the commits and lines when something
 * did, grey when nothing; the breakdown by repo, branch and ticket on demand. In the Daily page's
 * header.
 */
export function PushedTodayBadge({ projectId }: { projectId: number }) {
  const { data } = useQuery({
    queryKey: ['pushed-today', projectId],
    queryFn: () => get<PushedToday>(`/api/projects/${projectId}/pushed-today`),
    refetchInterval: 60_000,
  })
  if (!data) return null
  const pushed = data.commits > 0
  const label = pushed
    ? `Pushed today: ${plural(data.commits, 'commit')}, ${data.added} lines added, ${data.removed} removed`
    : 'Pushed today: nothing'

  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        data-pushed={pushed ? 'yes' : 'no'}
        className={cn(
          'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
          pushed
            ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-400/40 dark:text-emerald-300'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        <span
          data-part="dot"
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', pushed ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
        />
        {pushed ? (
          <>
            <span className="truncate">{plural(data.commits, 'commit')}</span>
            <span className="tabular-nums">{lines(data)}</span>
          </>
        ) : (
          <span className="truncate">Nothing pushed today</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Pushed today</span>
          <span className="text-xs text-muted-foreground">
            {data.checkedAt ? `origin checked ${ago(data.checkedAt)}` : 'origin not fetched yet'}
          </span>
        </div>
        {pushed ? (
          <ul aria-label="Pushed today by repo" className="space-y-2">
            {data.repos.map((r) => (
              <li key={r.repoId} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 font-medium">
                  <span className="truncate">{r.name}</span>
                  <Totals t={r} />
                </div>
                <ul className="mt-1 space-y-1 border-l pl-2">
                  {r.branches.map((b) => (
                    <li key={b.branch} className="min-w-0 text-xs">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1 font-mono">
                          <GitCommitHorizontal
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <Tip content={b.branch}>
                            <span className="truncate">{b.branch}</span>
                          </Tip>
                        </span>
                        <Totals t={b} />
                      </div>
                      {b.ticket && (
                        <Link
                          to="/projects/$id/features/$ticketId"
                          params={{ id: String(projectId), ticketId: String(b.ticket.id) }}
                          className="block truncate pl-4 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {b.ticket.title}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Nothing reached origin today on this project's repos.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Commits that reached a branch of origin today, each once, merges left out.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function Totals({ t }: { t: { commits: number; added: number; removed: number } }) {
  return (
    <span className="shrink-0 text-xs font-normal whitespace-nowrap text-muted-foreground tabular-nums">
      {plural(t.commits, 'commit')} <span className="text-emerald-700 dark:text-emerald-400">+{t.added}</span>{' '}
      <span className="text-red-700 dark:text-red-400">−{t.removed}</span>
    </span>
  )
}
