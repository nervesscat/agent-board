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
  const { data: projects, isPending } = useProjects()
  useEffect(() => {
    if (isPending || !projects) return
    const id = currentProjectId(projects.map((p) => p.id))
    if (id) void navigate({ to: '/projects/$id/daily', params: { id }, replace: true })
    else void navigate({ to: '/', replace: true })
  }, [isPending, projects, navigate])
  return <p className="text-sm text-muted-foreground">Opening Daily…</p>
}
