import { createFileRoute, redirect } from '@tanstack/react-router'

// Repositories are a page of each project now (its menu's Repositories); old links land on Home.
export const Route = createFileRoute('/repositories')({
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
})
