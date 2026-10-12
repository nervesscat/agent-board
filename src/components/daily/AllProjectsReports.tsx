import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { Markdown } from '#/components/Markdown'
import { REPORT_STATUS } from '#/components/daily/status'
import { get, type ReportsOverview } from '#/lib/api'
import { stamp } from '#/lib/format'
import { cn } from '#/lib/utils'

/**
 * Every project's report for the period holding `date`, read-only, on the all-projects Daily page:
 * one card per project that tracks reports, its latest version or where the period stands without one.
 * A report is written, generated or replaced on the project's own Daily page, which the name links to.
 */
export function AllProjectsReports({ date }: { date: string }) {
  const { data } = useQuery({
    queryKey: ['reports-overview', date],
    queryFn: () => get<ReportsOverview>(`/api/reports/overview?date=${date}`),
    // A period turns red when its due time passes, without anyone posting.
    refetchInterval: 60_000,
  })
  if (!data) return null

  return (
    <section className="space-y-3" aria-label="Reports">
      <h2 className="text-sm font-medium">Reports</h2>
      {!data.projects.length ? (
        <p className="text-sm text-muted-foreground">
          No project tracks reports: choose how often one is due on a project&apos;s Daily page.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.projects.map((p) => (
            <ProjectReport key={p.id} entry={p} />
          ))}
        </div>
      )}
    </section>
  )
}

function ProjectReport({ entry: p }: { entry: ReportsOverview['projects'][number] }) {
  const status = REPORT_STATUS[p.status]
  return (
    <article className="min-w-0 space-y-2 rounded-lg border p-4" aria-label={p.name}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="min-w-0 text-sm font-medium wrap-anywhere">
          <Link
            to="/projects/$id/daily"
            params={{ id: String(p.id) }}
            className="underline-offset-2 hover:underline"
          >
            {p.name}
          </Link>
        </h3>
        <span className="text-xs text-muted-foreground">{p.label}</span>
        <span className={cn('text-xs', status.text)}>{status.label}</span>
        {p.status !== 'off' && <span className="text-xs text-muted-foreground">due {stamp(p.due)}</span>}
      </div>
      {p.report ? (
        <div>
          <div className="text-xs text-muted-foreground">
            <Actor name={p.report.author} /> · {stamp(p.report.createdAt)} · {p.versions} version
            {p.versions === 1 ? '' : 's'}
          </div>
          {p.report.body && <Markdown className="mt-1">{p.report.body}</Markdown>}
          <Attachments items={p.report.attachments} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No report for {p.label}.</p>
      )}
    </article>
  )
}
