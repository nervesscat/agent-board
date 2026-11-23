import { type AreaId, layoutElement } from '#/lib/layout'

/**
 * Settings and Connect an agent are outside every project. The back button on them returns to the page
 * of the selected project this browser was last on: it is kept here, by the project's own pages, as the
 * address they were opened at (its path, search and #hash, as the router has them).
 */
export const LAST_MODULE = 'last-module'

/** An address inside the router: what `Link` takes as `to`, `search` and `hash`. */
export interface ModuleLocation {
  pathname: string
  search: Record<string, unknown>
  hash: string
}

/** The project's pages by their path segment after `/projects/<id>/` ('' is the Overview). */
const SEGMENTS: Record<string, AreaId<'nav'>> = {
  '': 'nav.overview',
  prs: 'nav.prs',
  features: 'nav.features',
  roadmap: 'nav.roadmap',
  previews: 'nav.previews',
  gallery: 'nav.gallery',
  agents: 'nav.agents',
  daily: 'nav.daily',
  cleanup: 'nav.cleanup',
  repositories: 'nav.repositories',
  instructions: 'nav.instructions',
}

/**
 * The project and the page of a project address, or undefined for an address that is no page to come
 * back to (`/projects/<id>/settings` only redirects to the Settings page).
 */
export function moduleOf(pathname: string): { project: string; page: AreaId<'nav'> } | undefined {
  const match = /^\/projects\/(\d+)(?:\/([^/]+))?(?:\/.*)?$/.exec(pathname)
  if (!match) return undefined
  const page = SEGMENTS[match[2] ?? '']
  return page ? { project: match[1]!, page } : undefined
}

/** What the project's pages keep: the address, or undefined when it is not one of a project's pages. */
export function encodeModule(location: ModuleLocation): string | undefined {
  if (!moduleOf(location.pathname)) return undefined
  return JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash })
}

function decodeModule(saved: string | null | undefined): ModuleLocation | undefined {
  if (!saved) return undefined
  try {
    const value: unknown = JSON.parse(saved)
    if (typeof value !== 'object' || value === null) return undefined
    const { pathname, search, hash } = value as Record<string, unknown>
    if (typeof pathname !== 'string' || typeof hash !== 'string') return undefined
    if (typeof search !== 'object' || search === null || Array.isArray(search)) return undefined
    return { pathname, search: search as Record<string, unknown>, hash }
  } catch {
    return undefined
  }
}

/** Where the back button goes, in the terms of `Link`, and what it says. */
export interface BackTarget {
  to: string
  params?: { id: string }
  search?: Record<string, unknown>
  hash?: string
  /** The page it goes to: the button reads "Back to <label>". */
  label: string
}

/**
 * Where the back button goes from Settings or Connect: to the page of `project` (the one in the project
 * selector) the project's pages last kept, with its search and #hash; to the Overview of `project` when
 * they last kept a page of another project (the selector was changed on the way) or none; to Home with no
 * project selected, the board's start page.
 */
export function backTarget(project: string | undefined, saved: string | null | undefined): BackTarget {
  if (project === undefined) return { to: '/', label: 'Home' }
  const last = decodeModule(saved)
  const at = last && moduleOf(last.pathname)
  if (last && at && at.project === project)
    return {
      to: last.pathname,
      search: last.search,
      hash: last.hash || undefined,
      label: layoutElement(at.page).label,
    }
  return { to: '/projects/$id', params: { id: project }, label: layoutElement('nav.overview').label }
}
