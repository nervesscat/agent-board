import { createFileRoute } from '@tanstack/react-router'

import { DailyView } from '#/components/DailyView'

export const Route = createFileRoute('/projects/$id/daily')({ component: ProjectDaily })

function ProjectDaily() {
  const { id } = Route.useParams()
  return <DailyView projectId={Number(id)} />
}
