/** The most tags a ticket takes, and the most characters in one: the server refuses more. */
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/** A tag as the server keeps it: runs of whitespace made one space, trimmed. */
export const normalizeTag = (raw: string) => raw.replace(/\s+/g, ' ').trim()

/**
 * `tags` with each comma-separated part of `text` added after them, in order. Empty parts are left
 * out, and so is a tag already there in any casing: the first one keeps its casing, as the server
 * does.
 */
export function addTags(tags: string[], text: string): string[] {
  const seen = new Set(tags.map((t) => t.toLowerCase()))
  const out = [...tags]
  for (const part of text.split(',')) {
    const tag = normalizeTag(part)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out
}

/** Whether a tag (as kept) is longer than the server takes, counted as its `.max` counts. */
export const tagTooLong = (tag: string) => tag.length > MAX_TAG_LENGTH

/**
 * Which of the server's limits the tags go over, counted on what a form sends: `tags` with `text`
 * added (`addTags`), so a repeat or extra whitespace does not count.
 */
export function overTagLimits(tags: string[], text = '') {
  const sent = addTags(tags, text)
  return { tooMany: sent.length > MAX_TAGS, tooLong: sent.some(tagTooLong) }
}

/** The tags a project offers when it keeps no list of its own (and what a new project starts with). */
export const DEFAULT_TAG_SUGGESTIONS: readonly string[] = ['Bug', 'UI', 'Implementation', 'Report']

/**
 * The tags the tickets carry, most used first, each once: in the casing used most (the first seen on
 * a tie), so that a chip offers the one to reuse.
 */
export function usedTags(lists: string[][]): string[] {
  const byKey = new Map<string, { count: number; casings: Map<string, number> }>()
  for (const tags of lists)
    for (const tag of tags) {
      const key = tag.toLowerCase()
      const entry = byKey.get(key) ?? { count: 0, casings: new Map() }
      entry.count++
      entry.casings.set(tag, (entry.casings.get(tag) ?? 0) + 1)
      byKey.set(key, entry)
    }
  return [...byKey.values()]
    .map((e, i) => ({ ...e, i, tag: [...e.casings].reduce((a, b) => (b[1] > a[1] ? b : a))[0] }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .map((e) => e.tag)
}

/** How far back a ticket's update counts as recent use of its tags. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How many of the tickets updated in the week before `now` (created counts, a new ticket being updated
 * when made) carry each tag, keyed by `'#' + the tag in lower case`: each ticket once per tag. `updatedAt` is
 * the ISO text the database keeps, compared as text.
 */
export function recentTagCounts(
  tickets: readonly { tags: readonly string[]; updatedAt: string }[],
  now: Date,
): Record<string, number> {
  const since = new Date(now.getTime() - RECENT_MS).toISOString()
  const counts: Record<string, number> = Object.create(null)
  for (const ticket of tickets) {
    if (ticket.updatedAt < since) continue
    // The prefix: a key such as `__proto__` does not survive a plain object copy, and this record is
    // copied on the client (TanStack Query's structural sharing drops it), so no tag name is used bare.
    for (const key of new Set(ticket.tags.map((tag) => '#' + tag.toLowerCase())))
      counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * The chips offered under a tags field: the project's suggestions, then the tags its tickets carry,
 * each once in any casing, and none already in `value`. A suggestion the tickets already carry in
 * another casing is offered in theirs. The chips go most used in the last week first (`recent`, as
 * `recentTagCounts`), ties and tags not used lately by name, case-insensitive.
 */
export function tagChoices(
  suggestions: readonly string[],
  used: readonly string[],
  value: readonly string[],
  recent: Readonly<Record<string, number>> = {},
) {
  const usedCasing = new Map(used.map((t) => [t.toLowerCase(), t]))
  const taken = new Set(value.map((t) => t.toLowerCase()))
  const out: string[] = []
  for (const raw of [...suggestions, ...used]) {
    const tag = usedCasing.get(raw.toLowerCase()) ?? raw
    if (taken.has(tag.toLowerCase())) continue
    taken.add(tag.toLowerCase())
    out.push(tag)
  }
  // Not `recent[tag]` alone: `constructor` and the like are on every plain object.
  const weekOf = (tag: string) => {
    const n = recent['#' + tag.toLowerCase()]
    return typeof n === 'number' ? n : 0
  }
  return out.sort((a, b) => weekOf(b) - weekOf(a) || a.toLowerCase().localeCompare(b.toLowerCase()))
}

/** `suggestions` as kept: trimmed, whitespace runs made one space, blanks and repeats in any casing left out. */
export function cleanSuggestions(suggestions: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of suggestions) {
    const tag = normalizeTag(raw)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out
}

/**
 * A name as matched: accents removed, lower case. toLowerCase writes a capital sigma at the end of a
 * word as the final form ς, so that is made σ too: `ΟΔΟΣ` and `οδοσ` then fold the same.
 */
const foldTag = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')

/** Whether the characters of `query` appear in `name` in their order, not necessarily next to each other. */
function holdsInOrder(query: string, name: string) {
  const want = [...query]
  let at = 0
  for (const ch of name) if (ch === want[at]) at++
  return at === want.length
}

/**
 * The tags the typed `query` soft-matches: its letters in the tag's name in order, not as a prefix or
 * a whole (`rdm` holds in Roadmap, `ogfe` in Ongoing features), with case and accents set aside.
 * `query` is trimmed; none (empty or blank) is all of them, in their order. A query of only accents
 * (marks with no letter) is not none: it matches no tag.
 */
export function matchTags(tags: readonly string[], query: string): string[] {
  const typed = query.trim()
  if (!typed) return [...tags]
  const q = foldTag(typed)
  return q ? tags.filter((t) => holdsInOrder(q, foldTag(t))) : []
}
