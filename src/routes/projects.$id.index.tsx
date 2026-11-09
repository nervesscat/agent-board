import { createFileRoute } from '@tanstack/react-router'

import { Summary } from '#/components/Summary'

export const Route = createFileRoute('/projects/$id/')({ component: Overview })

function Overview() {
  const { id } = Route.useParams()
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">What needs you, what is moving, what is next.</p>
      </div>
      <Summary projectId={Number(id)} />
    </div>
  )
}
