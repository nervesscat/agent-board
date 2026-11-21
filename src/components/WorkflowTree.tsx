import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef } from 'react'

import { AgentChip, Chip, EditedChip, LockChip } from '#/components/WorkflowChips'
import { WorkflowHandoff } from '#/components/WorkflowHandoff'
import { ReviewBody } from '#/components/WorkflowReview'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import {
  WORKFLOW_EFFORTS,
  resolveWorkflow,
  type ResolvedStep,
  type ResolvedWorkflow,
  type WorkflowEffort,
  type WorkflowPresetId,
  type WorkflowStepId,
} from '#/lib/workflow'
import {
  AUTO_EFFORT_HINT,
  EFFORT_NAMES,
  domId,
  effortText,
  moveReason,
  roundsText,
  skipText,
} from '#/lib/workflowView'
import { cn } from '#/lib/utils'

/** What the human can change on the tree: each call saves at once (the page owns the saving). */
export interface WorkflowEdits {
  setEnabled: (id: WorkflowStepId, enabled: boolean) => void
  setEffort: (id: WorkflowStepId, effort: WorkflowEffort) => void
  /**
   * The instruction to keep, or null for the preset's. Answers with the reason it was not saved, or null once
   * it was, so the editor stays open on a refusal.
   */
  setInstructions: (id: WorkflowStepId, instructions: string | null) => Promise<string | null>
  /** Answers with the reason the count was not saved, or null once it was; the field goes back to the saved count. */
  setRounds: (level: Complexity, rounds: number) => Promise<string | null>
  move: (id: WorkflowStepId, direction: 'up' | 'down') => void
}

/** What a step's edits are, in words, for its "edited" marker. */
function editedWhat(step: ResolvedStep): string {
  const parts = [
    step.edited.moved && 'its place in the order',
    step.edited.enabled && 'turned off',
    step.edited.effort && 'its effort',
    step.edited.instructions && 'its hand-off instruction',
  ].filter((p): p is string => Boolean(p))
  return parts.join(', ')
}

const STEP_BUTTON =
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent'

/**
 * The workflow as a tree: the steps in the order a ticket's agent runs them, each a numbered node with its
 * agent, effort, lock and what the human changed, and the hand-off to the next one drawn between them. A
 * step with parts (the review) opens into them. Every setting is editable where it is shown.
 */
