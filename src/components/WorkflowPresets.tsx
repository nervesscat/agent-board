import { Check, Pencil } from 'lucide-react'
import type { ReactNode } from 'react'

import { Chip } from '#/components/WorkflowChips'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import type { WorkflowOverview } from '#/lib/api'
import { WORKFLOW_PRESET_DEFS } from '#/lib/workflow'
import { COMPLEXITY_NAMES } from '#/lib/workflowView'
import { cn } from '#/lib/utils'

type Preset = WorkflowOverview['presets'][number]

/**
 * The four presets, lightest to heaviest, then the project's own workflows, as a row of cards: its name, a line
 * on what it is (a custom one says which preset it was copied from), whether it is the project's Active one and
 * whether the human Tweaked it. Picking one shows its graph; it does not make it active. `extra` is the
 * "New workflow" card at the end.
 */
export function PresetSwitcher({
  presets,
  active,
  viewed,
  onView,
  extra,
}: {
  presets: readonly Preset[]
  active: string
  viewed: string
  onView: (preset: string) => void
  extra?: ReactNode
}) {
  return (
    <div role="group" aria-label="Workflows" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
              <span className="min-w-0 text-sm font-semibold wrap-anywhere">{p.label}</span>
              {p.custom && <Chip tone="agent">Custom</Chip>}
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
            <span className="text-xs wrap-anywhere text-muted-foreground">
              {p.custom
                ? `Your own, copied from ${WORKFLOW_PRESET_DEFS[p.custom.base].label}.`
                : p.description}
            </span>
            <span className="mt-auto text-[11px] text-muted-foreground">
              {steps} steps · review rounds {COMPLEXITIES.map((level) => p.rounds[level]).join(' / ')}
            </span>
          </button>
        )
      })}
      {extra}
    </div>
  )
}

/** Low, Mid, High and Max: the complexity the graph is drawn for (its rounds, and the steps a low ticket skips). */
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
