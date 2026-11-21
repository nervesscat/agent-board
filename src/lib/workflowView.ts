import type { Complexity } from './constants'
import {
  WORKFLOW_STEPS,
  isWorkflowStep,
  type ResolvedStep,
  type ResolvedSubStep,
  type ResolvedWorkflow,
  type WorkflowEffort,
} from './workflow'

/** How the page writes each complexity (the picker and the rounds fields). */
export const COMPLEXITY_NAMES: Record<Complexity, string> = {
  low: 'Low',
  mid: 'Mid',
  high: 'High',
  max: 'Max',
}

export const EFFORT_NAMES: Record<WorkflowEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/** What `auto` follows, for the effort select's hint. */
export const AUTO_EFFORT_HINT =
  'Auto follows the ticket: low for a low ticket, medium for mid and high, high for max'

/** `1 round`, `3 rounds`, `no review rounds`. */
export const roundsText = (rounds: number): string =>
  rounds === 0 ? 'no review rounds' : `${rounds} round${rounds === 1 ? '' : 's'}`

/** The effort chip of a step: what is set, and with `auto` the level it comes to for the complexity shown. */
export function effortText(step: Pick<ResolvedStep, 'effort' | 'effortLevel'>): string | null {
  if (step.effort === null) return null
  if (step.effort === 'auto') return step.effortLevel ? `Auto: ${step.effortLevel}` : 'Auto'
  return EFFORT_NAMES[step.effort]
}

/** What the tree says about a step that does not run for the complexity shown. */
export function skipText(step: Pick<ResolvedStep, 'skipped'>): string | null {
  const reason = step.skipped?.reason
  if (!reason) return null
  if (reason === 'low') return 'Skipped on low'
  if (reason === 'rounds') return 'No review rounds'
  return 'Off'
}

/** One entry of a review round's list: a phase, or phases that run side by side. */
export type SubStepItem =
  | { kind: 'single'; step: ResolvedSubStep }
  | { kind: 'parallel'; group: string; steps: ResolvedSubStep[] }

/**
 * The phases of a round as the tree draws them: runs of neighbours that share a `parallel` group become one
 * parallel entry (verify and the hunts), every other phase stands alone, in order.
 */
export function groupSubSteps(steps: readonly ResolvedSubStep[]): SubStepItem[] {
  const items: SubStepItem[] = []
  for (const step of steps) {
    const last = items.at(-1)
    if (step.parallel && last?.kind === 'parallel' && last.group === step.parallel) last.steps.push(step)
    else if (step.parallel) items.push({ kind: 'parallel', group: step.parallel, steps: [step] })
    else items.push({ kind: 'single', step })
  }
  return items
}

/** The step's id for the DOM: ids of sub-steps carry dots (`review.hunt-a`). */
export const domId = (prefix: string, id: string): string => `${prefix}-${id.replace(/[^a-z0-9-]/gi, '-')}`

/**
 * Why a move is refused, for a tooltip: the board's words name steps by id (`build must come after spec`), the
 * page names them as the tree does (`Build must come after Spec`).
 */
export function moveReason(reason: string): string {
  const named = reason.replace(/[a-z0-9]+/g, (word) =>
    isWorkflowStep(word) ? WORKFLOW_STEPS[word].label : word,
  )
  return named.charAt(0).toUpperCase() + named.slice(1)
}

/**
 * The ids of every node that opens into others: a step with phases (the review), the phases that hold phases
 * (each full review of the Maximum preset) and the review's `between rounds`. What "Collapse all" closes.
 */
export function expandableIds(workflow: Pick<ResolvedWorkflow, 'steps'>): string[] {
  const ids: string[] = []
  const walk = (list: readonly ResolvedSubStep[]) => {
    for (const s of list) {
      if (s.children.length) ids.push(s.id)
      walk(s.children)
    }
  }
  for (const step of workflow.steps) {
    if (!step.review) continue
    ids.push(step.id, 'review.between')
    walk(step.review.phases)
  }
  return ids
}
