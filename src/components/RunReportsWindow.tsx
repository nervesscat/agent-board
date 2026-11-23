import { ArrowLeft, ClipboardList } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { RunReportRowButton, RunReportView, runReportLabel } from '#/components/RunReport'
import { Button } from '#/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import {
  agentOptions,
  filterReports,
  hasFilters,
  hasUnroundedReport,
  NO_REPORT_FILTERS,
  type RatingFilter,
  type ReportFilters,
  type ReportSort,
  roundOptions,
  sortReports,
} from '#/lib/reportFilter'
import type { RunReport } from '#/lib/runReports'
import { useNow, useServerOffset } from '#/lib/useNow'
import { onServerClock } from '#/lib/workStatus'

const ANY = 'any'

const TIME_ITEMS = { any: 'Any time', hour: 'Last hour', today: 'Today', week: 'Last 7 days' }
const DURATION_ITEMS = { any: 'Any', reported: 'Reported', unreported: 'Not reported' }
const SORT_ITEMS: Record<ReportSort, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  longest: 'Longest',
  difficulty: 'Highest difficulty',
  confidence: 'Highest confidence',
}
const RATING_ITEMS = {
  [ANY]: 'Any',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  unrated: 'Unrated',
}

/** A rating filter as its select value, and back. */
const ratingValue = (v: RatingFilter) => (v === null ? ANY : String(v))
const ratingOf = (v: string): RatingFilter => (v === ANY ? null : v === 'unrated' ? 'unrated' : Number(v))

/** One filter: a visible label over a select. */
function FilterSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: string
  items: Record<string, string>
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)} items={items}>
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {Object.entries(items).map(([v, name]) => (
            <SelectItem key={v} value={v}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** The list: its filter bar, the count and the rows. The filters and the sort live with the window, so Back keeps them. */
function ReportList({
  reports,
  filters,
  onFilters,
  sort,
  onSort,
  onOpen,
  serverNow,
}: {
  reports: RunReport[]
  filters: ReportFilters
  onFilters: (f: ReportFilters) => void
  sort: ReportSort
  onSort: (s: ReportSort) => void
  onOpen: (r: RunReport) => void
  serverNow?: string | null
}) {
  // Presets count from the server's clock (report times are the server's), refreshed while the window is open.
  const now = onServerClock(useNow(30_000), useServerOffset(serverNow))
  const agents = useMemo(() => agentOptions(reports), [reports])
  const rounds = useMemo(() => roundOptions(reports), [reports])
  const shown = useMemo(
    () => sortReports(filterReports(reports, filters, now), sort),
    [reports, filters, sort, now],
  )
  const set = (change: Partial<ReportFilters>) => onFilters({ ...filters, ...change })

  if (!reports.length) return <p className="text-sm text-muted-foreground">No run reports yet.</p>
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        <FilterSelect
          label="Agent"
          value={filters.agent ?? ANY}
          items={{ [ANY]: 'All agents', ...Object.fromEntries(agents.map((a) => [a, a])) }}
          onChange={(v) => set({ agent: v === ANY ? null : v })}
        />
        <FilterSelect
          label="Round"
          value={filters.round === null ? ANY : String(filters.round)}
          items={{
            [ANY]: 'All rounds',
            ...Object.fromEntries(rounds.map((n) => [String(n), `Round ${n}`])),
            ...(hasUnroundedReport(reports) ? { none: 'No round' } : {}),
          }}
          onChange={(v) => set({ round: v === ANY ? null : v === 'none' ? 'none' : Number(v) })}
        />
        <FilterSelect
          label="Time"
          value={filters.time}
          items={TIME_ITEMS}
          onChange={(v) => set({ time: v as ReportFilters['time'] })}
        />
        <FilterSelect
          label="Difficulty"
          value={ratingValue(filters.difficulty)}
          items={RATING_ITEMS}
          onChange={(v) => set({ difficulty: ratingOf(v) })}
        />
        <FilterSelect
          label="Confidence"
          value={ratingValue(filters.confidence)}
          items={RATING_ITEMS}
          onChange={(v) => set({ confidence: ratingOf(v) })}
        />
        <FilterSelect
          label="Duration"
          value={filters.duration}
          items={DURATION_ITEMS}
          onChange={(v) => set({ duration: v as ReportFilters['duration'] })}
        />
        <FilterSelect
          label="Sort by"
          value={sort}
          items={SORT_ITEMS}
          onChange={(v) => onSort(v as ReportSort)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {shown.length} of {reports.length} report{reports.length === 1 ? '' : 's'}
        </p>
        {hasFilters(filters) && (
          <Button variant="ghost" size="xs" onClick={() => onFilters(NO_REPORT_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
      {shown.length ? (
        <ul className="space-y-1">
          {shown.map((r) => (
            <li key={r.id}>
              <RunReportRowButton r={r} onOpen={() => onOpen(r)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No report matches these filters.</p>
      )}
    </div>
  )
}

/**
 * A ticket's run reports: an icon button (with how many there are) and the window it opens. The window
 * lists every report with filters and a sort; a row opens the whole report in the same window, and Back
 * returns to the list as it was left. Full-screen on a phone.
 */
export function RunReportsWindow({
  reports,
  serverNow,
}: {
  reports: RunReport[]
  serverNow?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const [filters, setFilters] = useState(NO_REPORT_FILTERS)
  const [sort, setSort] = useState<ReportSort>('newest')
  const report = reports.find((r) => r.id === openId) ?? null
  const show = (next: boolean) => {
    // Each opening starts from the whole list, newest first.
    if (next) {
      setOpenId(null)
      setFilters(NO_REPORT_FILTERS)
      setSort('newest')
    }
    setOpen(next)
  }
  return (
    <>
      <Tip content="Reports">
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={reports.length ? `Reports (${reports.length})` : 'Reports'}
          onClick={() => show(true)}
        >
          <ClipboardList aria-hidden />
          {reports.length > 0 && (
            <span
              aria-hidden
              data-testid="reports-count"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
            >
              {reports.length}
            </span>
          )}
        </Button>
      </Tip>
      <Dialog open={open} onOpenChange={show}>
        <DialogContent className="top-0 left-0 h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[85vh] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl">
          <DialogHeader className="pr-8">
            <DialogTitle>{report ? `Run report: ${runReportLabel(report)}` : 'Run reports'}</DialogTitle>
            <DialogDescription className="sr-only">
              The run reports of this ticket, with filters and a sort. Opening one shows it in full.
            </DialogDescription>
          </DialogHeader>
          {report ? (
            <div className="min-w-0 space-y-3">
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setOpenId(null)}>
                <ArrowLeft aria-hidden />
                Back to reports
              </Button>
              <RunReportView r={report} />
            </div>
          ) : (
            <ReportList
              reports={reports}
              filters={filters}
              onFilters={setFilters}
              sort={sort}
              onSort={setSort}
              onOpen={(r) => setOpenId(r.id)}
              serverNow={serverNow}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
