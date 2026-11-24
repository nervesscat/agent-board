import { shared } from '#/i18n'

import type { Complexity } from './constants'
import {
  ROUND_INTENT_ID,
  WORKFLOW_STEPS,
  isWorkflowStep,
  type ResolvedReview,
  type ResolvedStep,
  type ResolvedSubStep,
  type WorkflowEffort,
  type WorkflowPresetId,
} from './workflow'

/**
 * The words below are read when they are drawn (a getter, not a constant), so they follow the language the
 * interface is in at that moment.
 */

/** How the page writes each complexity (the picker and the rounds fields). */
export const COMPLEXITY_NAMES: Record<Complexity, string> = {
  get low() {
    return shared.t('workflowView.complexity.low')
  },
  get mid() {
    return shared.t('workflowView.complexity.mid')
  },
  get high() {
    return shared.t('workflowView.complexity.high')
  },
  get max() {
    return shared.t('workflowView.complexity.max')
  },
}

export const EFFORT_NAMES: Record<WorkflowEffort, string> = {
  get auto() {
    return shared.t('workflowView.effort.auto')
  },
  get low() {
    return shared.t('workflowView.effort.low')
  },
  get medium() {
    return shared.t('workflowView.effort.medium')
  },
  get high() {
    return shared.t('workflowView.effort.high')
  },
}

/** What `auto` follows, for the effort select's hint. */
export const autoEffortHint = (): string => shared.t('workflowView.autoEffortHint')

/** `1 round`, `3 rounds`, `no review rounds`. */
export const roundsText = (rounds: number): string =>
  rounds === 0 ? shared.t('workflowView.noRounds') : shared.t('workflowView.rounds', { count: rounds })

/** The effort chip of a step: what is set, and with `auto` the level it comes to for the complexity shown. */
export function effortText(step: Pick<ResolvedStep, 'effort' | 'effortLevel'>): string | null {
  if (step.effort === null) return null
  if (step.effort === 'auto')
    return step.effortLevel
      ? shared.t('workflowView.autoLevel', {
          level: shared.t(`workflowView.effortLevel.${step.effortLevel}`),
        })
      : EFFORT_NAMES.auto
  return EFFORT_NAMES[step.effort]
}

/** What the graph says about a step that does not run for the complexity shown. */
export function skipText(step: Pick<ResolvedStep, 'skipped'>): string | null {
  const reason = step.skipped?.reason
  if (!reason) return null
  if (reason === 'low') return shared.t('workflowChips.skippedOnLow')
  if (reason === 'rounds') return shared.t('workflowView.skippedNoRounds')
  return shared.t('workflowView.skippedOff')
}

/**
 * Why a step cannot be turned off, for its tooltip. `ResolvedStep.lockReason` is the same sentence in English:
 * the served text and the MCP answer keep it, and this one follows the interface's language.
 */
export function lockReasonText(step: Pick<ResolvedStep, 'id' | 'lock' | 'lockReason'>): string | null {
  if (step.lockReason === null) return null
  switch (step.id) {
    case 'claim':
      return shared.t('workflowView.lockReason.claim')
    case 'build':
      return shared.t('workflowView.lockReason.build')
    case 'gate':
      return shared.t('workflowView.lockReason.gate')
    case 'intent':
      return shared.t('workflowView.lockReason.intent')
    default:
      return step.lock === 'always' ? shared.t('workflowView.lockReason.always') : step.lockReason
  }
}

/**
 * When a round of the review survives, in a sentence: the same rule as `ResolvedReview.survival` (which stays
 * English, for the served text), in the interface's language. The round-end intent check is a clause of the
 * rule only while the resolved review has it as a phase.
 */
export function survivalText(preset: WorkflowPresetId, review: Pick<ResolvedReview, 'phases'>): string {
  const intent = review.phases.some((p) => p.id === ROUND_INTENT_ID)
  const standard = shared.t('workflowView.survival.standard')
  if (preset === 'light') return shared.t('workflowView.survival.light')
  if (preset === 'maximum')
    return shared.t(intent ? 'workflowView.survival.maximumIntent' : 'workflowView.survival.maximum', {
      standard,
    })
  return intent ? shared.t('workflowView.survival.thoroughIntent') : standard
}

/** One entry of a review round's list: a phase, or phases that run side by side. */
export type SubStepItem =
  | { kind: 'single'; step: ResolvedSubStep }
  | { kind: 'parallel'; group: string; steps: ResolvedSubStep[] }

/**
 * The phases of a round as the graph draws them: runs of neighbours that share a `parallel` group become one
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
 * page names them as the graph does (`Build must come after Spec`) and in the interface's language. A reason
 * this does not know is shown as the board wrote it, with the ids named.
 */
export function moveReason(reason: string): string {
  const label = (id: string): string => (isWorkflowStep(id) ? WORKFLOW_STEPS[id].label : id)
  const after = /^([a-z0-9]+) must come after ([a-z0-9]+)$/.exec(reason)
  if (after) return shared.t('workflowView.move.after', { step: label(after[1]!), other: label(after[2]!) })
  const stay = /^([a-z0-9]+) must stay (first|last)$/.exec(reason)
  if (stay)
    return shared.t(stay[2] === 'first' ? 'workflowView.move.stayFirst' : 'workflowView.move.stayLast', {
      step: label(stay[1]!),
    })
  const already = /^([a-z0-9]+) is already (first|last)$/.exec(reason)
  if (already)
    return shared.t(
      already[2] === 'first' ? 'workflowView.move.alreadyFirst' : 'workflowView.move.alreadyLast',
      {
        step: label(already[1]!),
      },
    )
  const named = reason.replace(/[a-z0-9]+/g, (word) => label(word))
  return named.charAt(0).toUpperCase() + named.slice(1)
}
