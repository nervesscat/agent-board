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
