import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'

import { PushedTodayBadge } from '#/components/daily/PushedToday'
import { LAYOUT_ICONS } from '#/components/layoutIcons'
import { Tip } from '#/components/ui/tooltip'
import { type AreaId, defaultLayout, layoutElement, shownIn } from '#/lib/layout'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id')({ component: ProjectLayout })

/**
 * Where each page of the project's menu goes. Which pages show, in what order, with what label and
 * icon is the project's layout (`#/lib/layout`); a hidden page still opens by its URL.
 */
const MODULES = {
  'nav.overview': '/projects/$id',
  'nav.prs': '/projects/$id/prs',
  'nav.features': '/projects/$id/features',
  'nav.roadmap': '/projects/$id/roadmap',
  'nav.previews': '/projects/$id/previews',
  'nav.gallery': '/projects/$id/gallery',
  'nav.agents': '/projects/$id/agents',
  'nav.daily': '/projects/$id/daily',
  'nav.cleanup': '/projects/$id/cleanup',
  'nav.settings': '/projects/$id/settings',
} as const satisfies Record<AreaId<'nav'>, string>

function ProjectLayout() {
  const { id } = Route.useParams()
  const { data: project } = useProject(id)
  // The defaults until the project has loaded.
  const pages = shownIn(project?.layout ?? defaultLayout(), 'nav')
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="md:w-52 md:shrink-0">
        <div className="mb-3 px-2">
          <div className="truncate font-semibold">{project?.name ?? '…'}</div>
          <PushedTodayBadge projectId={Number(id)} compact />
          <ul className="mt-1 space-y-0.5">
            {project?.repos.map((r) => (
              <Tip key={r.id} content={r.repoPath}>
                <li className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
                  <FolderGit2 className="size-3 shrink-0" /> {r.githubRepo ?? r.name}
                </li>
              </Tip>
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
          {pages.map((page) => {
            const Icon = LAYOUT_ICONS[page]
            return (
              <Link
                key={page}
                to={MODULES[page]}
                params={{ id }}
                // The Overview's URL starts every other page's.
                activeOptions={{ exact: page === 'nav.overview' }}
                className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
              >
                <Icon className="size-4" /> {layoutElement(page).label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <section className="min-w-0 flex-1">
        <Outlet />
      </section>
    </div>
  )
}
