// Numbers in, numbers out: percentiles, a metric's median and spread over runs, the Markdown summary
// of a results file, and the comparison of two. Nothing here touches a server or the disk.

/** The p-th percentile (0–100) of `values`, interpolated between the closest ranks; null when empty. */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const rank = (p / 100) * (v.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return v[lo] + (v[hi] - v[lo]) * (rank - lo)
}

export const median = (values) => percentile(values, 50)

/**
 * Collects one value per run for each metric, then gives each its median and its noise: the range
 * (min to max) over the runs, and that range relative to the median. A value of null means the
 * metric could not be measured in that run; `na` says why.
 */
export class Metrics {
  constructor() {
    this.map = new Map()
  }

  add(key, value, unit, na) {
    let m = this.map.get(key)
    if (!m) this.map.set(key, (m = { unit, runs: [], na: undefined }))
    m.runs.push(typeof value === 'number' && Number.isFinite(value) ? round(value) : null)
    if (value === null && na) m.na = na
  }

  /** Where every metric stands now, for `rollback`. */
  mark() {
    return new Map([...this.map].map(([key, m]) => [key, { length: m.runs.length, na: m.na }]))
  }

  /** Drops every value added since `mark` (a run that does not count). */
  rollback(mark) {
    for (const [key, m] of this.map) {
      const at = mark.get(key)
      if (!at) this.map.delete(key)
      else {
        m.runs.length = at.length
        m.na = at.na
      }
    }
  }

  toJSON() {
    return Object.fromEntries([...this.map].map(([key, m]) => [key, finish(m)]))
  }
}

const round = (x) => Math.round(x * 100) / 100

function finish({ unit, runs, na }) {
  const measured = runs.filter((x) => x !== null)
  if (!measured.length)
    return { unit, runs, median: null, min: null, max: null, spread: null, na: na ?? 'not measured' }
  const med = median(measured)
  const min = Math.min(...measured)
  const max = Math.max(...measured)
  return {
    unit,
    runs,
    median: round(med),
    min,
    max,
    // The noise: the range over the runs, relative to the median.
    spread: med === 0 ? (max === min ? 0 : null) : round((max - min) / Math.abs(med)),
  }
}

/** Least-squares slope of y over x. */
export function slope(points) {
  const n = points.length
  if (n < 2) return null
  const mx = points.reduce((s, [x]) => s + x, 0) / n
  const my = points.reduce((s, [, y]) => s + y, 0) / n
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  if (sxx === 0) return null
  return points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx
}

// --- formatting ---

const fmtNum = (x, unit) => {
  if (x === null || x === undefined) return 'n/a'
  if (unit === 'bytes') return fmtBytes(x)
  const digits = Math.abs(x) >= 100 || Number.isInteger(x) ? 0 : 1
  return `${x.toFixed(digits)}${unit && unit !== 'count' ? ` ${unit}` : ''}`
}

export function fmtBytes(x) {
  if (x === null || x === undefined) return 'n/a'
  const a = Math.abs(x)
  if (a >= 1024 * 1024) return `${(x / 1024 / 1024).toFixed(2)} MB`
  if (a >= 1024) return `${(x / 1024).toFixed(1)} KB`
  return `${Math.round(x)} B`
}

/** "12.3 ms (11.8–13.0)": the median and the range over the runs, or why there is none. */
export function fmtMetric(m) {
  if (!m) return ''
  if (m.median === null) return `n/a${m.na ? ` (${m.na})` : ''}`
  const value = fmtNum(m.median, m.unit)
  if (m.runs.filter((x) => x !== null).length < 2 || m.min === m.max) return value
  return `${value} (${fmtNum(m.min, m.unit === 'bytes' ? 'bytes' : '')}–${fmtNum(m.max, m.unit === 'bytes' ? 'bytes' : '')})`
}

