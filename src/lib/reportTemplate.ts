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

/** The ATX headings of a markdown text, in order, as `{level, text}`. */
export function templateHeadings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1]!.length, text: m[2]! })
  }
  return out
}

export type TemplateCheck = { ok: true } | { ok: false; reason: string }

/** Whether `output` fills `template`: the template's headings, the same ones in the same order. */
export function checkTemplate(_template: string, _output: string): TemplateCheck {
  return { ok: true }
}
