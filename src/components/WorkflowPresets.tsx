import { Check, Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Chip } from '#/components/WorkflowChips'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import type { WorkflowOverview } from '#/lib/api'
import { isWorkflowPreset } from '#/lib/workflow'
import { cn } from '#/lib/utils'

type Preset = WorkflowOverview['presets'][number]

/**
 * The presets, the four built-in ones lightest to heaviest and then Content, then the project's own workflows, as a row of cards: its name, a line
 * on what it is (a custom one says which preset it was copied from), whether it is the project's Active one and
 * whether the human Tweaked it. Picking one shows its graph; it does not make it active. `extra` (the "New
 * workflow" button) sits under the cards.
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
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('workflowPresets.group')}
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
    >
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
              <span className="min-w-0 text-sm font-semibold wrap-anywhere">
                {p.custom || !isWorkflowPreset(p.id) ? p.label : t(`workflowPresets.${p.id}.label`)}
              </span>
              {p.custom && <Chip tone="agent">{t('workflowPresets.custom')}</Chip>}
              {p.id === active && (
                <Chip tone="edited" icon={<Check aria-hidden />}>
                  {t('workflowPresets.active')}
                </Chip>
              )}
              {p.tweaked && (
                <Chip tone="lock" icon={<Pencil aria-hidden />}>
                  {t('workflowPresets.tweaked')}
                </Chip>
              )}
            </span>
            <span className="text-xs wrap-anywhere text-muted-foreground">
              {p.custom
                ? t('workflowPresets.copiedFrom', { base: t(`workflowPresets.${p.custom.base}.label`) })
                : isWorkflowPreset(p.id)
                  ? t(`workflowPresets.${p.id}.description`)
                  : ''}
            </span>
            <span className="mt-auto text-[11px] text-muted-foreground">
              {p.order.includes('review')
                ? t('workflowPresets.stats', {
                    count: steps,
                    rounds: COMPLEXITIES.map((level) => p.rounds[level]).join(' / '),
                  })
                : t('workflowPresets.noReview')}
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
  const { t } = useTranslation()
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as Complexity)}>
      <TabsList aria-label={t('workflowPresets.complexity')} className="w-full sm:w-fit">
        {COMPLEXITIES.map((level) => (
          <TabsTrigger key={level} value={level} className="px-3">
            {t(`complexity.label.${level}`)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
