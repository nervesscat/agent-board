import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { CalendarDays, GitPullRequest, KanbanSquare, Settings, ShieldCheck } from 'lucide-react'

import { get, type Project } from '#/lib/api'

export const Route = createFileRoute('/projects/$id')({ component: ProjectLayout })

const MODULES = [
  { to: '/projects/$id/prs', label: 'PR queue', icon: GitPullRequest },
  { to: '/projects/$id/features', label: 'Ongoing features', icon: KanbanSquare },
  { to: '/projects/$id/reviews', label: 'Reviews', icon: ShieldCheck },
  { to: '/projects/$id/daily', label: 'Daily', icon: CalendarDays },
  { to: '/projects/$id/settings', label: 'Instructions', icon: Settings },
] as const

export function useProject() {
  const { id } = Route.useParams()
  return useQuery({ queryKey: ['project', id], queryFn: () => get<Project>(`/api/projects/${id}`) })
}

function ProjectLayout() {
  const { id } = Route.useParams()
  const { data: project } = useProject()
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="md:w-52 md:shrink-0">
        <div className="mb-3 px-2">
          <div className="truncate font-semibold">{project?.name ?? '…'}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {project?.githubRepo ?? project?.repoPath}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {MODULES.map((m) => (
            <Link
              key={m.to}
              to={m.to}
              params={{ id }}
              className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              <m.icon className="size-4" /> {m.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 flex-1">
        <Outlet />
      </section>
    </div>
  )
}
