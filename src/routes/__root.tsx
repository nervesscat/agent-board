import { type QueryClient, useQuery } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { Menu } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CrossBoardMark } from '#/components/CrossBoardMark'
import { Gallery } from '#/components/Gallery'
import { GettingStartedEntry, GettingStartedMenuItem } from '#/components/GettingStarted'
import { HostToolsBanner } from '#/components/HostToolsBanner'
import { PreviewWindows } from '#/components/PreviewWindow'
import { ProjectSwitcher } from '#/components/ProjectSwitcher'
import { ReportDueBanner } from '#/components/ReportDueBanner'
import { UpdateBadge } from '#/components/Updates'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Toaster } from '#/components/ui/sonner'
import { Tip, TooltipProvider } from '#/components/ui/tooltip'
import { get, type Me } from '#/lib/api'
import { KEY_ENTRIES } from '#/lib/reveal'
import { followSystemTheme } from '#/lib/theme'
import appCss from '#/styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      // viewport-fit=cover lets the page paint the phone's safe areas (the status bar behind the notch)
      // itself, instead of leaving Safari to fill them with its own colour; the top bar pads its content
      // by env(safe-area-inset-top) below. The theme-colour tags live in RootDocument: HeadContent keeps
      // one meta per name, and two are needed, one per scheme.
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'CrossBoard' },
    ],
    // The stylesheet is not here but in RootDocument, after KEY_ENTRIES. The SVG favicon switches its own
    // colours with the system theme. The PNG is for browsers without SVG icons; its `sizes` lets the
    // others prefer the SVG.
    links: [
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
    ],
  }),
  shellComponent: RootDocument,
  component: App,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* KEY_ENTRIES before the stylesheet: a script in the head does not run until a stylesheet before
            it has loaded, and it must run as the page opens. A stylesheet from HeadContent would come
            first whatever the order here: it is given a precedence, and React puts those at the top of
            the head. Without one, the link stays where it is written. TanStack Start's own dev stylesheet
            would come first too: vite.config.ts turns it off. */}
        <ScriptOnce>{KEY_ENTRIES}</ScriptOnce>
        {/* Both schemes, in RootDocument rather than head(): HeadContent keeps one meta per name. These
            tint the phone's status bar and overscroll area; each matches --background. */}
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)" />
        <link rel="stylesheet" href={appCss} />
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/**
 * The board-wide pages, on the right of the top bar. Under `md` they fold into a menu: between `sm` and
 * `md` the lockup, the auth-off badge, the project switcher and the three links do not fit on one row.
 */
const PAGES = [
  { to: '/daily', label: 'Daily' },
  { to: '/agents', label: 'Connect' },
  { to: '/settings', label: 'Settings' },
] as const

/**
 * How long the pointer rests on an element before its tooltip shows. Once one shows, the next ones open
 * at once while the pointer moves between them.
 */
const TOOLTIP_DELAY = 300

function App() {
  useEffect(followSystemTheme, [])
  return (
    <TooltipProvider delay={TOOLTIP_DELAY}>
      {/* Opaque and padded for the phone's safe area: this bar is what paints the strip behind the status
          bar (viewport-fit=cover above), so a translucent bar would let the page's canvas show through. */}
      <header className="sticky top-0 z-20 border-b bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <nav className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-4 text-sm sm:gap-5">
          <Tip content="Home">
            <Link to="/" className="flex shrink-0 items-center gap-2">
              <CrossBoardMark className="size-[22px] shrink-0" />
              <span className="font-brand text-[17px] leading-none font-bold tracking-[-0.035em] whitespace-nowrap">
                CrossBoard
              </span>
            </Link>
          </Tip>
          <AuthOffBadge />
          <UpdateBadge />
          <ProjectSwitcher />
          <div className="ml-auto flex shrink-0 items-center">
            <GettingStartedEntry />
          </div>
          <div className="hidden items-center gap-5 md:flex">
            {PAGES.map((p) => (
              <Link
                key={p.to}
                to={p.to}
                className="text-muted-foreground hover:text-foreground [&.active]:text-foreground"
              >
                {p.label}
              </Link>
            ))}
          </div>
          <PagesMenu />
        </nav>
      </header>
      <HostToolsBanner />
      <ReportDueBanner />
      <main className="mx-auto w-full max-w-7xl px-4 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
      <Gallery />
      <PreviewWindows />
      <Toaster />
    </TooltipProvider>
  )
}

/** Outside production sign-in can be off: say so, so no screenshot is ever taken for the live board. */
function AuthOffBadge() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  if (!me?.authOff) return null
  return (
    <Tip content={`BOARD_ENV=${me.boardEnv}, sign-in off: signed in as ${me.actor}. Not the live board.`}>
      <Badge variant="destructive" className="shrink-0 uppercase">
        {me.boardEnv === 'test' ? 'test mode' : 'auth off'}
      </Badge>
    </Tip>
  )
}

const MENU_ITEM =
  'flex w-full items-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground [&.active]:bg-muted [&.active]:text-foreground'

/** The same pages behind one button, for screens too narrow to list them, and Getting started's entry. */
function PagesMenu() {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="md:hidden" />}
        aria-label="Pages"
      >
        <Menu />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 gap-0 p-1">
        <GettingStartedMenuItem className={MENU_ITEM} onGo={() => setOpen(false)} />
        {PAGES.map((p) => (
          <Link key={p.to} to={p.to} onClick={() => setOpen(false)} className={MENU_ITEM}>
            {p.label}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
