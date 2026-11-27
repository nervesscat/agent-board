/**
 * The Settings page has two tabs: the board's own settings and those of one project. This is what the
 * page's address says about them, and which tab shows given that address, the project this browser was
 * last in and the projects there are.
 */

export type SettingsTab = 'board' | 'project'

export interface SettingsSearch {
  tab?: SettingsTab
  /** The project of the project tab. */
  project?: number
}

/** The ids of each tab's sections, in page order: the one list that says which tab a link's #hash is on. */
export const SETTINGS_SECTIONS: Record<SettingsTab, readonly string[]> = {
  board: ['default-agent', 'theme', 'language', 'previews', 'updates', 'agent-roles', 'tailnet', 'devices'],
  project: [
    'kinds',
    'default-phases',
    'tag-suggestions',
    'stalled-tickets',
    'waiting-too-long',
    'notifications',
    'stages',
    'runs',
    'layout',
    // Not a section here any more: an old link into it is sent to the Instructions page by the project tab.
    'instructions-history',
  ],
}

/** The tab that has the section with this id, if any tab does. */
export function tabOwning(hash: string): SettingsTab | undefined {
  return (['board', 'project'] as const).find((tab) => SETTINGS_SECTIONS[tab].includes(hash))
}

/** A project id as the address can carry it: a whole number from 1 (`project=12`, or the text "12"). */
function projectOf(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** The address's search, anything else dropped. */
export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const tab = search.tab === 'board' || search.tab === 'project' ? search.tab : undefined
  const project = projectOf(search.project)
  return {
    ...(tab ? { tab } : {}),
    ...(project !== undefined ? { project } : {}),
  }
}

/** The search that opens the project tab of a project. */
export const projectTabSearch = (project: number | string): SettingsSearch => ({
  tab: 'project',
  project: projectOf(project),
})

export interface ResolvedSettings {
  tab: SettingsTab
  /** The project of the project tab; null when there is none, and the tab is not offered. */
  project: number | null
  /** The search the address should have instead of the one it has (replacing it), or null when it is right. */
  correct: SettingsSearch | null
  /** Set when the correction also drops the #hash: a section of a project the address names but is not there. */
  dropHash?: true
}

/**
 * Which tab shows. The project is the address's when it is one of `projectIds`, else (when the address
 * names none) the remembered one. A section of the other tab's in the #hash opens that tab when it is
 * there. The project tab without a project falls back to the board's. An address that names a project
 * that is not there never opens another project's tab: a project section in its #hash is dropped too.
 */
export function resolveSettings(
  search: SettingsSearch,
  hash: string,
  remembered: number | undefined,
  projectIds: readonly number[],
): ResolvedSettings {
  const known = (id: number | undefined) => (id !== undefined && projectIds.includes(id) ? id : undefined)
  const project = search.project !== undefined ? (known(search.project) ?? null) : (known(remembered) ?? null)
  const wanted = tabOwning(hash) ?? search.tab ?? 'board'
  const tab: SettingsTab = wanted === 'project' && project !== null ? 'project' : 'board'
  const right: SettingsSearch =
    tab === 'project'
      ? { tab: 'project', project: project ?? undefined }
      : search.tab === 'board'
        ? { tab }
        : {}
  const same = search.tab === right.tab && search.project === right.project
  const dropHash =
    search.project !== undefined && project === null && tabOwning(hash) === 'project' ? true : undefined
  return { tab, project, correct: same ? null : right, ...(dropHash ? { dropHash } : {}) }
}
