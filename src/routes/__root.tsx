import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Link, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { Menu } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Gallery } from '#/components/Gallery'
import { ProjectSwitcher } from '#/components/ProjectSwitcher'
import { Button } from '#/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Toaster } from '#/components/ui/sonner'
import { followSystemTheme } from '#/lib/theme'
import appCss from '#/styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Agent Board' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: App,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/** The board-wide pages, on the right of the top bar. Under `sm` they fold into a menu. */
const PAGES = [
  { to: '/repositories', label: 'Repositories' },
  { to: '/daily', label: 'Daily' },
  { to: '/agents', label: 'Agents' },
  { to: '/settings', label: 'Settings' },
] as const

function App() {
  useEffect(followSystemTheme, [])
  return (
    <>
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <nav className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-4 text-sm sm:gap-5">
          <Link to="/" className="shrink-0 font-semibold tracking-tight" title="Home">
            Agent Board
          </Link>
          <ProjectSwitcher />
          <div className="ml-auto hidden items-center gap-5 sm:flex">
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
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      <Gallery />
      <Toaster />
    </>
  )
}

/** The same pages behind one button, for screens too narrow to list them. */
function PagesMenu() {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="ml-auto sm:hidden" />}
        aria-label="Pages"
      >
        <Menu />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 gap-0 p-1">
        {PAGES.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            onClick={() => setOpen(false)}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            {p.label}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  )
}
