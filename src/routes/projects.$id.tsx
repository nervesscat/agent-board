import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { PanelLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { cn } from 'cn'

import { LAYOUT_ICONS } from '#/components/layoutIcons'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { type AreaId, defaultLayout, layoutElement, shownIn } from '#/lib/layout'
import { rememberCurrentProject, useProject } from '#/lib/project'
import { SIDEBAR_TOGGLE_LABEL, nextSidebarMode, useSidebarMode } from '#/lib/sidebar'
import { useHydrated } from '#/lib/useHydrated'

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
  'nav.runReports': '/projects/$id/run-reports',
  'nav.daily': '/projects/$id/daily',
  'nav.cleanup': '/projects/$id/cleanup',
  'nav.repositories': '/projects/$id/repositories',
  'nav.instructions': '/projects/$id/instructions',
  'nav.settings': '/projects/$id/settings',
} as const satisfies Record<AreaId<'nav'>, string>

/** The toggle's icon: the sidebar as it is now, and what the next press shows. */
const TOGGLE_ICON = { expanded: PanelLeftClose, shrunk: PanelLeft, hidden: PanelLeftOpen } as const

/** How long a hidden sidebar stays open after the mouse leaves it, so a small move off its edge does not close it. */
const PEEK_CLOSE_MS = 250

