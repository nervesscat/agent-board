import { createFileRoute } from '@tanstack/react-router'

import { api } from '#/server/api'
import { actorOf } from '#/server/auth'
import { api as guard } from '#/server/http'

// Every /api/* request lands here; src/server/api.ts holds the actual routes.
const handler = guard(({ request }: { request: Request }) => api.handle(request, actorOf(request)))

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: handler,
    },
  },
})
