import { useQuery } from '@tanstack/react-query'
import { useLocation, useParams, useSearch } from '@tanstack/react-router'

import { get, type Project, type ProjectAgent, type ProjectRow } from '#/lib/api'
import { recall, remember, useRemembered } from '#/lib/remembered'
import { validateSettingsSearch } from '#/lib/settingsTabs'

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: () => get<ProjectRow[]>('/api/projects') })

/** The project this browser was last in, for an old address that names none (`/daily`). */
const CURRENT_PROJECT = 'current-project'

/** Keeps the project shown now as this browser's current one. */
export const rememberCurrentProject = (id: string | number) => remember(CURRENT_PROJECT, String(id))

/** The remembered project, when it is still one of `ids`. */
export const currentProjectId = (ids: readonly number[]): string | undefined =>
  recall(CURRENT_PROJECT, ids.map(String))

/**
 * The project the project selector shows: the one in the address (a project's page, or the project tab of
 * Settings); on Connect an agent and the Settings page, which are outside every project, the one this
 * browser was last in, while it is still a project. Undefined elsewhere: no project is selected.
 */
export function useSelectedProject(): string | undefined {
  const params = useParams({ strict: false }) as { id?: string }
  const { pathname } = useLocation()
  const search = validateSettingsSearch(useSearch({ strict: false }) as Record<string, unknown>)
  const { data: projects } = useProjects()
  const remembered = useRemembered(CURRENT_PROJECT)
  if (params.id) return params.id
  if (pathname === '/settings' && search.tab === 'project' && search.project !== undefined)
    return String(search.project)
  const keeps = pathname === '/agents' || pathname === '/settings'
  return keeps && remembered !== null && projects?.some((p) => String(p.id) === remembered)
    ? remembered
    : undefined
}

/** The remembered project, as it changes, when it is still one of `ids`. */
export function useCurrentProjectId(ids: readonly number[]): string | undefined {
  const remembered = useRemembered(CURRENT_PROJECT)
  return remembered !== null && ids.some((id) => String(id) === remembered) ? remembered : undefined
}

/** The project with its repos; every module of a project reads repo names from here. */
export const useProject = (id: string | number) =>
  useQuery({ queryKey: ['project', String(id)], queryFn: () => get<Project>(`/api/projects/${id}`) })

/** The agents of the project the page is in (from the route), for avatars and mentions anywhere under it. */
export function useProjectAgents(): ProjectAgent[] {
  const { id } = useParams({ strict: false }) as { id?: string }
  const { data } = useQuery({
    queryKey: ['project', String(id)],
    queryFn: () => get<Project>(`/api/projects/${id}`),
    enabled: Boolean(id),
  })
  return id ? (data?.agents ?? []) : []
}

/** The project agent with this name (any casing), if the page's project has one. */
export function useProjectAgent(name: string): ProjectAgent | undefined {
  const n = name.toLowerCase()
  return useProjectAgents().find((a) => a.name.toLowerCase() === n)
}

/** Repo name for a row, shown only when the project has more than one repo to tell apart. */
export function repoLabel(project: Project | undefined, repoId: number | null | undefined): string | null {
  if (!project || project.repos.length < 2) return null
  return project.repos.find((r) => r.id === repoId)?.name ?? null
}

/** The project's stages in board order; empty until the project has loaded. */
export const useStages = (id: string | number) => useProject(id).data?.stages ?? []
