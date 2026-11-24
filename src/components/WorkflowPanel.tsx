import { ArrowDown, ArrowUp, MousePointerClick, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { ChangedChip, Chip } from '#/components/WorkflowChips'
import { RoundsEditor, type RoundsFlight } from '#/components/WorkflowReview'
import { Dialog, DialogContent, DialogTitle } from '#/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { currentLocale } from '#/i18n'
import type { Complexity } from '#/lib/constants'
import {
  WORKFLOW_EFFORTS,
  type ResolvedReview,
  type ResolvedStep,
  type ResolvedWorkflow,
  type WorkflowEffort,
  type WorkflowPresetId,
  type WorkflowStepId,
} from '#/lib/workflow'
import { defaultAgentName, nodeView, type GraphNode, type NodeView } from '#/lib/workflowGraph'
import {
  EFFORT_NAMES,
  autoEffortHint,
  effortText,
  lockReasonText,
  moveReason,
  survivalText,
} from '#/lib/workflowView'
import { cn } from '#/lib/utils'

/** What the human can change in the panel: each call saves at once (the page owns the saving). */
export interface WorkflowEdits {
  setEnabled: (id: WorkflowStepId, enabled: boolean) => void
  setEffort: (id: WorkflowStepId, effort: WorkflowEffort) => void
  /** The Team agent a node runs, by name; null puts back the default (the Team agent named like its role). */
  setAgent: (nodeId: string, agent: string | null) => void
  /** Answers with the reason the count was not saved, or null once it was; the field goes back to the saved count. */
  setRounds: (level: Complexity, rounds: number) => Promise<string | null>
  /** Answers with the reason the move was not saved, or null once it was. */
  move: (id: WorkflowStepId, direction: 'up' | 'down') => Promise<string | null>
}

/** The picker's entry for "no pick": it stands for the default. A name no Team agent can have. */
const DEFAULT_PICK = '__default__'

const PANEL_TITLE = 'wf-panel-title'

/**
 * The settings of the node selected, beside the graph on a wide screen (an `aside` with the node's title for its
 * name) and as a bottom sheet over it on a phone. A step has its Team agent, effort, switch and place in the
 * order; the review step also its round counts, but no Team agent (its phases have theirs); a phase of the review
 * round only its Team agent. What each node does and hands on is shown read-only: the text is the preset's,
 * never edited here.
 */
export function SidePanel({
  node,
  focusToken,
  ...rest
}: PanelProps & {
  /** Above 0 when the keyboard chose the node (it changes with each such choice): the focus moves to the panel's title so Tab reaches its controls. 0 when the mouse chose it. */
  focusToken: number
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const id = node.id
  useEffect(() => {
    if (focusToken > 0) title.current?.focus()
  }, [focusToken, id])
  return (
    <aside
      data-panel="side"
      aria-labelledby={PANEL_TITLE}
      className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-auto rounded-xl border bg-card p-4 shadow-xs"
    >
      <PanelBody
        node={node}
        heading={
          <h2 id={PANEL_TITLE} ref={title} tabIndex={-1} className="text-base font-semibold outline-none">
            {titleOf(nodeView(node))}
          </h2>
        }
        {...rest}
      />
    </aside>
  )
}

/** The same settings as a bottom sheet: a modal dialog, full width, that scrolls inside and gives the focus back to the node. */
export function SheetPanel({ node, onClose, ...rest }: PanelProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-panel="sheet"
        showCloseButton={false}
        finalFocus={() => document.querySelector<HTMLElement>(`[data-step="${node.id}"]`) ?? true}
        className="top-auto bottom-0 left-0 max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto overscroll-contain rounded-t-2xl rounded-b-none p-4 sm:max-w-none data-closed:slide-out-to-bottom data-open:slide-in-from-bottom"
      >
        <PanelBody
          node={node}
          onClose={onClose}
          heading={<DialogTitle className="text-base font-semibold">{titleOf(nodeView(node))}</DialogTitle>}
          {...rest}
        />
      </DialogContent>
    </Dialog>
  )
}

/** What the panel's closed state shows on a wide screen: where the settings will be. */
export function IdlePanel() {
  const { t } = useTranslation()
  return (
    <div
      data-panel="idle"
      className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
    >
      <MousePointerClick className="size-5" aria-hidden />
      <p>{t('workflowPanel.idle')}</p>
    </div>
  )
}

interface PanelProps {
  workflow: ResolvedWorkflow
  /** The names of the project's Team agents. */
  team: readonly string[]
  node: GraphNode
  edits: WorkflowEdits
  flightOf: (level: Complexity) => RoundsFlight
  onClose: () => void
}

const titleOf = (view: NodeView) =>
  view.number === null ? view.label : `${view.number}${view.number.includes('.') ? '' : '.'} ${view.label}`

function PanelBody({
  workflow,
  team,
  node,
  edits,
  flightOf,
  onClose,
  heading,
}: PanelProps & {
  heading: ReactNode
}) {
  const { t } = useTranslation()
  const view = nodeView(node)
  const step = node.kind === 'step' ? node.step : null
  const complexity = workflow.complexity ?? 'mid'
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start gap-2 pr-8 sm:pr-0">
        <div className="min-w-0 flex-1 space-y-1.5">
          {heading}
          <div className="flex flex-wrap items-center gap-1">
            {view.lock && (
              <Chip tone="lock">
                {view.lock === 'always' ? t('workflowChips.locked') : t('workflowChips.lockedAboveLow')}
              </Chip>
            )}
            {view.skipped && <Chip tone="skipped">{view.skipped}</Chip>}
            {!view.skipped && view.skipsOnLow && (
              <Chip tone="skipped">{t('workflowChips.skippedOnLow')}</Chip>
            )}
            {view.changed && <ChangedChip what={view.changed} />}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {view.team ? (
        <TeamPicker view={view} team={team} onPick={(name) => edits.setAgent(node.id, name)} />
      ) : step?.agent === 'runner' ? (
        <p data-review-agents className="text-sm text-muted-foreground">
          {t('workflowPanel.runnerAgents')}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('workflowPanel.selfAgent')}</p>
      )}

      {step && <StepSettings step={step} edits={edits} workflow={workflow} />}

      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">{t('workflowPanel.whatItDoes')}</h3>
        <p data-what className="text-sm leading-relaxed">
          {node.step.what}
        </p>
      </section>

      {node.kind === 'step' && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {node.next ? t('workflowPanel.handoffTo', { next: node.next }) : t('workflowPanel.result')}
          </h3>
          <p
            data-handoff-text
            className="border-l-2 border-border pl-2.5 text-[0.8125rem] leading-relaxed wrap-anywhere text-foreground/85"
          >
            {node.step.handoff}
          </p>
        </section>
      )}

      {step?.review && (
        <ReviewSettings
          review={step.review}
          workflow={workflow}
          complexity={complexity}
          edits={edits}
          flightOf={flightOf}
        />
      )}
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-label={t('common.close')}
      data-close
      onClick={onClose}
      className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:absolute max-sm:top-2 max-sm:right-2"
    >
      <X className="size-4" aria-hidden />
    </button>
  )
}

