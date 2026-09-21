import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/projects/$id/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/projects/$id/prs', params })
  },
})
