import type { StageColor, StageKind } from '#/lib/constants'

/**
 * The command palette's items: one ranked list over tickets, pages, settings and actions. The items
 * themselves are built by the palette (`#/components/CommandPalette`); this module only decides what
 * matches a query and in what order, so the ranking can be tested on its own.
 */
export const PALETTE_KINDS = ['ticket', 'page', 'setting', 'action'] as const
export type PaletteKind = (typeof PALETTE_KINDS)[number]

export const PALETTE_KIND_LABEL: Record<PaletteKind, string> = {
  ticket: 'Tickets',
  page: 'Pages',
  setting: 'Settings',
  action: 'Actions',
}

/** A ticket's stage, as the badge shows it. */
export interface PaletteStage {
  name: string
  color: StageColor
  kind: StageKind
}

export interface PaletteItem {
  /** Unique and stable, so a recent can be remembered and resolved again. */
  key: string
  kind: PaletteKind
  title: string
  /** The second line, when the item has one. */
  subtitle?: string
  /** Words the item is found by beyond its title. */
  keywords?: string[]
  /** A ticket's number, for `#12` and `12`. */
  ticketId?: number
  /** A ticket's stage, for its badge. */
  stage?: PaletteStage
}

export interface PaletteGroup<T extends PaletteItem = PaletteItem> {
  kind: PaletteKind
  label: string
  items: T[]
}

const ORDER = new Map(PALETTE_KINDS.map((kind, at) => [kind, at]))

/** The query as matching works on it: trimmed, lowercased, its runs of spaces as one. */
export const normalizeQuery = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ')

/** A query that names a ticket by number, `#12` or `12`, and what is left after it. */
const TICKET_NUMBER = /^#?(\d+)(?:\s+(.+))?$/

/**
 * How well an item matches the query, or null when it does not. Higher is better.
 *
 * A ticket's exact number wins over everything else (`#12` finds #12 before a ticket whose title
 * happens to read "12"): a plain number matches a ticket's own number, then its prefix and then its
 * digits anywhere, above the text matches below. Text matches score a whole-title match first, then
 * a title starting with the query, then a word starting with it, then the query inside the title,
 * and lastly a fuzzy subsequence, penalized by the gaps it leaves.
 */
export function scoreItem(item: PaletteItem, query: string): number | null {
  const q = normalizeQuery(query)
  if (!q) return 0
  const number = TICKET_NUMBER.exec(q)
  if (number && item.ticketId !== undefined) {
    const digits = number[1]!
    if (Number(digits) === item.ticketId) {
      if (!number[2]) return 10_000
      const rest = textScore(item, number[2])
      return rest === null ? null : 10_000 + rest
    }
    const id = String(item.ticketId)
    if (id.startsWith(digits)) return 8_000 - Math.min(id.length - digits.length, 100)
    if (id.includes(digits)) return 7_000 - Math.min(id.indexOf(digits), 100)
  }
  return textScore(item, q)
}

/** The best text score over the item's title, subtitle, keywords and its own `#number`. */
function textScore(item: PaletteItem, q: string): number | null {
  // A leading hash is how a ticket is written (`#12`), not something a title or keyword has.
  const bare = q.replace(/^#/, '')
  let best: number | null = null
  const take = (score: number | null, weight = 1) => {
    if (score === null) return
    const weighted = Math.round(score * weight)
    if (best === null || weighted > best) best = weighted
  }
  // A title match beats the same word in a subtitle or a keyword: "stages" opens the Stages section
  // before a page that only lists it among the words it is found by.
  if (item.title) take(oneText(item.title, bare))
  if (item.subtitle) take(oneText(item.subtitle, bare), 0.92)
  for (const keyword of item.keywords ?? []) take(oneText(keyword, bare), 0.85)
  if (item.ticketId !== undefined) take(oneText(`#${item.ticketId}`, bare))
  return best
}

/** One text against the query: exact, prefix, word start, inside, then a fuzzy subsequence. */
function oneText(text: string, q: string): number | null {
  if (!q) return 0
  const t = text.toLowerCase()
  if (t === q) return 1_000 - 0
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 100)
  const at = t.indexOf(q)
  if (at > 0) {
    const wordStart = /[\s/._:()-]/.test(t[at - 1]!)
    return (wordStart ? 800 : 700) - Math.min(at, 100)
  }
  const gaps = subsequenceGaps(t, q)
  return gaps === null ? null : 400 - Math.min(gaps, 250)
}

/**
 * The gaps a fuzzy subsequence of `q` in `t` leaves (0 for adjacent letters), or null when `q` is
 * not a subsequence of `t`.
 */
function subsequenceGaps(t: string, q: string): number | null {
  let qi = 0
  let last = -1
  let gaps = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    if (last >= 0) gaps += ti - last - 1
    last = ti
    qi++
  }
  return qi === q.length ? gaps : null
}

/**
 * The items a query matches, in one ranked list: best match first, the kind only breaking a tie (so
 * a settings section that matches best comes before a page that only mentions the word). An empty
 * query keeps every item, grouped by kind. Generic so a caller's items keep what only it knows (how
 * to run one).
 */
export function rankItems<T extends PaletteItem>(items: readonly T[], query: string): T[] {
  const q = normalizeQuery(query)
  if (!q) return sortGrouped(items)
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = scoreItem(item, q)
    if (score !== null) scored.push({ item, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      ORDER.get(a.item.kind)! - ORDER.get(b.item.kind)! ||
      a.item.title.localeCompare(b.item.title),
  )
  return scored.map((s) => s.item)
}

function sortGrouped<T extends PaletteItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => ORDER.get(a.kind)! - ORDER.get(b.kind)! || a.title.localeCompare(b.title))
}

/**
 * The ranked items as the groups the palette draws, empty ones left out: in the order their best item
 * appears in `items`, which is kind order for an empty query and the best match's order otherwise.
 */
export function groupItems<T extends PaletteItem>(items: readonly T[]): PaletteGroup<T>[] {
  const groups = new Map<PaletteKind, T[]>()
  for (const item of items) {
    const group = groups.get(item.kind)
    if (group) group.push(item)
    else groups.set(item.kind, [item])
  }
  return [...groups.entries()].map(([kind, inKind]) => ({
    kind,
    label: PALETTE_KIND_LABEL[kind],
    items: inKind,
  }))
}