/** The Team agent a node runs: the project's Team agents and the default, which names the agent it comes to. */
function TeamPicker({
  view,
  team,
  onPick,
}: {
  view: NodeView
  team: readonly string[]
  /** The Team agent's name, or null for the default. */
  onPick: (name: string | null) => void
}) {
  const { t } = useTranslation()
  const ref = view.team!
  const fallback = defaultAgentName(view.role, team)
  const value = ref.picked ?? DEFAULT_PICK
  const items: Record<string, string> = {
    [DEFAULT_PICK]: t('workflowPanel.team.default', { name: fallback }),
  }
  for (const name of team) items[name] = name
  // A pick the Team lost stays in the list: it can be seen, and cleared by choosing the default.
  if (ref.missing && ref.picked !== null)
    items[ref.picked] = t('workflowPanel.team.notInTeam', { name: ref.picked })
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{t('workflowPanel.team.title')}</h3>
      <Select
        value={value}
        items={items}
        onValueChange={(v) => v && v !== value && onPick(v === DEFAULT_PICK ? null : v)}
      >
        <SelectTrigger aria-label={t('workflowPanel.team.title')} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {Object.entries(items).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {ref.missing ? (
        <p data-missing role="status" className="text-xs wrap-anywhere text-amber-700 dark:text-amber-400">
          {t('workflowPanel.team.missing', { picked: ref.picked, name: ref.name })}
        </p>
      ) : (
        <p className="text-xs wrap-anywhere text-muted-foreground">
          {t(ref.source === 'default' ? 'workflowPanel.team.runsAsDefault' : 'workflowPanel.team.runsAs', {
            name: ref.name,
            role: view.role,
          })}
        </p>
      )}
    </section>
  )
}

