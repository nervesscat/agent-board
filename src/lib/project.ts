import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'

import { get, type Project, type ProjectAgent, type ProjectRow } from '#/lib/api'

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: () => get<ProjectRow[]>('/api/projects') })

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
