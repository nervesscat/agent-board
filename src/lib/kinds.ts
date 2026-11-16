/**
 * What a project is for. Every project lists one or more kinds. Software is the kind a project has
 * always had: repositories, branches, PRs, CI, previews and review rounds over a diff. The other
 * kinds keep their work out of git, so the git side is hidden for a project none of whose kinds is
 * software, and the rest of the board (tickets, stages, agents, the gallery) works as before.
 */
export const KINDS = ['software', 'music', 'art', 'writing', 'video', 'research'] as const

export type Kind = (typeof KINDS)[number]

export const KIND_LABELS: Record<Kind, string> = {
  software: 'Software',
  music: 'Music',
  art: 'Art',
  writing: 'Writing',
  video: 'Video',
  research: 'Research',
}

/** Every project starts as software: that is what all existing projects are. */
export const DEFAULT_KINDS: readonly Kind[] = ['software']

/** The menu pages that only make sense with git. Hidden for a project with no software kind. */
export const GIT_SIDE_PAGES = ['nav.prs', 'nav.previews', 'nav.cleanup', 'nav.repositories'] as const

/**
 * The top-level phases a ticket of a project with no software kind starts with: the work, then its
 * summary. The git phases (Pushed, PR, CI, Preview, Merged) are facts the board reads from git, so a
 * project without git has none of them.
 */
export const NON_SOFTWARE_PHASES: readonly string[] = ['Implementation', 'Summary']

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** The kinds a project lists, in the order KINDS gives them, each once. Null when none is valid. */
export function cleanKinds(kinds: readonly string[]): Kind[] | null {
  const valid = KINDS.filter((k) => kinds.includes(k))
  return valid.length > 0 ? valid : null
}

/** Whether the project's git side shows: any of its kinds is software. */
export function hasGitSide(kinds: readonly string[] | null | undefined): boolean {
  return (kinds ?? DEFAULT_KINDS).includes('software')
}

/**
 * The default phases a project's kinds imply, or null for the built-in list. A project with software
 * among its kinds keeps the built-in list; one with only other kinds gets the non-software preset.
 */
export function presetPhases(kinds: readonly string[] | null | undefined): string[] | null {
  return hasGitSide(kinds) ? null : [...NON_SOFTWARE_PHASES]
}

/** Keeps the menu pages a project shows: its git-side pages only when it has a software kind. */
export function visibleNavPages<T extends string>(
  pages: readonly T[],
  kinds: readonly string[] | null | undefined,
): T[] {
  if (hasGitSide(kinds)) return [...pages]
  const hidden = new Set<string>(GIT_SIDE_PAGES)
  return pages.filter((page) => !hidden.has(page))
}

/** The kinds after a click on one of them: added in KINDS order, or removed, but never the last one. */
export function toggleKind(kinds: readonly Kind[], kind: Kind): Kind[] {
  if (kinds.includes(kind)) return kinds.length > 1 ? kinds.filter((k) => k !== kind) : [...kinds]
  return KINDS.filter((k) => k === kind || kinds.includes(k))
}
