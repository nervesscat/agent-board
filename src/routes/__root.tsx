import { type QueryClient, useQuery } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  Outlet,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { i18n as I18n } from 'i18next'
import { Menu, Plug, Settings } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { cn } from 'cn'

import { CrossBoardMark } from '#/components/CrossBoardMark'
import { CommandPalette } from '#/components/CommandPalette'
import { Gallery } from '#/components/Gallery'
import { GettingStartedEntry, GettingStartedMenuItem } from '#/components/GettingStarted'
import { HostToolsBanner } from '#/components/HostToolsBanner'
import { NotificationCenter } from '#/components/NotificationCenter'
import { PreviewWindows } from '#/components/PreviewWindow'
import { ProjectSwitcher } from '#/components/ProjectSwitcher'
import { ReportDueBanner } from '#/components/ReportDueBanner'
import { UpdateCard } from '#/components/UpdateCard'
import { UpdateBadge } from '#/components/Updates'
import { Badge } from '#/components/ui/badge'
import { Button, buttonVariants } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Toaster } from '#/components/ui/sonner'
import { Tip, TooltipProvider } from '#/components/ui/tooltip'
import { useLanguageOf } from '#/i18n/react'
import { LanguageSync } from '#/i18n/LanguageSync'
import { get, type Me } from '#/lib/api'
import { KEY_ENTRIES } from '#/lib/reveal'
import { followTheme } from '#/lib/theme'
import { useHydrated } from '#/lib/useHydrated'
import appCss from '#/styles.css?url'

interface RouterContext {
  queryClient: QueryClient
  /** The language the interface is drawn in: one per request on the server, the browser's one in the browser. */
  i18n: I18n
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
  // The page's own language, which follows the choice at once (the shell is above the provider).
  const language = useLanguageOf(Route.useRouteContext().i18n)
  return (
    <html lang={language} suppressHydrationWarning>
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
 * `md` the lockup, the auth-off badge, the project switcher and the links do not fit on one row.
 * A project's pages, Daily among them, are in its own menu beside the page. Beside the search and the
 * notifications they are icon buttons with a tooltip (`name`); in the menu they keep their words.
 */
const PAGES = [
  { to: '/agents', label: 'shell.connect', name: 'shell.connectAgent', Icon: Plug },
  { to: '/settings', label: 'shell.settings', name: 'shell.settings', Icon: Settings },
] as const

/**
 * How long the pointer rests on an element before its tooltip shows. Once one shows, the next ones open
 * at once while the pointer moves between them.
 */
const TOOLTIP_DELAY = 300

function App() {
  const { i18n } = Route.useRouteContext()
  return (
    <I18nextProvider i18n={i18n}>
      <Board />
    </I18nextProvider>
  )
}

function Board() {
  const { t, i18n } = useTranslation()
  useEffect(followTheme, [])
  return (
    <TooltipProvider delay={TOOLTIP_DELAY}>
      <LanguageSync />
      {/* Opaque and padded for the phone's safe area: this bar is what paints the strip behind the status
          bar (viewport-fit=cover above), so a translucent bar would let the page's canvas show through. */}
      <header className="sticky top-0 z-20 border-b bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        {/* gap-2 under sm: at 360 px the lockup, the test mode badge, the switcher, the search button
            and the Pages menu fit only with the tighter gap. */}
        <nav className="mx-auto flex h-12 max-w-7xl items-center gap-2 px-4 text-sm sm:gap-5">
          <Tip content={t('shell.home')}>
            <Link to="/" className="flex shrink-0 items-center gap-2">
              <CrossBoardMark className="size-[22px] shrink-0" />
              {/* Below 390 px the wordmark leaves the row (the mark alone links home, its name kept
                  for screen readers): with the test mode badge, the switcher, the search button, the
                  notifications and the Pages menu, the row would otherwise push the page wider than
                  the screen at 360 and 375 px. */}
              <span className="font-brand text-[17px] leading-none font-bold tracking-[-0.035em] whitespace-nowrap max-[389px]:sr-only">
                CrossBoard
              </span>
            </Link>
          </Tip>
          <AuthOffBadge />
          <UpdateBadge />
          <ProjectSwitcher />
          <CommandPalette />
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-5">
            <GettingStartedEntry />
            <NotificationCenter />
          </div>
          <div className="hidden items-center gap-2 md:flex">
            {PAGES.map((p) => (
              <Tip key={p.to} content={t(p.name)}>
                <Link
                  to={p.to}
                  aria-label={t(p.name)}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    '[&.active]:bg-muted [&.active]:text-foreground',
                  )}
                >
                  <p.Icon />
                </Link>
              </Tip>
            ))}
          </div>
          <PagesMenu />
        </nav>
      </header>
      <HostToolsBanner />
      <ReportDueBanner />
      <main className="mx-auto w-full max-w-7xl px-4 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        {/* Remounted when the language changes, so every text, date and number is drawn again in it. */}
        <Fragment key={i18n.language}>
          <Outlet />
        </Fragment>
      </main>
      <UpdateCard />
      <Gallery />
      <PreviewWindows />
      <Toaster />
    </TooltipProvider>
  )
}

/** Outside production sign-in can be off: say so, so no screenshot is ever taken for the live board. */
function AuthOffBadge() {
  const { t } = useTranslation()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  // Read after mount: /api/me can answer before React has hydrated the top bar.
  const hydrated = useHydrated()
  if (!hydrated || !me?.authOff) return null
  return (
    <Tip content={t('shell.authOffTip', { env: me.boardEnv, actor: me.actor })}>
      <Badge variant="destructive" className="shrink-0 uppercase">
        {me.boardEnv === 'test' ? t('shell.testMode') : t('shell.authOff')}
      </Badge>
    </Tip>
  )
}

const MENU_ITEM =
  'flex w-full items-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground [&.active]:bg-muted [&.active]:text-foreground'

/** The same pages behind one button, for screens too narrow to list them, and Getting started's entry. */
function PagesMenu() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="md:hidden" />}
        aria-label={t('shell.pages')}
      >
        <Menu />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 gap-0 p-1">
        <GettingStartedMenuItem className={MENU_ITEM} onGo={() => setOpen(false)} />
        {PAGES.map((p) => (
          <Link key={p.to} to={p.to} onClick={() => setOpen(false)} className={MENU_ITEM}>
            {t(p.label)}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
