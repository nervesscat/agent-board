import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

// Review results show on the PR queue now; old links land there, with ?result= opening that one.
export const Route = createFileRoute('/projects/$id/reviews')({
  validateSearch: z.object({ result: z.number().int().positive().optional().catch(undefined) }),
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/projects/$id/prs', params, search: { result: search.result }, replace: true })
  },
})
