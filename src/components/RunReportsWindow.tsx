import { ArrowLeft, ClipboardList } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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

const TIME_KEYS = {
  any: 'runReportsWindow.time.any',
  hour: 'runReportsWindow.time.hour',
  today: 'runReportsWindow.time.today',
  week: 'runReportsWindow.time.week',
} as const
const DURATION_KEYS = {
  any: 'runReportsWindow.duration.any',
  reported: 'runReportsWindow.duration.reported',
  unreported: 'runReportsWindow.duration.unreported',
} as const
const SORT_KEYS = {
  newest: 'runReportsWindow.sort.newest',
  oldest: 'runReportsWindow.sort.oldest',
  longest: 'runReportsWindow.sort.longest',
  difficulty: 'runReportsWindow.sort.difficulty',
  confidence: 'runReportsWindow.sort.confidence',
} as const satisfies Record<ReportSort, string>

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
  const { t } = useTranslation()
  const now = onServerClock(useNow(30_000), useServerOffset(serverNow))
  const agents = useMemo(() => agentOptions(reports), [reports])
  const rounds = useMemo(() => roundOptions(reports), [reports])
  const shown = useMemo(
    () => sortReports(filterReports(reports, filters, now), sort),
    [reports, filters, sort, now],
  )
  const set = (change: Partial<ReportFilters>) => onFilters({ ...filters, ...change })
  const timeItems = {
    any: t(TIME_KEYS.any),
    hour: t(TIME_KEYS.hour),
    today: t(TIME_KEYS.today),
    week: t(TIME_KEYS.week),
  }
  const durationItems = {
    any: t(DURATION_KEYS.any),
    reported: t(DURATION_KEYS.reported),
    unreported: t(DURATION_KEYS.unreported),
  }
  const sortItems = {
    newest: t(SORT_KEYS.newest),
    oldest: t(SORT_KEYS.oldest),
    longest: t(SORT_KEYS.longest),
    difficulty: t(SORT_KEYS.difficulty),
    confidence: t(SORT_KEYS.confidence),
  }
  const ratingItems = {
    [ANY]: t('runReportsWindow.rating.any'),
    '1': '1',
    '2': '2',
    '3': '3',
    '4': '4',
    '5': '5',
    unrated: t('runReportsWindow.rating.unrated'),
  }

  if (!reports.length) return <p className="text-sm text-muted-foreground">{t('runReportsWindow.none')}</p>
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        <FilterSelect
          label={t('runReportsWindow.filter.agent')}
          value={filters.agent ?? ANY}
          items={{
            [ANY]: t('runReportsWindow.items.allAgents'),
            ...Object.fromEntries(agents.map((a) => [a, a])),
          }}
          onChange={(v) => set({ agent: v === ANY ? null : v })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.round')}
          value={filters.round === null ? ANY : String(filters.round)}
          items={{
            [ANY]: t('runReportsWindow.items.allRounds'),
            ...Object.fromEntries(rounds.map((n) => [String(n), t('runReportsWindow.items.round', { n })])),
            ...(hasUnroundedReport(reports) ? { none: t('runReportsWindow.items.noRound') } : {}),
          }}
          onChange={(v) => set({ round: v === ANY ? null : v === 'none' ? 'none' : Number(v) })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.time')}
          value={filters.time}
          items={timeItems}
          onChange={(v) => set({ time: v as ReportFilters['time'] })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.difficulty')}
          value={ratingValue(filters.difficulty)}
          items={ratingItems}
          onChange={(v) => set({ difficulty: ratingOf(v) })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.confidence')}
          value={ratingValue(filters.confidence)}
          items={ratingItems}
          onChange={(v) => set({ confidence: ratingOf(v) })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.duration')}
          value={filters.duration}
          items={durationItems}
          onChange={(v) => set({ duration: v as ReportFilters['duration'] })}
        />
        <FilterSelect
          label={t('runReportsWindow.filter.sortBy')}
          value={sort}
          items={sortItems}
          onChange={(v) => onSort(v as ReportSort)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {t('runReportsWindow.count', { shown: shown.length, count: reports.length })}
        </p>
        {hasFilters(filters) && (
          <Button variant="ghost" size="xs" onClick={() => onFilters(NO_REPORT_FILTERS)}>
            {t('runReportsWindow.clearFilters')}
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
        <p className="text-sm text-muted-foreground">{t('runReportsWindow.noMatch')}</p>
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
  const { t } = useTranslation()
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
      <Tip content={t('runReportsWindow.reports')}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={
            reports.length
              ? t('runReportsWindow.reportsCount', { n: reports.length })
              : t('runReportsWindow.reports')
          }
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
            <DialogTitle>
              {report
                ? t('runReport.dialogTitle', { label: runReportLabel(report) })
                : t('runReportsWindow.title')}
            </DialogTitle>
            <DialogDescription className="sr-only">{t('runReportsWindow.description')}</DialogDescription>
          </DialogHeader>
          {report ? (
            <div className="min-w-0 space-y-3">
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setOpenId(null)}>
                <ArrowLeft aria-hidden />
                {t('runReportsWindow.back')}
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
