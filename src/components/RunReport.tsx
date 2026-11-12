import { Check, ClipboardList, X } from 'lucide-react'
import { useState } from 'react'

import { Actor } from '#/components/Actor'
import { Markdown } from '#/components/Markdown'
import { Badge } from '#/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Tip } from '#/components/ui/tooltip'
import { ago, shortSha, stamp } from '#/lib/format'
import {
  RUN_REPORT_SECTIONS,
  RUN_REPORT_TIME_KEYS,
  type RunReport,
  runReportSectionLabel,
  sectionsForAgent,
} from '#/lib/runReports'
import { formatDuration } from '#/lib/workTimeline'

const TIME_LABEL: Record<(typeof RUN_REPORT_TIME_KEYS)[number], string> = {
  readingMs: 'reading',
  runningMs: 'running',
  waitingMs: 'waiting',
  writingMs: 'writing',
  otherMs: 'other',
}

/** `hunt round 2`, or just the agent outside a review. */
export const runReportLabel = (r: Pick<RunReport, 'agent' | 'round'>) =>
  r.round === null ? r.agent : `${r.agent} round ${r.round}`

/** Its duration: `not reported` when neither a span measured it nor the agent gave a time. */
export const runReportDuration = (r: Pick<RunReport, 'durationMs' | 'durationSource'>) =>
  r.durationSource === 'unknown' ? 'not reported' : formatDuration(r.durationMs)

/** The report's sections in the template's order, then any the agent added of its own. */
function sectionEntries(r: RunReport) {
  const named = new Set<string>(RUN_REPORT_SECTIONS)
  const order = [...sectionsForAgent(r.agent), ...Object.keys(r.sections).filter((k) => !named.has(k))]
  return [...new Set(order)]
    .filter((k) => (r.sections[k] ?? '').trim())
    .map((k) => [k, r.sections[k]!.trim()] as const)
}

/** One run report in full: identity, the numbers, the steps and every section. */
export function RunReportView({ r }: { r: RunReport }) {
  const times = RUN_REPORT_TIME_KEYS.map((k) => [k, r.time[k] ?? 0] as const).filter(([, ms]) => ms > 0)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge variant="secondary">{runReportLabel(r)}</Badge>
        {r.branch && (
          <span className="font-mono text-xs text-muted-foreground">
            {r.branch}
            {r.headSha && ` @ ${shortSha(r.headSha)}`}
          </span>
        )}
        {r.model && <span className="text-xs text-muted-foreground">{r.model}</span>}
        {r.effort && <span className="text-xs text-muted-foreground">{r.effort} effort</span>}
        {r.briefedBy && (
          <span className="text-xs text-muted-foreground">
            briefed by <Actor name={r.briefedBy} short />
          </span>
        )}
        <Tip content={stamp(r.createdAt)}>
          <span className="ml-auto text-xs text-muted-foreground">
            <Actor name={r.author} /> · {ago(r.createdAt)}
          </span>
        </Tip>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            Duration
            {r.durationSource === 'measured'
              ? ' (measured)'
              : r.durationSource === 'self'
                ? ' (self-reported)'
                : ''}
          </dt>
          <dd className="font-medium">{runReportDuration(r)}</dd>
        </div>
        {r.reportedDurationMs !== null && r.durationSource === 'measured' && (
          <div>
            <dt className="text-xs text-muted-foreground">Its own estimate</dt>
            <dd>{formatDuration(r.reportedDurationMs)}</dd>
          </div>
        )}
        {r.difficulty !== null && (
          <div>
            <dt className="text-xs text-muted-foreground">Difficulty</dt>
            <dd>{r.difficulty} / 5</dd>
          </div>
        )}
        {r.confidence !== null && (
          <div>
            <dt className="text-xs text-muted-foreground">Confidence</dt>
            <dd>{r.confidence} / 5</dd>
          </div>
        )}
        {r.startedAt && (
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd>{stamp(r.startedAt)}</dd>
          </div>
        )}
        {r.endedAt && (
          <div>
            <dt className="text-xs text-muted-foreground">Ended</dt>
            <dd>{stamp(r.endedAt)}</dd>
          </div>
        )}
      </dl>

      {times.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {times.map(([k, ms]) => (
            <span key={k} className="rounded bg-muted px-1.5 py-0.5">
              {TIME_LABEL[k]}: {formatDuration(ms)}
            </span>
          ))}
        </div>
      )}

      {Object.keys(r.counts).length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {Object.entries(r.counts).map(([k, n]) => (
            <span key={k} className="rounded bg-muted px-1.5 py-0.5">
              {k}: {n}
            </span>
          ))}
        </div>
      )}

      {r.steps.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">Steps</h4>
          <ul className="space-y-1 text-sm">
            {r.steps.map((s, i) => (
              <li key={`${s.name}-${i}`} className="flex gap-2">
                {s.done ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <X className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                )}
                <span className={s.done ? '' : 'text-muted-foreground'}>
                  {s.name}
                  {s.note && <span className="text-muted-foreground"> — {s.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sectionEntries(r).map(([key, text]) => (
        <div key={key} className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">{runReportSectionLabel(key)}</h4>
          <Markdown>{text}</Markdown>
        </div>
      ))}
    </div>
  )
}

/** The dialog a report opens in; `report` null keeps it closed. */
export function RunReportDialog({ report, onClose }: { report: RunReport | null; onClose: () => void }) {
  // Keeps showing the last one while the dialog animates closed.
  const [last, setLast] = useState(report)
  if (report && report.id !== last?.id) setLast(report)
  const shown = report ?? last
  return (
    <Dialog open={report !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{shown ? `Run report: ${runReportLabel(shown)}` : 'Run report'}</DialogTitle>
        </DialogHeader>
        {shown && <RunReportView r={shown} />}
      </DialogContent>
    </Dialog>
  )
}

/** One report as a row: what ran, its round, its numbers; opening it shows the whole report. */
export function RunReportRowButton({ r, onOpen }: { r: RunReport; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full cursor-pointer rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50"
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ClipboardList className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{r.agent}</span>
        {r.round !== null && <Badge variant="outline">round {r.round}</Badge>}
        <span className="text-xs text-muted-foreground">{runReportDuration(r)}</span>
        {r.difficulty !== null && (
          <span className="text-xs text-muted-foreground">difficulty {r.difficulty}/5</span>
        )}
        {r.confidence !== null && (
          <span className="text-xs text-muted-foreground">confidence {r.confidence}/5</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{ago(r.createdAt)}</span>
      </span>
    </button>
  )
}

/**
 * A ticket's run reports on the feed's Agents side: one report per subagent run, newest first. Nothing
 * is shown for a ticket no subagent reported on.
 */
export function RunReportsPanel({ reports }: { reports: RunReport[] }) {
  const [open, setOpen] = useState<RunReport | null>(null)
  if (!reports.length) return null
  return (
    <section aria-label="Run reports" className="mb-4 space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        Run reports · {reports.length} run{reports.length === 1 ? '' : 's'}
      </h3>
      <ul className="space-y-1">
        {reports.map((r) => (
          <li key={r.id}>
            <RunReportRowButton r={r} onOpen={() => setOpen(r)} />
          </li>
        ))}
      </ul>
      <RunReportDialog report={open} onClose={() => setOpen(null)} />
    </section>
  )
}