const MOVE_BUTTON =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-background'

/** What only a step has: its effort, its switch and its place in the order. */
function StepSettings({
  step,
  edits,
  workflow,
}: {
  step: ResolvedStep
  edits: WorkflowEdits
  workflow: ResolvedWorkflow
}) {
  const { t } = useTranslation()
  const body = useRef<HTMLDivElement>(null)
  // After a move the step is somewhere else in the list: the keyboard stays on the button that moved it.
  const moved = useRef<{ id: string; direction: 'up' | 'down'; preset: WorkflowPresetId } | null>(null)
  const order = workflow.order.join()
  useLayoutEffect(() => {
    const target = moved.current
    if (!target) return
    moved.current = null
    // A move saved on another preset's graph does not pull the focus here.
    if (target.preset !== workflow.preset) return
    const { id, direction } = target
    // The answer can come after the person went on (into a rounds field, another control): the focus goes back
    // only if it is still on one of this step's Move buttons or nowhere (the move took the button out of the page).
    const active = document.activeElement
    const nowhere = active === null || active === document.body
    const onStep = active instanceof HTMLElement && active.dataset.move?.startsWith(`${id}:`)
    if (!nowhere && !onStep) return
    const find = (d: string) => body.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${d}"]`)
    const button = find(direction)
    // At an end the button is inert now: the other arrow takes the focus.
    const inert = button?.getAttribute('aria-disabled') === 'true'
    ;(inert ? find(direction === 'up' ? 'down' : 'up') : button)?.focus()
  }, [order, workflow.preset])

  const move = (direction: 'up' | 'down') => {
    const target = { id: step.id, direction, preset: workflow.preset }
    moved.current = target
    // A refused move changes nothing: the next change of the order is not a move.
    void edits.move(step.id, direction).then((reason) => {
      if (reason !== null && moved.current === target) moved.current = null
    })
  }
  const effort = effortText(step)
  return (
    <div ref={body} className="flex flex-col gap-4">
      {effort !== null && (
        <EffortSelect step={step} text={effort} onChange={(e) => edits.setEffort(step.id, e)} />
      )}
      <EnabledSwitch step={step} onChange={(enabled) => edits.setEnabled(step.id, enabled)} />
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{t('workflowPanel.placeInOrder')}</h3>
        <div className="flex flex-wrap gap-2">
          <MoveButton step={step} direction="up" onMove={move} />
          <MoveButton step={step} direction="down" onMove={move} />
        </div>
        {(step.moveBlocked.up ?? step.moveBlocked.down) && (
          <p data-move-reason className="text-xs text-muted-foreground">
            {[step.moveBlocked.up, step.moveBlocked.down]
              .filter((r): r is string => r !== null)
              .map(moveReason)
              .join('. ')}
            .
          </p>
        )}
      </section>
    </div>
  )
}

