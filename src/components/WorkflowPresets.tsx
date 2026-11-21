import { Check, Pencil } from 'lucide-react'

import { Chip } from '#/components/WorkflowChips'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import type { WorkflowOverview } from '#/lib/api'
import type { WorkflowPresetId } from '#/lib/workflow'
import { COMPLEXITY_NAMES } from '#/lib/workflowView'
import { cn } from '#/lib/utils'

type Preset = WorkflowOverview['presets'][number]

/**
 * The four presets, lightest to heaviest, as a row of cards: its name, a line on what it is, whether it is the
 * project's Active one and whether the human Tweaked it. Picking one shows its tree; it does not make it active.
 */
export function PresetSwitcher({
  presets,
  active,
  viewed,
  onView,
}: {
  presets: readonly Preset[]
  active: WorkflowPresetId
  viewed: WorkflowPresetId
  onView: (preset: WorkflowPresetId) => void
}) {
  return (
    <div role="group" aria-label="Workflow presets" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {presets.map((p) => {
        const steps = p.steps.length
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === viewed}
            data-preset={p.id}
            onClick={() => onView(p.id)}
            className={cn(
              'flex min-w-0 flex-col items-start gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50',
              p.id === viewed && 'border-primary bg-primary/5 ring-1 ring-primary',
            )}
          >
            <span className="flex w-full flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold">{p.label}</span>
              {p.id === active && (
                <Chip tone="edited" icon={<Check aria-hidden />}>
                  Active
                </Chip>
              )}
              {p.tweaked && (
                <Chip tone="lock" icon={<Pencil aria-hidden />}>
                  Tweaked
                </Chip>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{p.description}</span>
            <span className="mt-auto text-[11px] text-muted-foreground">
              {steps} steps · review rounds {COMPLEXITIES.map((level) => p.rounds[level]).join(' / ')}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Low, Mid, High and Max: the complexity the tree is drawn for (its rounds, and the steps a low ticket skips). */
export function ComplexityPicker({
  value,
  onChange,
}: {
  value: Complexity
  onChange: (level: Complexity) => void
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as Complexity)}>
      <TabsList aria-label="Complexity" className="w-full sm:w-fit">
        {COMPLEXITIES.map((level) => (
          <TabsTrigger key={level} value={level} className="px-3">
            {COMPLEXITY_NAMES[level]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
