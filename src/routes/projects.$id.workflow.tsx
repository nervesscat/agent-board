import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { WorkflowPage } from '#/components/WorkflowPage'
import { COMPLEXITIES, DEFAULT_COMPLEXITY } from '#/lib/constants'
import { WORKFLOW_PRESETS } from '#/lib/workflow'

export const Route = createFileRoute('/projects/$id/workflow')({
  component: Workflow,
  // Which preset and complexity the graph shows, so a link can point at one (the project's active preset and
  // Mid when none is named).
  validateSearch: z.object({
    preset: z.enum(WORKFLOW_PRESETS).optional().catch(undefined),
    complexity: z.enum(COMPLEXITIES).optional().catch(undefined),
  }),
})

function Workflow() {
  const { id } = Route.useParams()
  const { preset, complexity } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <WorkflowPage
      projectId={id}
      preset={preset}
      complexity={complexity ?? DEFAULT_COMPLEXITY}
      onView={(next) => navigate({ search: (s) => ({ ...s, preset: next }), replace: true })}
      onComplexity={(level) => navigate({ search: (s) => ({ ...s, complexity: level }), replace: true })}
    />
  )
}