const table = (head, rows) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`,
        ...rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
      ].join('\n')
    : '_none_'

/** Rows of `metrics` whose key starts with `prefix`, grouped by the name between prefix and the last dot. */
function grouped(metrics, prefix) {
  const groups = new Map()
  for (const [key, m] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const dot = rest.lastIndexOf('.')
    const name = rest.slice(0, dot)
    const field = rest.slice(dot + 1)
    if (!groups.has(name)) groups.set(name, {})
    groups.get(name)[field] = m
  }
  return groups
}

/** A table of the metrics under `prefix`; why a value is n/a is said once, under it. */
function section(metrics, prefix, columns) {
  const reasons = new Set()
  const cell = (m) => {
    if (m?.median !== null || !m.na) return fmtMetric(m)
    reasons.add(m.na)
    return 'n/a'
  }
  const rows = [...grouped(metrics, prefix)].map(([name, g]) => [
    name,
    ...columns.map(([field]) => cell(g[field])),
  ])
  return [
    table(['', ...columns.map(([, label]) => label)], rows),
    ...[...reasons].map((r) => `\nn/a: ${r}`),
  ].join('\n')
}

/** The human-readable summary of one results file. */
export function markdownSummary(res) {
  const s = res.settings
  const lines = [
    `# Benchmark: ${res.target.branch} @ ${res.target.sha.slice(0, 12)}${res.label ? ` (${res.label})` : ''}`,
    '',
    `Values are medians over ${s.runs} run(s), with the range over the runs in brackets.`,
    '',
    '## Machine and conditions',
    '',
    table(
      ['', ''],
      [
        ['CPU', `${res.machine.cpu} (${res.machine.cores} logical cores)`],
        ['Memory', `${res.machine.memoryGB} GB (${res.machine.freeMemoryGB} GB free at start)`],
        ['OS', `${res.machine.os} ${res.machine.osRelease} (${res.machine.arch})`],
        ['Node / pnpm', `${res.machine.node} / ${res.machine.pnpm}`],
        ['Target', `${res.target.path}`],
        [
          'Commit',
          `${res.target.sha} on ${res.target.branch}${res.target.dirty ? ` (dirty: ${res.target.dirty} changed files)` : ' (clean)'}`,
        ],
        [
          'Build',
          res.target.buildDir === null
            ? 'none (vite dev)'
            : `${res.target.buildDir} (${res.target.buildMs === null ? 'reused' : `${(res.target.buildMs / 1000).toFixed(1)} s`})`,
        ],
        ['Server', `${res.server.mode}, ${res.server.host}, port ${res.server.ports.join(', ')}`],
        [
          'Instrumentation',
          res.instrumentation.available
            ? 'SQL statements and child processes per request'
            : `unavailable: ${res.instrumentation.reason}`,
        ],
        [
          'Settings',
          `sections ${s.sections.join(', ')}; runs ${s.runs}; ${s.requests} requests per endpoint after ${s.warmup} warm-up; ` +
            `${s.loads} cold loads per page; idle ${s.idleSeconds} s; memory ${s.memorySeconds} s at ${s.memoryRate} req/s; scale ${s.scale}, seed ${s.seed}`,
        ],
        ['Started / ended', `${res.startedAt} / ${res.endedAt} (${(res.wallMs / 60000).toFixed(1)} min)`],
      ],
    ),
  ]
  for (const [name, d] of Object.entries(res.datasets)) {
    lines.push('', `## Dataset: ${name}`, '')
    if (d.skipped) {
      lines.push(`Skipped: ${d.skipped}`)
      continue
    }
    lines.push(
      `Rows: ${Object.entries(d.counts)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')}.`,
      '',
      `Picked: project ${d.picks.projectId}, ticket ${d.picks.ticketId} (${d.picks.ticketPosts} posts), board ticket ${d.picks.boardTicketId}, thread of post ${d.picks.postId}; human ${d.picks.human}, agent ${d.picks.agent}.`,
    )
    const day = d.source?.generator?.day
    if (day)
      lines.push(
        '',
        `Laid out on the local day ${day}${d.source.generator.days?.length > 1 ? ` (written again for ${d.source.generator.days.slice(1).join(', ')})` : ''}.` +
          (d.redone?.length ? ` Run again because they went past midnight: run ${d.redone.join(', ')}.` : ''),
      )
    const m = d.metrics
    if (m['server.startup_ms'])
      lines.push('', `Server start until it answers: ${fmtMetric(m['server.startup_ms'])}.`)
    if (d.details.server) {
      lines.push(
        '',
        '### Server: latency per endpoint',
        '',
        section(m, 'server.endpoint.', [
          ['p50_ms', 'p50'],
          ['p95_ms', 'p95'],
          ['cold_ms', 'first request'],
          ['db_queries', 'SQL per request'],
          ['child_processes', 'processes per request'],
          ['bytes', 'response'],
        ]),
        '',
        table(
          ['endpoint', 'path', 'statuses', 'processes run'],
          Object.entries(d.details.server.endpoints).map(([k, e]) => [
            k,
            `\`${e.path}\`${e.actor ? ` as ${e.actor}` : ''}`,
            Object.entries(e.statuses)
              .map(([st, n]) => `${st}×${n}`)
              .join(' '),
            Object.entries(e.commands ?? {})
              .map(([c, n]) => `${c}×${n}`)
              .join(' '),
          ]),
        ),
      )
      if (d.details.server.background)
        lines.push(
          '',
          `Outside any request (timers, background fetches) over the runs: ${d.details.server.background.db} SQL statements, ` +
            `${d.details.server.background.spawns} child processes.`,
        )
    }
    if (d.details.mcp)
      lines.push(
        '',
        '### MCP: tool results (as an agent)',
        '',
        section(m, 'mcp.', [
          ['chars', 'text chars'],
          ['bytes', 'HTTP body'],
          ['ms', 'latency'],
          ['db_queries', 'SQL'],
          ['child_processes', 'processes'],
        ]),
        ...Object.entries(d.details.mcp.errors ?? {}).map(([k, e]) => `\n- ${k}: ${e}`),
      )
    if (d.details.bundle?.skipped)
      lines.push('', `### Client: bundle per route`, '', `n/a: ${d.details.bundle.skipped}.`)
    else if (d.details.bundle)
      lines.push(
        '',
        '### Client: JS and CSS a cold load of each route downloads',
        '',
        section(m, 'bundle.route.', [
          ['js_raw', 'JS'],
          ['js_gzip', 'JS gzip'],
          ['css_raw', 'CSS'],
          ['css_gzip', 'CSS gzip'],
          ['files', 'files'],
        ]),
        '',
        `Whole client build: JS ${fmtMetric(m['bundle.total.js_raw'])} (gzip ${fmtMetric(m['bundle.total.js_gzip'])}), ` +
          `CSS ${fmtMetric(m['bundle.total.css_raw'])} (gzip ${fmtMetric(m['bundle.total.css_gzip'])}), ` +
          `all assets ${fmtMetric(m['bundle.total.all_raw'])}.`,
      )
    if (d.details.load)
      lines.push(
        '',
        '### Client: first load (cold cache)',
        '',
        section(m, 'load.', [
          ['ttfb_ms', 'TTFB'],
          ['dcl_ms', 'DOMContentLoaded'],
          ['load_ms', 'load'],
          ['hydrated_ms', 'hydrated'],
          ['content_ms', 'data shown'],
          ['requests', 'requests'],
          ['api_requests', 'API requests'],
          ['bytes', 'transferred'],
        ]),
      )
    if (d.details.nav)
      lines.push(
        '',
        '### Client: navigation',
        '',
        section(m, 'nav.', [
          ['ms', 'until shown'],
          ['api_requests', 'API requests'],
        ]),
      )
    if (d.details.idle) {
      lines.push(
        '',
        `### Client: requests per minute on an idle page (${s.idleSeconds} s window, tab visible)`,
        '',
        section(m, 'idle.', [['per_min', 'requests/min']]),
      )
      lines.push('', 'Per API path, requests per minute (last run):')
      for (const [page, p] of Object.entries(d.details.idle.pages))
        lines.push(
          '',
          `- ${page}: ${Object.entries(p.perPath)
            .sort((a, b) => b[1] - a[1])
            .map(([u, n]) => `\`${u}\` ${n}`)
            .join(', ')}`,
        )
    }
    if (d.details.memory) {
      const mem = d.details.memory
      lines.push(
        '',
        `### Memory over ${mem.seconds} s under load (${mem.requests} requests, ${mem.errors} failed)`,
        ...(mem.note ? ['', `Note: ${mem.note}.`] : []),
        '',
        table(
          ['', 'start', 'end', 'peak', 'slope'],
          [
            [
              'RSS',
              fmtBytes(mem.rss.start),
              fmtBytes(mem.rss.end),
              fmtBytes(mem.rss.peak),
              `${fmtBytes(mem.rss.slopePerMin)}/min`,
            ],
            [
              'heap used',
              fmtBytes(mem.heapUsed.start),
              fmtBytes(mem.heapUsed.end),
              fmtBytes(mem.heapUsed.peak),
              `${fmtBytes(mem.heapUsed.slopePerMin)}/min`,
            ],
          ],
        ),
      )
    }
  }
  return lines.join('\n') + '\n'
}