export function WorkflowTree({
  workflow,
  edits,
  collapsed,
  onToggle,
}: {
  workflow: ResolvedWorkflow
  edits: WorkflowEdits
  /** The nodes the reader closed (everything else is open). */
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const complexity = workflow.complexity ?? 'mid'
  // After a move the step is somewhere else in the list: the keyboard stays on the button that moved it.
  const moved = useRef<string | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const order = workflow.order.join()
  // The same preset and tweaks at the other complexities: a hand-off whose default reads differently there.
  const others = useMemo(
    () =>
      COMPLEXITIES.filter((level) => level !== complexity).map((level) =>
        resolveWorkflow(workflow.preset, workflow.tweak, level),
      ),
    [workflow.preset, workflow.tweak, complexity],
  )
  useLayoutEffect(() => {
    const target = moved.current
    if (!target) return
    moved.current = null
    const [id, direction] = target.split(':') as [string, 'up' | 'down']
    const find = (d: string) => list.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${d}"]`)
    const button = find(direction)
    // At an end the button is inert now: the other arrow takes the focus.
    const inert = button?.getAttribute('aria-disabled') === 'true'
    ;(inert ? find(direction === 'up' ? 'down' : 'up') : button)?.focus()
  }, [order])
  return (
    <ol
      ref={list}
      role="tree"
      aria-label={`${workflow.label} workflow for a ${complexity} ticket`}
      className="space-y-0"
    >
      {workflow.steps.map((step, i) => (
        <StepNode
          key={step.id}
          step={step}
          next={workflow.steps[i + 1]?.label ?? null}
          last={i === workflow.steps.length - 1}
          preset={workflow.preset}
          complexity={complexity}
          handoffVaries={others.some(
            (w) => w.steps.find((o) => o.id === step.id)?.handoffDefault !== step.handoffDefault,
          )}
          edits={edits}
          open={!collapsed.has(step.id)}
          collapsed={collapsed}
          onToggle={onToggle}
          onMove={(direction) => {
            moved.current = `${step.id}:${direction}`
            edits.move(step.id, direction)
          }}
        />
      ))}
    </ol>
  )
}

function StepNode({
  step,
  next,
  last,
  preset,
  complexity,
  handoffVaries,
  edits,
  open,
  collapsed,
  onToggle,
  onMove,
}: {
  step: ResolvedStep
  next: string | null
  last: boolean
  preset: WorkflowPresetId
  complexity: Complexity
  /** Whether this step's default hand-off reads differently at another complexity. */
  handoffVaries: boolean
  edits: WorkflowEdits
  open: boolean
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onMove: (direction: 'up' | 'down') => void
}) {
  const title = domId('wf-title', step.id)
  const skip = skipText(step)
  const off = step.skipped !== null
  const review = step.review
  const effort = effortText(step)
  return (
    <li
      role="treeitem"
      aria-level={1}
      aria-labelledby={title}
      aria-expanded={review ? open : undefined}
      data-step={step.id}
      data-skipped={off || undefined}
      className="relative pb-3 last:pb-0"
    >
      {/* The rail the numbers sit on: one line down the whole tree, behind the numbers and the hand-off marks. */}
      {!last && (
        <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px -translate-x-1/2 bg-border" />
      )}
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
        <div className="flex justify-center" aria-hidden>
          <span
            data-number
            className={cn(
              'z-[1] flex size-8 items-center justify-center rounded-full border text-sm font-semibold',
              off
                ? 'border-dashed bg-background text-muted-foreground'
                : 'border-primary bg-primary text-primary-foreground',
            )}
          >
            {step.number ?? '–'}
          </span>
        </div>
        <div
          className={cn(
            'min-w-0 rounded-lg border bg-card p-3 shadow-xs',
            off && 'border-dashed bg-transparent shadow-none',
          )}
        >
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className={cn('min-w-0 flex-1 basis-full space-y-1.5 sm:basis-44', off && 'opacity-70')}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span
                  id={title}
                  className={cn('text-sm font-semibold', off && 'text-muted-foreground line-through')}
                >
                  {step.number !== null && <span className="sr-only">{step.number}. </span>}
                  {step.label}
                </span>
                <AgentChip agent={step.agent} label={step.agentLabel} />
                {effort !== null && (
                  <EffortSelect step={step} text={effort} onChange={(e) => edits.setEffort(step.id, e)} />
                )}
                {review && !step.skipped && (
                  <Chip tone="rounds">{roundsText(review.roundsByComplexity[complexity])}</Chip>
                )}
                {step.lock && <LockChip lock={step.lock} reason={step.lockReason} />}
                {skip && (
                  <Chip tone="skipped" tip={step.skipped?.note}>
                    {skip}
                  </Chip>
                )}
                {!skip && step.skipsOnLow && (
                  <Chip
                    tone="skipped"
                    tip="A low ticket skips this step: it gets no spec, extra passes or review"
                  >
                    Skipped on low
                  </Chip>
                )}
                {step.edited.any && <EditedChip what={editedWhat(step)} />}
              </div>
              <p className={cn('text-xs text-muted-foreground', off && 'opacity-80')}>{step.what}</p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {review && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${step.label}`}
                  onClick={() => onToggle(step.id)}
                >
                  {open ? <ChevronDown /> : <ChevronRight />}
                </Button>
              )}
              <MoveButton step={step} direction="up" onMove={onMove} />
              <MoveButton step={step} direction="down" onMove={onMove} />
              <EnabledSwitch step={step} onChange={(enabled) => edits.setEnabled(step.id, enabled)} />
            </div>
          </div>
          {review && open && (
            <ReviewBody
              review={review}
              complexity={complexity}
              level={2}
              collapsed={collapsed}
              onToggle={onToggle}
              onRounds={edits.setRounds}
            />
          )}
        </div>
      </div>
      {/* An editor opened on one view (preset, complexity) does not carry its draft to another. */}
      <WorkflowHandoff
        key={`${preset}:${complexity}`}
        step={step}
        next={next}
        last={last}
        complexity={complexity}
        defaultVaries={handoffVaries}
        onSave={(instructions) => edits.setInstructions(step.id, instructions)}
      />
    </li>
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
  const label = `Move ${step.label} ${direction}`
  return (
    <Tip content={reason ? moveReason(reason) : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        data-move={`${step.id}:${direction}`}
        disabled={reason !== null}
        focusableWhenDisabled
        className={STEP_BUTTON}
        onClick={() => onMove(direction)}
      >
        {direction === 'up' ? <ArrowUp /> : <ArrowDown />}
      </Button>
    </Tip>
  )
}

/**
 * Whether the step runs. A locked step is always on and its switch is inert (the tooltip says why); the intent
 * check is locked only above low, so its switch says whether it also runs for a low ticket.
 */
function EnabledSwitch({ step, onChange }: { step: ResolvedStep; onChange: (enabled: boolean) => void }) {
  if (step.lock === 'always')
    return (
      <Tip content={step.lockReason}>
        <span
          tabIndex={0}
          className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Switch
            checked
            disabled
            aria-label={`Run ${step.label}`}
            tabIndex={-1}
            className="pointer-events-none"
          />
        </span>
      </Tip>
    )
  const aboveLow = step.lock === 'above-low'
  return (
    <Tip
      content={
        aboveLow
          ? `${step.lockReason}\nThis switch only decides whether it also runs for a low ticket.`
          : step.enabled
            ? `Turn off to skip ${step.label}`
            : `Turn on to run ${step.label} again`
      }
    >
      <Switch
        checked={step.enabled}
        aria-label={aboveLow ? `Also run ${step.label} on low tickets` : `Run ${step.label}`}
        onCheckedChange={onChange}
      />
    </Tip>
  )
}

/** The effort chip, which is also the select that changes it. Only steps that run an agent have one. */
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
    <Select
      value={value}
      onValueChange={(v) => v && v !== value && onChange(v as WorkflowEffort)}
      items={{ ...EFFORT_NAMES, [value]: text }}
    >
      <Tip
        content={`Effort of the ${step.label} agent, passed on as the Agent tool's effort. ${AUTO_EFFORT_HINT}.`}
      >
        <SelectTrigger
          size="sm"
          aria-label={`Effort of ${step.label}`}
          className="h-5 min-h-0 gap-0.5 rounded-full border-transparent bg-violet-500/10 py-0 pr-1 pl-2 text-[11px] leading-none font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-400 dark:hover:bg-violet-500/20"
        >
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent>
        {WORKFLOW_EFFORTS.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {EFFORT_NAMES[effort]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