/** The sidebar's place under the sticky header, shared by the sidebar and the toggle column beside it. */
const STICKY_TOP = 'md:top-[calc(4.5rem+1px+env(safe-area-inset-top))]'

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
  const [mode, chooseMode] = useSidebarMode()
  // A hidden sidebar shown over the page while the mouse is on its edge (desktop only).
  const [peeking, setPeeking] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const asideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  // A press moves the toggle to another place when the mode crosses 'hidden' (the sidebar's row, or the column
  // beside it), so the button that was pressed unmounts: the one that replaces it takes the focus.
  const focusToggleAfterChange = useRef(false)
  useEffect(() => {
    if (!focusToggleAfterChange.current) return
    focusToggleAfterChange.current = false
    toggleRef.current?.focus()
  }, [mode])
  // A link was clicked in this peek. Some browsers (Safari) do not focus a link on a mouse click, so focus
  // may be on the page body although the click was in the sidebar.
  const linkClickedInPeek = useRef(false)
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  const openPeek = () => {
    window.clearTimeout(closeTimer.current)
    linkClickedInPeek.current = false
    setPeeking(true)
  }
  const closePeekSoon = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      // A link clicked in the peeked sidebar holds focus; hiding the sidebar would drop it to the page body,
      // so the toggle that shows the sidebar again takes it first. The same holds when the click did not
      // focus the link and focus is on the body.
      const active = document.activeElement
      const onBody = active === null || active === document.body
      if (asideRef.current?.contains(active) || (linkClickedInPeek.current && onBody))
        toggleRef.current?.focus()
      linkClickedInPeek.current = false
      setPeeking(false)
    }, PEEK_CLOSE_MS)
  }
  const hiddenNow = mode === 'hidden'
  const shrunk = mode === 'shrunk'
  const showPeek = hiddenNow && peeking
  const pages = shownIn(project?.layout ?? defaultLayout(), 'nav')
  // The page the URL is on, for the phone-sized picker. The Overview's URL starts every other page's.
  const current =
    pages.find((page) => {
      const to = MODULES[page].replace('$id', id)
      return page === 'nav.overview' ? pathname === to : pathname.startsWith(to)
    }) ?? pages[0]
  const pageItems = Object.fromEntries(pages.map((page) => [page, layoutElement(page).label]))
  const ToggleIcon = TOGGLE_ICON[mode]
  // The one toggle, rendered in one place only: the first row of the sidebar, or while the sidebar is hidden,
  // the column beside it.
  const toggle = (
    <Tip content={SIDEBAR_TOGGLE_LABEL[mode]}>
      <Button
        ref={toggleRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={SIDEBAR_TOGGLE_LABEL[mode]}
        onClick={() => {
          setPeeking(false)
          focusToggleAfterChange.current = true
          chooseMode(nextSidebarMode(mode))
        }}
      >
        <ToggleIcon className="size-4" />
      </Button>
    </Tip>
  )
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      {/* While the sidebar is hidden the toggle has its own column at the left edge, above the strip that shows
          the sidebar, so it stays reachable. Desktop only: the phone layout has no toggle. */}
      {hiddenNow && (
        <div
          className={cn(
            'hidden md:sticky md:z-40 md:flex md:w-8 md:shrink-0 md:justify-center md:self-start',
            STICKY_TOP,
          )}
        >
          {toggle}
        </div>
      )}
      {/* From md up the sidebar sticks below the sticky header (3rem + its 1px border) and main's
          1.5rem top padding, and scrolls on its own when taller than the window. The page itself
          keeps scrolling (not the content pane), so the header, other sticky bars and the
          browser's scroll restoration keep working as on every other page. */}
      <aside
        ref={asideRef}
        onMouseEnter={hiddenNow ? openPeek : undefined}
        onMouseLeave={hiddenNow ? closePeekSoon : undefined}
        onClickCapture={(event) => {
          if (hiddenNow && event.target instanceof Element && event.target.closest('a'))
            linkClickedInPeek.current = true
        }}
        className={cn(
          'md:max-h-[calc(100vh-6rem-1px-env(safe-area-inset-top))] md:self-start md:overflow-y-auto',
          STICKY_TOP,
          mode === 'expanded' && 'md:sticky md:w-52 md:shrink-0',
          shrunk && 'md:sticky md:w-14 md:shrink-0',
          // Hidden: out of the page's layout, unless the mouse has shown it over the page.
          hiddenNow && !showPeek && 'md:hidden',
          showPeek && 'md:fixed md:left-0 md:z-40 md:w-52 md:bg-background md:shadow-lg',
        )}
      >
        {/* Expanded and shrunk: the toggle is the sidebar's first row, above Overview, right-aligned when
            expanded and centred when shrunk. Desktop only. */}
        {!hiddenNow && (
          <div className={cn('mb-1 hidden md:flex', shrunk ? 'md:justify-center' : 'md:justify-end')}>
            {toggle}
          </div>
        )}
        {pages.length > 0 && current && (
          <div className="mb-2 px-2 md:hidden">
            <Select
              value={current}
              onValueChange={(v) => v && navigate({ to: MODULES[v as AreaId<'nav'>], params: { id } })}
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
            const label = layoutElement(page).label
            const link = (
              <Link
                to={MODULES[page]}
                params={{ id }}
                // The Overview's URL starts every other page's.
                activeOptions={{ exact: page === 'nav.overview' }}
                // The ring is inset: the aside is the scroll container (its overflow-x becomes auto with
                // overflow-y), so an outline drawn outside the link would be cut at its edge.
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&.active]:bg-muted [&.active]:text-foreground',
                  shrunk && 'md:justify-center md:px-0',
                )}
              >
                <Icon className="size-4" />
                {/* Shrunk: the label is for screen readers only; its tooltip shows it on hover and focus. */}
                <span className={cn(shrunk && 'md:sr-only')}>{label}</span>
              </Link>
            )
            return shrunk ? (
              <Tip key={page} content={label}>
                {link}
              </Tip>
            ) : (
              <Fragment key={page}>{link}</Fragment>
            )
          })}
        </nav>
      </aside>
      {hiddenNow && (
        // The strip along the left border, about 40px wide, where the mouse shows the hidden sidebar. Desktop only.
        // It sits under the toggle column (z-40), so the toggle stays clickable above it.
        <div
          aria-hidden="true"
          onMouseEnter={openPeek}
          // Leaving the strip closes it too: the sidebar can appear under a resting pointer, which then sends no
          // enter to it, and moving into the sidebar opens it again (cancelling this close).
          onMouseLeave={closePeekSoon}
          className={cn(
            'fixed bottom-0 left-0 z-30 hidden w-10 md:block',
            'top-[calc(4.5rem+1px+env(safe-area-inset-top))]',
          )}
        />
      )}
      <section className="min-w-0 flex-1">
        <Outlet />
      </section>
    </div>
  )
}