// --- comparing two results files ---

/**
 * Whether a change is beyond the noise: the ranges over the runs do not overlap. Bytes and counts are
 * the same on every run, so any change in them counts; a time taken in a single run on either side
 * has no range to judge it by (null: unknown).
 */
export function beyondNoise(before, after) {
  if (before.median === null || after.median === null) return false
  const runs = (m) => m.runs.filter((x) => x !== null).length
  if (before.unit === 'ms' && (runs(before) < 2 || runs(after) < 2)) return null
  return after.min > before.max || after.max < before.min
}

/** Every metric of both files, per dataset: before, after, the change and whether it is beyond the noise. */
export function compareResults(before, after) {
  const out = []
  const datasets = [...new Set([...Object.keys(before.datasets), ...Object.keys(after.datasets)])]
  for (const ds of datasets) {
    const b = before.datasets[ds]?.metrics ?? {}
    const a = after.datasets[ds]?.metrics ?? {}
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
      const mb = b[key]
      const ma = a[key]
      if (!mb || !ma) {
        out.push({
          dataset: ds,
          key,
          before: mb ?? null,
          after: ma ?? null,
          delta: null,
          pct: null,
          beyond: false,
          only: mb ? 'before' : 'after',
        })
        continue
      }
      const delta = mb.median === null || ma.median === null ? null : round(ma.median - mb.median)
      const pct = delta === null || mb.median === 0 ? null : round((delta / Math.abs(mb.median)) * 100)
      out.push({ dataset: ds, key, before: mb, after: ma, delta, pct, beyond: beyondNoise(mb, ma) })
    }
  }
  return out
}

