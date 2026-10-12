import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'

import { followHistory } from './lib/reveal'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } })
  const router = createRouter({
    routeTree,
    context: { queryClient },
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
