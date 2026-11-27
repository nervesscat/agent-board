import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'

import { initialLanguage } from './i18n/initial'
import { createI18n, shared, showLanguage } from './i18n'
import { followHistory } from './lib/reveal'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // The server renders each request in its own language with an instance of its own; the browser has one,
  // started in the language the server's page was drawn in, so what it draws first matches that page.
  const language = initialLanguage()
  const i18n = typeof window === 'undefined' ? createI18n(language) : shared
  if (typeof window !== 'undefined' && i18n.language !== language) void showLanguage(i18n, language)
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } })
  const router = createRouter({
    routeTree,
    // The Vite base: '/' here, or a preview's path on the board's origin (vite.config.ts, previewProxy.ts).
    basepath: import.meta.env.BASE_URL,
    context: { queryClient, i18n },
    scrollRestoration: true,
    // A page brings its own #anchor into view once its data has drawn it (src/lib/reveal.ts). The
    // router's own jump, as soon as the route renders, could land on the previous page's element of
    // the same id while the next one loads.
    defaultHashScrollIntoView: false,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
  setupRouterSsrQueryIntegration({ router, queryClient })
  // Now, before the router mounts and follows its history itself: see followHistory.
  followHistory(router)
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