export function markdownComparison(before, after, rows = compareResults(before, after)) {
  const head = (r) => `${r.target.branch} @ ${r.target.sha.slice(0, 12)}${r.label ? ` (${r.label})` : ''}`
  const lines = [
    `# Benchmark comparison`,
    '',
    `Before: ${head(before)}, ${before.startedAt}, ${before.settings.runs} run(s).`,
    `After: ${head(after)}, ${after.startedAt}, ${after.settings.runs} run(s).`,
    '',
    'Beyond noise: the ranges over the runs do not overlap. Bytes and counts do not vary between runs, so any change in them is; a time from a single run cannot be judged (?).',
  ]
  if (before.machine.cpu !== after.machine.cpu || before.machine.os !== after.machine.os)
    lines.push('', '**Warning:** the two runs come from different machines.')
  const mode = (r) => r.settings.server ?? 'build'
  if (mode(before) !== mode(after))
    lines.push(
      '',
      `**Warning:** the two runs measured different servers (before: ${mode(before)}, after: ${mode(after)}); their numbers are not comparable.`,
    )
  for (const ds of [...new Set(rows.map((r) => r.dataset))]) {
    const mine = rows.filter((r) => r.dataset === ds)
    const flagged = mine.filter((r) => r.beyond)
    lines.push(
      '',
      `## ${ds}`,
      '',
      `${flagged.length} of ${mine.length} metrics changed beyond noise` +
        (flagged.length
          ? ` (${flagged.filter((r) => r.delta > 0).length} up, ${flagged.filter((r) => r.delta < 0).length} down).`
          : '.'),
      '',
      table(
        ['metric', 'before', 'after', 'change', '%', 'beyond noise'],
        mine.map((r) => [
          r.key,
          r.before ? fmtMetric(r.before) : '(absent)',
          r.after ? fmtMetric(r.after) : '(absent)',
          r.delta === null ? '' : `${r.delta > 0 ? '+' : ''}${fmtNum(r.delta, (r.after ?? r.before).unit)}`,
          r.pct === null ? '' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%`,
          r.beyond === null ? '?' : r.beyond ? (r.delta > 0 ? 'yes, up' : 'yes, down') : '',
        ]),
      ),
    )
  }
  return lines.join('\n') + '\n'
}
