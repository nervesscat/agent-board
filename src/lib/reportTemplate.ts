// The shape of a project's report: a markdown skeleton whose headings a generated report must keep, in
// the same order. Pure, so the server checks with it and the settings show it.

/** The template of a project that never set its own. */
export const DEFAULT_REPORT_TEMPLATE = `## Done

## In progress

## Blocked / needs you

## Pushed today

## Next
`

/** The template in force: the project's own, or the default when it has none (''). */
export function effectiveTemplate(stored: string): string {
  return stored.trim() ? stored : DEFAULT_REPORT_TEMPLATE
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
// An ATX heading: up to three spaces, one to six #, then its text, then an optional closing run of #
// that a space sets apart from the text ("## C#" keeps its #).
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/

/** The ATX headings of a markdown text, in order, as `{level, text}`; a `#` line in a code block is code. */
export function templateHeadings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  let fence: string | null = null
  for (const line of md.split(/\r?\n/)) {
    const f = FENCE.exec(line)
    if (fence) {
      // A block closes on a run of its own character, at least as long as the one that opened it.
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim())
        fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      continue
    }
    const m = HEADING.exec(line)
    if (m) out.push({ level: m[1]!.length, text: (m[2] ?? '').replace(/^#+$/, '').trim() })
  }
  return out
}

/**
 * The report itself when claude wrapped the whole of it in a markdown code fence (```markdown … ```),
 * which it sometimes does; any other text as it is. Trimmed.
 */
export function unwrapReport(output: string): string {
  const text = output.trim()
  const m = /^(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/i.exec(text)
  return (m ? m[2]! : text).trim()
}

export type TemplateCheck = { ok: true } | { ok: false; reason: string }

/** How two headings compare: at the same level, with whitespace collapsed and case ignored. */
const key = (h: { level: number; text: string }) =>
  `${h.level}:${h.text.replace(/\s+/g, ' ').trim().toLowerCase()}`

/** Each of `items` not matched by one of `against` (counted, so a heading twice needs two). */
function unmatched(items: { level: number; text: string }[], against: { level: number; text: string }[]) {
  const left = new Map<string, number>()
  for (const h of against) left.set(key(h), (left.get(key(h)) ?? 0) + 1)
  return items.filter((h) => {
    const n = left.get(key(h)) ?? 0
    if (n) left.set(key(h), n - 1)
    return !n
  })
}

/**
 * Whether `output` fills `template`: at the levels the template's headings use, the output has the
 * same headings, as many times, in the same order. Headings at other levels are the report's own
 * content, and so is any text before the first heading. When it does not, `reason` says what is wrong:
 * "missing: Next", "unexpected: Notes", "out of order: …".
 */
export function checkTemplate(template: string, output: string): TemplateCheck {
  const wanted = templateHeadings(template)
  if (!wanted.length) return { ok: true }
  const levels = new Set(wanted.map((h) => h.level))
  const got = templateHeadings(output).filter((h) => levels.has(h.level))

  const names = (hs: { text: string }[]) => hs.map((h) => h.text).join(', ')
  const missing = unmatched(wanted, got)
  const unexpected = unmatched(got, wanted)
  const reasons = [
    missing.length ? `missing: ${names(missing)}` : '',
    unexpected.length ? `unexpected: ${names(unexpected)}` : '',
  ].filter(Boolean)
  if (reasons.length) return { ok: false, reason: reasons.join('; ') }
  if (got.some((h, i) => key(h) !== key(wanted[i]!)))
    return { ok: false, reason: `out of order: ${names(got)} (the template has ${names(wanted)})` }
  return { ok: true }
}
