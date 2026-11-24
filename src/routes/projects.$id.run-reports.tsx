import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

// The run reports are opened from the timeline's bars now: old links land on the ticket the report belongs
// to when ?ticket= names one, on the Roadmap otherwise. ?agent= has no page to narrow any more.
export const Route = createFileRoute('/projects/$id/run-reports')({
  validateSearch: z.object({
    agent: z.string().optional().catch(undefined),
    ticket: z.number().int().positive().optional().catch(undefined),
  }),
  beforeLoad: ({ params, search }) => {
    if (search.ticket)
      throw redirect({
        to: '/projects/$id/features/$ticketId',
        params: { id: params.id, ticketId: String(search.ticket) },
        replace: true,
      })
    throw redirect({ to: '/projects/$id/roadmap', params, replace: true })
  },
})
