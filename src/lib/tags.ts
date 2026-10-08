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
