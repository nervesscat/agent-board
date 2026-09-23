import { useQuery } from '@tanstack/react-query'

import { get, type Project } from '#/lib/api'

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: () => get<Project[]>('/api/projects') })

/** The project with its repos; every module of a project reads repo names from here. */
export const useProject = (id: string | number) =>
  useQuery({ queryKey: ['project', String(id)], queryFn: () => get<Project>(`/api/projects/${id}`) })

/** Repo name for a row, shown only when the project has more than one repo to tell apart. */
export function repoLabel(project: Project | undefined, repoId: number | null | undefined): string | null {
  if (!project || project.repos.length < 2) return null
  return project.repos.find((r) => r.id === repoId)?.name ?? null
}
