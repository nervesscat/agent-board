import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { WORKFLOW_PRESET_LIST, workflowPreset, type WorkflowPresetId } from '#/lib/workflow'

/** The value that follows the project's workflow: a ticket that names no preset of its own. */
const PROJECT = 'project'

const HINT =
  "The workflow its agent follows: the project's own, or one of the four presets for this ticket alone. Changing the project's workflow does not move a ticket that names one."

/**
 * A ticket's workflow, picked: the project's own first (named with the preset it is now), then the four presets.
 * `value` is the ticket's own preset, null when it follows the project's; `onChange` gets the same.
 */
export function WorkflowSelect({
  id,
  value,
  projectPreset,
  onChange,
  size = 'sm',
  className,
}: {
  id?: string
  value: WorkflowPresetId | null
  /** The project's active preset, which a ticket with none follows. */
  projectPreset: WorkflowPresetId
  onChange: (preset: WorkflowPresetId | null) => void
  size?: 'sm' | 'default'
  className?: string
}) {
  const items: Record<string, string> = {
    [PROJECT]: `Project's workflow (${workflowPreset(projectPreset).label})`,
    ...Object.fromEntries(WORKFLOW_PRESET_LIST.map((p) => [p.id, p.label])),
  }
  return (
    <Select
      value={value ?? PROJECT}
      onValueChange={(v) => v && onChange(v === PROJECT ? null : (v as WorkflowPresetId))}
      items={items}
    >
      <Tip content={HINT}>
        <SelectTrigger id={id} size={size} className={className}>
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent className="min-w-56">
        {Object.entries(items).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
