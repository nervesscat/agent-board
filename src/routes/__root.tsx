import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Link, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { useEffect } from 'react'

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

function App() {
  useEffect(followSystemTheme, [])
  return (
    <>
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <nav className="mx-auto flex h-12 max-w-7xl items-center gap-5 px-4 text-sm">
          <Link to="/" className="font-semibold tracking-tight">
            Agent Board
          </Link>
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground"
          >
            Projects
          </Link>
          <Link
            to="/daily"
            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground"
          >
            Daily
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      <Toaster />
    </>
  )
}
