import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { get, type WorkflowOverview } from '#/lib/api'
import { DEFAULT_WORKFLOW_PRESET, WORKFLOW_PRESET_LIST, isWorkflowPreset } from '#/lib/workflow'

/** The value that follows the project's workflow: a ticket that names no workflow of its own. */
const PROJECT = 'project'
/** The value of a ticket whose workflow was deleted: it stands for the project's again. */
const DELETED = 'deleted'

/**
 * The workflows a project offers, as the Workflow page's overview lists them (the same query, so a change on
 * the page shows here): the presets, then the project's own. Without a project id (the new-ticket window, which
 * knows only the project's preset) or before the overview loads, the presets, and the project's preset is the
 * one it follows.
 */
export function useWorkflowChoices(projectId?: number | string, projectPreset?: string) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['workflow', String(projectId)],
    queryFn: () => get<WorkflowOverview>(`/api/projects/${projectId}/workflow`),
    enabled: projectId !== undefined,
  })
  const choices = data
    ? data.presets.map((p) => {
        const custom = p.custom !== null
        // A preset's name is translated; a workflow the project made is named by the project.
        const label = !custom && isWorkflowPreset(p.id) ? t(`workflowPresets.${p.id}.label`) : p.label
        return { id: p.id, label, custom, pickable: p.pickable }
      })
    : WORKFLOW_PRESET_LIST.map((p) => ({
        id: p.id,
        label: t(`workflowPresets.${p.id}.label`),
        custom: false,
        pickable: p.pickable,
      }))
  const active = data?.active ?? projectPreset ?? DEFAULT_WORKFLOW_PRESET
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
 * A ticket's workflow, picked: the project's own first (named with the workflow it is now), then the presets
 * a ticket can pick and the project's own workflows. A preset that is not pickable (Content) is offered only
 * as the ticket's current pick. `value` is the ticket's own workflow, null when it follows the project's (or
 * when the one it named was deleted, which shows as such); `onChange` gets the same. Give `projectId` for the
 * project's workflows, or `projectPreset` alone for the presets.
 */
export function WorkflowSelect<W extends string = string>({
  id,
  projectId,
  projectPreset,
  value,
  onChange,
  size = 'sm',
  className,
}: {
  id?: string
  projectId?: number | string
  /** The project's active preset, which a ticket with none follows. */
  projectPreset?: string
  value: W | null
  onChange: (workflow: W | null) => void
  size?: 'sm' | 'default'
  className?: string
}) {
  const { t } = useTranslation()
  const { choices, activeLabel, pickOf } = useWorkflowChoices(projectId, projectPreset)
  const pick = pickOf(value)
  const items: Record<string, string> = {
    [PROJECT]: t('workflowSelect.project', { label: activeLabel }),
    ...Object.fromEntries(choices.filter((c) => c.pickable || c.id === value).map((c) => [c.id, c.label])),
    // A workflow that was deleted stays in the list so the ticket's pick can be read, and shows what it does now.
    ...(pick.kind === 'deleted' ? { [DELETED]: t('workflowSelect.deleted') } : {}),
  }
  const current = value === null ? PROJECT : pick.kind === 'deleted' ? DELETED : value
  return (
    <Select
      value={current}
      onValueChange={(v) => v && v !== DELETED && onChange(v === PROJECT ? null : (v as W))}
      items={items}
    >
      <Tip content={t('workflowSelect.hint')}>
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
