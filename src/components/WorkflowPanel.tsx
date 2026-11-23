import { ArrowDown, ArrowUp, MinusCircle, MousePointerClick, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

import { ChangedChip, Chip } from '#/components/WorkflowChips'
import { RoundsEditor, type RoundsFlight } from '#/components/WorkflowReview'
import { Dialog, DialogContent, DialogTitle } from '#/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import type { Complexity } from '#/lib/constants'
import {
  WORKFLOW_EFFORTS,
  type ResolvedReview,
  type ResolvedStep,
  type ResolvedWorkflow,
  type WorkflowEffort,
  type WorkflowStepId,
} from '#/lib/workflow'
import { defaultAgentName, nodeView, type GraphNode, type NodeView } from '#/lib/workflowGraph'
import { AUTO_EFFORT_HINT, EFFORT_NAMES, effortText, moveReason } from '#/lib/workflowView'
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
  /** Takes the step out of the workflow; only a custom workflow has steps to remove. */
  remove?: (id: WorkflowStepId) => void
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
  return (
    <div
      data-panel="idle"
      className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
    >
      <MousePointerClick className="size-5" aria-hidden />
      <p>
        Select a step in the graph to see what it does and to change who runs it, its effort, whether it runs
        and its place in the order.
      </p>
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
  const view = nodeView(node)
  const step = node.kind === 'step' ? node.step : null
  const complexity = workflow.complexity ?? 'mid'
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start gap-2 pr-8 sm:pr-0">
        <div className="min-w-0 flex-1 space-y-1.5">
          {heading}
          <div className="flex flex-wrap items-center gap-1">
            {view.lock && <Chip tone="lock">{view.lock === 'always' ? 'Locked' : 'Locked above low'}</Chip>}
            {view.skipped && <Chip tone="skipped">{view.skipped}</Chip>}
            {!view.skipped && view.skipsOnLow && <Chip tone="skipped">Skipped on low</Chip>}
            {view.changed && <ChangedChip what={view.changed} />}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {view.team ? (
        <TeamPicker view={view} team={team} onPick={(name) => edits.setAgent(node.id, name)} />
      ) : step?.agent === 'runner' ? (
        <p data-review-agents className="text-sm text-muted-foreground">
          The ticket agent runs /feature-review itself. Its phases run their own Team agents, picked on the
          phase nodes.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          The ticket agent does this itself: there is no Team agent to pick.
        </p>
      )}

      {step && <StepSettings step={step} edits={edits} workflow={workflow} />}

      <section className="space-y-1">
        <h3 className="text-xs font-medium text-muted-foreground">What it does</h3>
        <p data-what className="text-sm leading-relaxed">
          {node.step.what}
        </p>
      </section>

      {node.kind === 'step' && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {node.next ? `Hand-off to ${node.next}` : 'Result'}
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
  return (
    <button
      type="button"
      aria-label="Close"
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
  const ref = view.team!
  const fallback = defaultAgentName(view.role, team)
  const value = ref.picked ?? DEFAULT_PICK
  const items: Record<string, string> = { [DEFAULT_PICK]: `Default (${fallback})` }
  for (const name of team) items[name] = name
  // A pick the Team lost stays in the list: it can be seen, and cleared by choosing the default.
  if (ref.missing && ref.picked !== null) items[ref.picked] = `${ref.picked} (not in the Team)`
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Team agent</h3>
      <Select
        value={value}
        items={items}
        onValueChange={(v) => v && v !== value && onPick(v === DEFAULT_PICK ? null : v)}
      >
        <SelectTrigger aria-label="Team agent" className="w-full">
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
          {ref.picked} was picked for it, but the Team has no agent of that name now. It runs as {ref.name}{' '}
          until the agent is back or another is picked. Choose Default to clear the pick.
        </p>
      ) : (
        <p className="text-xs wrap-anywhere text-muted-foreground">
          Runs as {ref.name}
          {ref.source === 'default' && ' (the built-in agent: the Team has none of that name)'}. Its
          instructions are written on the Team page; the role ({view.role}) names its spans and run reports.
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
  const body = useRef<HTMLDivElement>(null)
  // After a move the step is somewhere else in the list: the keyboard stays on the button that moved it.
  const moved = useRef<{ id: string; direction: 'up' | 'down'; preset: string } | null>(null)
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
        <h3 className="text-xs font-medium text-muted-foreground">Place in the order</h3>
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
      {edits.remove && <RemoveStep step={step} onRemove={() => edits.remove?.(step.id)} />}
    </div>
  )
}

/**
 * Takes a step out of a custom workflow. A step with a lock cannot go, and says so: the lock's own reason is
 * already shown under its switch. The kind can be added again from the page's Add a step list.
 */
function RemoveStep({ step, onRemove }: { step: ResolvedStep; onRemove: () => void }) {
  const removable = step.lock === null && step.id !== 'claim' && step.id !== 'handoff'
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">In this workflow</h3>
      {removable ? (
        <>
          <button type="button" data-remove-step={step.id} className={MOVE_BUTTON} onClick={onRemove}>
            <MinusCircle className="size-3.5" aria-hidden /> Remove step
          </button>
          <p className="text-xs text-muted-foreground">
            Takes {step.label} out of this workflow. Add it again from Add a step above the graph.
          </p>
        </>
      ) : (
        <p data-remove-reason className="text-xs text-muted-foreground">
          {step.label} is{' '}
          {step.id === 'claim'
            ? 'always the first step'
            : step.id === 'handoff'
              ? 'always the last step'
              : 'locked'}
          , so it cannot be removed.
        </p>
      )}
    </section>
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
  const reason = step.moveBlocked[direction]
  const label = direction === 'up' ? 'Move up' : 'Move down'
  return (
    <Tip
      content={
        reason
          ? moveReason(reason)
          : `${label}: ${step.label} runs ${direction === 'up' ? 'earlier' : 'later'}`
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
  const aboveLow = step.lock === 'above-low'
  const locked = step.lock === 'always'
  const label = aboveLow ? `Also run ${step.label} on low tickets` : `Run ${step.label}`
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Runs</h3>
      <div className="flex items-center gap-2.5">
        <Tip content={step.lockReason ?? undefined}>
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
          {step.lockReason}
          {aboveLow && ' This switch only decides whether it also runs for a low ticket.'}
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
  const value = step.effort ?? 'auto'
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Effort</h3>
      <Select
        value={value}
        onValueChange={(v) => v && v !== value && onChange(v as WorkflowEffort)}
        items={{ ...EFFORT_NAMES, [value]: text }}
      >
        <SelectTrigger aria-label="Effort" className="w-full">
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
        Passed on as the Agent tool&apos;s effort. {AUTO_EFFORT_HINT}.
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
          Runs {review.runs.length} separate /feature-review runs each round:{' '}
          {review.runs.map((r) => r.label.toLowerCase()).join(' and ')}, each under its own agent name and
          never shown the other&apos;s findings.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">A round survives when</span> {review.survival}.
      </p>
    </div>
  )
}