/** Move up or down one place: refused, with the reason in its tooltip, where the order would break. */
function MoveButton({
  step,
  direction,
  onMove,
}: {
  step: ResolvedStep
  direction: 'up' | 'down'
  onMove: (direction: 'up' | 'down') => void
}) {
  const { t } = useTranslation()
  const reason = step.moveBlocked[direction]
  const label = direction === 'up' ? t('workflowPanel.moveUp') : t('workflowPanel.moveDown')
  return (
    <Tip
      content={
        reason
          ? moveReason(reason)
          : t(direction === 'up' ? 'workflowPanel.moveUpTip' : 'workflowPanel.moveDownTip', {
              step: step.label,
            })
      }
    >
      <button
        type="button"
        aria-label={label}
        aria-disabled={reason !== null || undefined}
        data-move={`${step.id}:${direction}`}
        className={MOVE_BUTTON}
        onClick={() => reason === null && onMove(direction)}
      >
        {direction === 'up' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
        {label}
      </button>
    </Tip>
  )
}

/**
 * Whether the step runs. A locked step is always on and its switch is inert (the reason is written beside it);
 * the intent check is locked only above low, so its switch says whether it also runs for a low ticket.
 */
function EnabledSwitch({ step, onChange }: { step: ResolvedStep; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation()
  const aboveLow = step.lock === 'above-low'
  const locked = step.lock === 'always'
  const label = aboveLow
    ? t('workflowPanel.alsoRunOnLow', { step: step.label })
    : t('workflowPanel.run', { step: step.label })
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{t('workflowPanel.runs')}</h3>
      <div className="flex items-center gap-2.5">
        <Tip content={lockReasonText(step) ?? undefined}>
          <span className={cn('inline-flex', locked && 'cursor-not-allowed')}>
            <Switch
              checked={locked ? true : step.enabled}
              disabled={locked}
              aria-label={label}
              onCheckedChange={onChange}
            />
          </span>
        </Tip>
        <span aria-hidden className="text-sm">
          {label}
        </span>
      </div>
      {step.lockReason && (
        <p data-lock-reason className="text-xs text-muted-foreground">
          {lockReasonText(step)}
          {aboveLow && ` ${t('workflowPanel.aboveLowNote')}`}
        </p>
      )}
    </section>
  )
}

/** The effort of the agent that runs the step. Only steps that run an agent have one. */
function EffortSelect({
  step,
  text,
  onChange,
}: {
  step: ResolvedStep
  text: string
  onChange: (effort: WorkflowEffort) => void
}) {
  const { t } = useTranslation()
  const value = step.effort ?? 'auto'
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{t('workflowPanel.effort')}</h3>
      <Select
        value={value}
        onValueChange={(v) => v && v !== value && onChange(v as WorkflowEffort)}
        items={{ ...EFFORT_NAMES, [value]: text }}
      >
        <SelectTrigger aria-label={t('workflowPanel.effort')} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {WORKFLOW_EFFORTS.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {EFFORT_NAMES[effort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {t('workflowPanel.effortHint', { hint: autoEffortHint() })}
      </p>
    </section>
  )
}

/** The Review step's own settings: how many rounds each complexity gets, how its runs go and when a round survives. */
function ReviewSettings({
  review,
  workflow,
  complexity,
  edits,
  flightOf,
}: {
  review: ResolvedReview
  workflow: ResolvedWorkflow
  complexity: Complexity
  edits: WorkflowEdits
  flightOf: (level: Complexity) => RoundsFlight
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <RoundsEditor
        // Another preset is another field: nothing typed or still being saved on one carries to the other.
        key={workflow.preset}
        review={review}
        complexity={complexity}
        flightOf={flightOf}
        onChange={edits.setRounds}
      />
      {review.runs.length > 1 && (
        <p className="text-xs text-muted-foreground">
          {t('workflowPanel.reviewRuns', {
            total: review.runs.length,
            runs: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
              review.runs.map((r) => r.label.toLowerCase()),
            ),
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <Trans
          i18nKey="workflowPanel.survival"
          values={{ survival: survivalText(workflow.preset, review) }}
          components={{ strong: <span className="font-medium" /> }}
        />
      </p>
    </div>
  )
}
