import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router'
import { PanelLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { cn } from 'cn'

import { LAYOUT_ICONS } from '#/components/layoutIcons'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { visibleNavPages } from '#/lib/kinds'
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

/** The sidebar's place under the sticky header. */
const STICKY_TOP = 'md:top-[calc(4.5rem+1px+env(safe-area-inset-top))]'

/**
 * How far left a hidden sidebar rests: its own width plus the page's left margin (the main column is centred
 * up to 80rem with 1rem of padding, and the sidebar starts there), so it is fully outside the window and slides
 * in from the left edge to its place in the page.
 */
const HIDDEN_SHIFT = 'md:-translate-x-[calc(100%+max(1rem,(100vw-80rem)/2+1rem)+1px)]'

/** The slide's length and easing; the transitions themselves are `motion-safe`, so reduced motion changes at once. */
const SLIDE = 'md:motion-safe:duration-200 md:motion-safe:ease-out'

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
  const [mode, chooseMode, modeReady] = useSidebarMode()
  // Slides are on once the remembered mode is showing (and two frames have painted): a returning visitor
  // whose sidebar is hidden sees it hidden, not sliding away.
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    if (!modeReady) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAnimated(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [modeReady])
  // A hidden sidebar shown in its place (the page makes room) while the mouse is near its edge (desktop only).
  const [peeking, setPeeking] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const asideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
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
      // The sidebar slid in under a pointer that was resting on the edge strip (no move, so no enter reached it):
      // the pointer is on it, so it stays.
      if (asideRef.current?.matches(':hover')) return
      // A link clicked in the peeked sidebar holds focus; hiding the sidebar would drop it to the page body,
      // so the toggle (inside the sidebar, and the one thing in it that stays reachable by keyboard while it
      // is hidden) takes it first. The same holds when the click did not focus the link and focus is on the body.
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
  // A project with no software kind has no git side: its git pages are hidden whatever its layout says.
  const pages = visibleNavPages(shownIn(project?.layout ?? defaultLayout(), 'nav'), project?.kinds)
  // The page the URL is on, for the phone-sized picker. The Overview's URL starts every other page's.
  const current =
    pages.find((page) => {
      const to = MODULES[page].replace('$id', id)
      return page === 'nav.overview' ? pathname === to : pathname.startsWith(to)
    }) ?? pages[0]
  const pageItems = Object.fromEntries(pages.map((page) => [page, layoutElement(page).label]))
  const ToggleIcon = TOGGLE_ICON[mode]
  // The one toggle, inside the sidebar (its first row), so it goes where the sidebar goes: hidden with it, back
  // with it when the pointer comes near.
  const toggle = (
    <Tip content={SIDEBAR_TOGGLE_LABEL[mode]}>
      <Button
        ref={toggleRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={SIDEBAR_TOGGLE_LABEL[mode]}
        onClick={(event) => {
          const next = nextSidebarMode(mode)
          // Pressed by keyboard into hidden (no pointer click: detail is 0, and the toggle holds focus): the sidebar
          // stays shown around it until focus moves away, instead of leaving focus on a toggle nobody sees. A pointer
          // press hides it, and the pointer resting on it does not show it again; neither does a script's click, which
          // has no focus that would later leave and close it.
          setPeeking(
            next === 'hidden' && event.detail === 0 && document.activeElement === event.currentTarget,
          )
          chooseMode(next)
        }}
      >
        <ToggleIcon className="size-4" />
      </Button>
    </Tip>
  )
  const slide = animated && SLIDE
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-0">
      {/* From md up the sidebar sticks below the sticky header (3rem + its 1px border) and main's
          1.5rem top padding, and scrolls on its own when taller than the window. The page itself
          keeps scrolling (not the content pane), so the header, other sticky bars and the
          browser's scroll restoration keep working as on every other page.
          The wrapper is the sidebar's place in the page: its width slides between expanded, shrunk
          and hidden (none), and the page follows. The sidebar itself is always the same one: hidden, it
          rests outside the window on the left; while the mouse is near, the wrapper opens to the expanded
          width (the page moves right) and the sidebar slides in to its place, as in the expanded mode. */}
      <div
        className={cn(
          'md:sticky md:self-start md:shrink-0',
          STICKY_TOP,
          animated && 'md:motion-safe:transition-[width,margin]',
          slide,
          mode === 'expanded' && 'md:mr-6 md:w-52',
          shrunk && 'md:mr-6 md:w-14',
          hiddenNow && (showPeek ? 'md:mr-6 md:w-52' : 'md:mr-0 md:w-0'),
        )}
      >
        <aside
          ref={asideRef}
          onMouseEnter={hiddenNow ? openPeek : undefined}
          onMouseLeave={hiddenNow ? closePeekSoon : undefined}
          // A hidden sidebar is out of the window and its links are out of the tab order; only its toggle can take
          // focus, and focusing it shows the sidebar, so the keyboard reaches it again. It closes when focus leaves.
          onFocus={hiddenNow ? openPeek : undefined}
          onBlur={
            hiddenNow
              ? (event) => {
                  // Focus left for something outside the sidebar. Not when it fell to the page body because of a
                  // click on the sidebar's own blank space: the pointer is still in it, and it stays open.
                  if (
                    !event.currentTarget.contains(event.relatedTarget) &&
                    !event.currentTarget.matches(':hover')
                  )
                    closePeekSoon()
                }
              : undefined
          }
          onClickCapture={(event) => {
            if (hiddenNow && event.target instanceof Element && event.target.closest('a'))
              linkClickedInPeek.current = true
          }}
          className={cn(
            'md:max-h-[calc(100vh-6rem-1px-env(safe-area-inset-top))] md:overflow-x-hidden md:overflow-y-auto',
            animated && 'md:motion-safe:transition-[width,translate,visibility]',
            slide,
            mode === 'expanded' && 'md:w-52',
            shrunk && 'md:w-14',
            // Hidden: the expanded sidebar, outside the window on the left, out of the tab order and out of
            // reach once it has slid out (visibility follows the slide), and slid back in to its place while
            // the mouse has shown it.
            hiddenNow && 'md:w-52',
            hiddenNow && !showPeek && [HIDDEN_SHIFT, 'md:invisible md:[transition-delay:0s,0s,200ms]'],
            showPeek && 'md:visible md:translate-x-0',
          )}
        >
          {/* The toggle is the sidebar's first row, above Overview, right-aligned when expanded and centred when
              shrunk. It is part of the sidebar, so it hides with it. Hidden, it is the one thing in the sidebar
              that keeps its visibility (out of the window with the sidebar), so Tab can reach it and show the
              sidebar. Desktop only. */}
          <div
            className={cn(
              'mb-1 hidden h-7 md:flex',
              shrunk ? 'md:justify-center' : 'md:justify-end',
              hiddenNow && 'md:visible',
            )}
          >
            {toggle}
          </div>
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
                  // Shrunk: the icon moves to the middle of the narrow sidebar and the label closes up, as the
                  // sidebar's width slides.
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset [&.active]:bg-muted [&.active]:text-foreground',
                    animated && 'md:motion-safe:transition-[padding,gap]',
                    slide,
                    shrunk && 'md:gap-0 md:pr-0 md:pl-5',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {/* Shrunk: the label is closed up to nothing and kept for screen readers; its tooltip shows it
                      on hover and focus. */}
                  <span
                    className={cn(
                      'overflow-hidden md:max-w-40',
                      animated && 'md:motion-safe:transition-[max-width,opacity]',
                      slide,
                      shrunk && 'md:max-w-0 md:opacity-0',
                    )}
                  >
                    {label}
                  </span>
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
      </div>
      {hiddenNow && (
        // The strip along the left border, about 40px wide, where the mouse shows the hidden sidebar. Desktop only.
        <div
          aria-hidden="true"
          onMouseEnter={openPeek}
          // Leaving the strip closes it too: the sidebar can appear under a resting pointer, which then sends no
          // enter to it, and moving into the sidebar opens it again (cancelling this close).
          onMouseLeave={closePeekSoon}
          // While the sidebar shows, the strip covers only what is left of it (up to the sidebar's place), so the
          // sidebar itself is not under it. A pointer on its way from the window's edge to the sidebar (far away
          // on a wide window) stays on the strip and keeps it open.
          className={cn(
            'fixed bottom-0 left-0 z-30 hidden md:block',
            showPeek ? 'md:w-[max(1rem,(100vw-80rem)/2+1rem)]' : 'md:w-10',
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
