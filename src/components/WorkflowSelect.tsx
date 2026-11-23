import { useQuery } from '@tanstack/react-query'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { get, type WorkflowOverview } from '#/lib/api'
import { DEFAULT_WORKFLOW_PRESET, WORKFLOW_PRESET_LIST } from '#/lib/workflow'

/** The value that follows the project's workflow: a ticket that names no workflow of its own. */
const PROJECT = 'project'
/** The value of a ticket whose workflow was deleted: it stands for the project's again. */
const DELETED = 'deleted'

const HINT =
  "The workflow its agent follows: the project's own, or another of the project's workflows for this ticket alone. Changing the project's workflow does not move a ticket that names one."

/**
 * The workflows a project offers, as the Workflow page's overview lists them (the same query, so a change on
 * the page shows here): the four presets, then the project's own. Before it loads, the four presets.
 */
export function useWorkflowChoices(projectId: number | string) {
  const { data } = useQuery({
    queryKey: ['workflow', String(projectId)],
    queryFn: () => get<WorkflowOverview>(`/api/projects/${projectId}/workflow`),
  })
  const choices = data
    ? data.presets.map((p) => ({ id: p.id, label: p.label, custom: p.custom !== null }))
    : WORKFLOW_PRESET_LIST.map((p) => ({ id: p.id, label: p.label, custom: false }))
  const active = data?.active ?? DEFAULT_WORKFLOW_PRESET
  const labelOf = (id: string) => choices.find((c) => c.id === id)?.label ?? null
  return {
    choices,
    /** The workflow the project follows, and its name. */
    active,
    activeLabel: labelOf(active) ?? active,
    labelOf,
    /** A ticket's own pick: its workflow's name, or `deleted` when it names one the project no longer has. */
    pickOf: (value: string | null) => {
      if (value === null) return { kind: 'project' } as const
      const label = labelOf(value)
      if (label !== null) return { kind: 'own', label } as const
      // Until the list loads a name is not known to be gone.
      return data ? ({ kind: 'deleted' } as const) : ({ kind: 'own', label: value } as const)
    },
  }
}

/**
 * A ticket's workflow, picked: the project's own first (named with the workflow it is now), then the four
 * presets and the project's own workflows. `value` is the ticket's own workflow, null when it follows the
 * project's (or when the one it named was deleted, which shows as such); `onChange` gets the same.
 */
export function WorkflowSelect({
  id,
  projectId,
  value,
  onChange,
  size = 'sm',
  className,
}: {
  id?: string
  projectId: number | string
  value: string | null
  onChange: (workflow: string | null) => void
  size?: 'sm' | 'default'
  className?: string
}) {
  const { choices, activeLabel, pickOf } = useWorkflowChoices(projectId)
  const pick = pickOf(value)
  const items: Record<string, string> = {
    [PROJECT]: `Project's workflow (${activeLabel})`,
    ...Object.fromEntries(choices.map((c) => [c.id, c.label])),
    // A workflow that was deleted stays in the list so the ticket's pick can be read, and shows what it does now.
    ...(pick.kind === 'deleted' ? { [DELETED]: "Deleted workflow (follows the project's)" } : {}),
  }
  const current = value === null ? PROJECT : pick.kind === 'deleted' ? DELETED : value
  return (
    <Select
      value={current}
      onValueChange={(v) => v && v !== DELETED && onChange(v === PROJECT ? null : v)}
      items={items}
    >
      <Tip content={HINT}>
        <SelectTrigger id={id} size={size} className={className}>
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent className="min-w-56">
        {Object.entries(items).map(([key, label]) => (
          <SelectItem key={key} value={key} disabled={key === DELETED}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
