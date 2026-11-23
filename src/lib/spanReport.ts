import { RUN_REPORT_AGENTS, type RunReport } from './runReports'
import type { TimelineSpan } from './workTimeline'

/**
 * Which run report a work span on the timeline opens (the client's reading of how src/server/runReports.ts
 * measures a run from its span). Pure, so the chart and its tests share it.
 *
 * A report belongs to a span when both are on the same ticket (the caller passes one ticket's reports),
 * the span's agent is the report's kind of run, and the round is the same (no round equals no round).
 * The kind is the agent's name lowercased, its last `/` segment (`orch/hunt-1` is `hunt-1`), with a trailing
 * `-<n>` taken off when what is left is a known kind: a default report agent or an agent name a report
 * carries. The kind is the agent's, not the phase's: a `build` span is by `builder`.
 *
 * One report goes to one span, so two hunts of a round each open their own. Every span and report of the
 * same kind and round are paired, best pair first, and a pair is taken while neither is. A pair's score is,
 * in order of weight:
 * 1. the overlap of the report's `[startedAt, endedAt]` with the span (one known time counts as a moment: a
 *    moment inside the span is an overlap of 1 ms), the longest overlap first;
 * 2. else the report's `createdAt` inside the span or after its end (a report is written at the end of the
 *    run), the nearest the span's end first;
 * 3. else the report is before the span, the nearest first.
 * Pairs that score alike go to the report whose author's last name segment is the span agent's (`opencode/
 * hunt-2` wrote it, `opencode/hunt-2` worked the span), then to the earlier span with the earlier report.
 * A span or report left unpaired has no match: a span left over has no report.
 */

/** The agent name as a kind of run: lowercase, its last `/` segment. */
const lastSegment = (name: string) => name.trim().toLowerCase().split('/').at(-1) ?? ''

/** The kind of run an agent name stands for, `known` being the kinds a trailing `-<n>` may be taken off. */
function kindOf(name: string, known: Set<string>): string {
  const leaf = lastSegment(name)
  const m = /^(.+)-\d+$/.exec(leaf)
  return m && known.has(m[1]!) ? m[1]! : leaf
}

type Score = [tier: number, value: number]

/** How well a report fits a span: see the rule above. `end` is where the span ends (now, when it is open). */
function scoreOf(report: RunReport, start: number, end: number): Score {
  const from = report.startedAt ? Date.parse(report.startedAt) : NaN
  const to = report.endedAt ? Date.parse(report.endedAt) : NaN
  const a = Number.isNaN(from) ? to : from
  const b = Number.isNaN(to) ? from : to
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    const inside = Math.min(b, end) - Math.max(a, start)
    if (inside > 0) return [3, inside]
    if (a === b && a >= start && a <= end) return [3, 1]
  }
  const at = Date.parse(report.createdAt)
  if (at >= start) return [2, -Math.max(0, at - end)]
  return [1, -(start - at)]
}

/**
 * The report each span opens: span id to report, for the spans that have one. `reports` are one ticket's;
 * `now` ends an open span.
 */
export function reportsForSpans(
  spans: Pick<TimelineSpan, 'id' | 'agent' | 'round' | 'start' | 'end' | 'open'>[],
  reports: RunReport[],
  now: number = Date.now(),
): Map<number, RunReport> {
  const known = new Set<string>(RUN_REPORT_AGENTS)
  for (const r of reports) known.add(lastSegment(r.agent))
  const pairs: {
    span: (typeof spans)[number]
    report: RunReport
    score: Score
    author: number
    start: number
    made: number
  }[] = []
  for (const span of spans) {
    const kind = kindOf(span.agent, known)
    const start = Date.parse(span.start)
    const end = span.open ? Math.max(now, start) : Date.parse(span.end)
    for (const report of reports) {
      if (report.round !== span.round || kindOf(report.agent, known) !== kind) continue
      pairs.push({
        span,
        report,
        score: scoreOf(report, start, end),
        author: lastSegment(report.author) === lastSegment(span.agent) ? 1 : 0,
        start,
        made: Date.parse(report.createdAt),
      })
    }
  }
  pairs.sort(
    (x, y) =>
      y.score[0] - x.score[0] ||
      y.score[1] - x.score[1] ||
      y.author - x.author ||
      x.start - y.start ||
      x.made - y.made ||
      x.span.id - y.span.id ||
      x.report.id - y.report.id,
  )
  const out = new Map<number, RunReport>()
  const taken = new Set<number>()
  for (const p of pairs) {
    if (out.has(p.span.id) || taken.has(p.report.id)) continue
    out.set(p.span.id, p.report)
    taken.add(p.report.id)
  }
  return out
}
