import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import {
  Bot,
  BrushCleaning,
  CalendarDays,
  FolderGit2,
  GitPullRequest,
  Home,
  KanbanSquare,
  MonitorPlay,
  Settings,
} from 'lucide-react'

import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id')({ component: ProjectLayout })

const MODULES = [
  { to: '/projects/$id', label: 'Overview', icon: Home, exact: true },
  { to: '/projects/$id/prs', label: 'PR queue', icon: GitPullRequest },
  { to: '/projects/$id/features', label: 'Ongoing features', icon: KanbanSquare },
  { to: '/projects/$id/previews', label: 'Previews', icon: MonitorPlay },
  { to: '/projects/$id/agents', label: 'Agents', icon: Bot },
  { to: '/projects/$id/daily', label: 'Daily', icon: CalendarDays },
  { to: '/projects/$id/cleanup', label: 'Cleanup', icon: BrushCleaning },
  { to: '/projects/$id/settings', label: 'Instructions', icon: Settings },
] as const

function ProjectLayout() {
  const { id } = Route.useParams()
  const { data: project } = useProject(id)
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="md:w-52 md:shrink-0">
        <div className="mb-3 px-2">
          <div className="truncate font-semibold">{project?.name ?? '…'}</div>
          <ul className="mt-1 space-y-0.5">
            {project?.repos.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground"
                title={r.repoPath}
              >
                <FolderGit2 className="size-3 shrink-0" /> {r.githubRepo ?? r.name}
              </li>
            ))}
            {project && !project.repos.length && (
              <li className="text-xs text-muted-foreground">
                No repos yet.{' '}
                <Link to="/repositories" className="underline">
                  Add one
                </Link>
              </li>
            )}
          </ul>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {MODULES.map((m) => (
            <Link
              key={m.to}
              to={m.to}
              params={{ id }}
              activeOptions={{ exact: 'exact' in m }}
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
