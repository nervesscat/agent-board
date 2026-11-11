/**
 * Actor names as the board shows them. An agent that works under another is named `parent/leaf`
 * (`orch/builder-1`, `opencode/builder-832`): the leaf is the name it works as, the parent the name it
 * works under. A label shows the leaf and puts the parent quietly before it (or leaves it to the
 * tooltip), and a name too long for its place is cut at a word boundary instead of mid-word.
 */

/** A name's parts: the leaf it works as, and the parent it works under (null for a top-level name). */
export type NameParts = { parent: string | null; leaf: string }

/** Split `orch/builder-1` into its parent `orch` and its leaf `builder-1`; a plain name has no parent. */
export function nameParts(name: string): NameParts {
  const slash = name.lastIndexOf('/')
  if (slash <= 0 || slash === name.length - 1) return { parent: null, leaf: name }
  return { parent: name.slice(0, slash), leaf: name.slice(slash + 1) }
}

/** Where a name may be cut: between words (`-`, `_`, `.`, a space) or between path parts. */
const BOUNDARY = /[-_.\s/]/

/**
 * `text` cut to `max` characters with an ellipsis, at the last word boundary that keeps a readable
 * start (at least half of `max`); only a name that is one long word is cut inside it.
 */
export function truncateName(text: string, max = 20): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  let at = -1
  for (let i = cut.length - 1; i >= Math.floor(max / 2); i--) {
    if (BOUNDARY.test(cut[i]!)) {
      at = i
      break
    }
  }
  return `${(at > 0 ? cut.slice(0, at) : cut).replace(/[-_.\s/]+$/, '')}…`
}

/** A row's label: the leaf of a sub-identity (`builder-832` for `opencode/builder-832`), cut cleanly when long. */
export function shortName(name: string, max = 20): string {
  if (!name) return 'unnamed'
  return truncateName(nameParts(name).leaf, max)
}

/** The quiet prefix before a leaf: the parent's own leaf, cut cleanly (`opencode` for `opencode/builder-832`). */
export function parentName(parent: string | null | undefined, max = 12): string {
  if (!parent) return ''
  return truncateName(nameParts(parent).leaf, max)
}
