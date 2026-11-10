import { useNavigate, createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { currentProjectId, useProjects } from '#/lib/project'

export const Route = createFileRoute('/daily')({ component: CurrentProjectDaily })

/**
 * The old board-wide Daily address. Daily is a project's page now: this opens the project this
 * browser was last in, or Home (where a project is picked) when it does not know one.
 */
function CurrentProjectDaily() {
  const navigate = useNavigate()
  const { data: projects, isPending, isError } = useProjects()
  useEffect(() => {
    if (isPending) return
    // No project to open: none exists, the list failed (a restart, an offline board), or the browser
    // remembers one that is gone. Home is where a project is picked.
    if (isError || !projects) {
      void navigate({ to: '/', replace: true })
      return
    }
    const id = currentProjectId(projects.map((p) => p.id))
    if (id) void navigate({ to: '/projects/$id/daily', params: { id }, replace: true })
    else void navigate({ to: '/', replace: true })
  }, [isPending, isError, projects, navigate])
  return <p className="text-sm text-muted-foreground">Opening Daily…</p>
}
