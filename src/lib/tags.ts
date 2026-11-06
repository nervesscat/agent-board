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

/**
 * The chips offered under a tags field: the project's suggestions, then the tags its tickets carry
 * (most used first), each once in any casing, and none already in `value`. A suggestion the tickets
 * already carry in another casing is offered in theirs.
 */
export function tagChoices(
  suggestions: readonly string[],
  used: readonly string[],
  value: readonly string[],
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
  return out
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

/** The tags whose name holds `query` (trimmed) in any casing, in their order; all of them for none. */
export function matchTags(tags: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  return q ? tags.filter((t) => t.toLowerCase().includes(q)) : [...tags]
}
