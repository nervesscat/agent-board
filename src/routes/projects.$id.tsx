import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { LAYOUT_ICONS } from '#/components/layoutIcons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { visibleNavPages } from '#/lib/kinds'
import { type AreaId, defaultLayout, layoutElement, shownIn } from '#/lib/layout'
import { rememberCurrentProject, useProject } from '#/lib/project'
import { projectTabSearch } from '#/lib/settingsTabs'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/projects/$id')({ component: ProjectLayout })

/**
 * Where each page of the project's menu goes (Settings is the Settings page, on this project's tab). Which pages show, in what order, with what label and
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
  'nav.runReports': '/projects/$id/run-reports',
  'nav.daily': '/projects/$id/daily',
  'nav.cleanup': '/projects/$id/cleanup',
  'nav.repositories': '/projects/$id/repositories',
  'nav.instructions': '/projects/$id/instructions',
  'nav.settings': '/settings',
} as const satisfies Record<AreaId<'nav'>, string>

function ProjectLayout() {
  const { id } = Route.useParams()
  const navigate = Route.useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data } = useProject(id)
  // Read after mount: the project may answer before React has hydrated this page, and a sidebar drawn
  // from it would not match the one the server sent (which had no project yet).
  const hydrated = useHydrated()
  // The defaults until the project has loaded.
  const project = hydrated ? data : undefined
  // A link that names no project (the old `/daily`) opens this one.
  useEffect(() => rememberCurrentProject(id), [id])
  // A project with no software kind has no git side: its git pages are hidden whatever its layout says.
  const pages = visibleNavPages(shownIn(project?.layout ?? defaultLayout(), 'nav'), project?.kinds)
  // The page the URL is on, for the phone-sized picker. The Overview's URL starts every other page's.
  const current =
    pages.find((page) => {
      const to = MODULES[page].replace('$id', id)
      return page === 'nav.overview' ? pathname === to : pathname.startsWith(to)
    }) ?? pages[0]
  const pageItems = Object.fromEntries(pages.map((page) => [page, layoutElement(page).label]))
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      {/* From md up the sidebar sticks below the sticky header (3rem + its 1px border) and main's
          1.5rem top padding, and scrolls on its own when taller than the window. The page itself
          keeps scrolling (not the content pane), so the header, other sticky bars and the
          browser's scroll restoration keep working as on every other page. */}
      <aside className="md:sticky md:top-[calc(4.5rem+1px+env(safe-area-inset-top))] md:max-h-[calc(100vh-6rem-1px-env(safe-area-inset-top))] md:w-52 md:shrink-0 md:self-start md:overflow-y-auto">
        {pages.length > 0 && current && (
          <div className="mb-2 px-2 md:hidden">
            <Select
              value={current}
              onValueChange={(v) =>
                v === 'nav.settings'
                  ? navigate({ to: '/settings', search: projectTabSearch(id) })
                  : v &&
                    navigate({ to: MODULES[v as Exclude<AreaId<'nav'>, 'nav.settings'>], params: { id } })
              }
              items={pageItems}
            >
              <SelectTrigger className="w-full" aria-label="Project page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pages.map((page) => (
                  <SelectItem key={page} value={page}>
                    {layoutElement(page).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <nav className="hidden gap-1 md:flex md:flex-col">
          {pages.map((page) => {
            const Icon = LAYOUT_ICONS[page]
            return (
              <Link
                key={page}
                {...(page === 'nav.settings'
                  ? { to: '/settings', search: projectTabSearch(id) }
                  : { to: MODULES[page], params: { id } })}
                // The Overview's URL starts every other page's.
                activeOptions={{ exact: page === 'nav.overview' }}
                // The ring is inset: the aside is the scroll container (its overflow-x becomes auto with
                // overflow-y), so an outline drawn outside the link would be cut at its edge.
                className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&.active]:bg-muted [&.active]:text-foreground"
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
