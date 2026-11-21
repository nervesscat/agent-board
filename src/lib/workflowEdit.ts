import { COMPLEXITIES, type Complexity } from './constants'
import {
  INSTRUCTIONS_MAX,
  ROUNDS_MAX,
  type PresetTweak,
  type StepTweak,
  type WorkflowEffort,
  type WorkflowStepId,
} from './workflow'

/**
 * What the Workflow page sends when the human changes one thing: the preset's tweak as it is now, with
 * that one change made. The board replaces a preset's saved tweak with what it is sent (no merge), and
 * drops what equals the preset's own, so these only have to say what was asked: a step's switch back
 * on, an effort back to the preset's or an instruction cleared is left out, never saved as a value.
 */

/** The tweak of one step with `change` applied; undefined when nothing is left of it. */
function stepWith(own: StepTweak | undefined, change: Partial<Record<keyof StepTweak, unknown>>) {
  const next: Record<string, unknown> = { ...own }
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return Object.keys(next).length ? (next as StepTweak) : undefined
}

function withStep(tweak: PresetTweak | null, id: WorkflowStepId, own: StepTweak | undefined): PresetTweak {
  const steps = { ...tweak?.steps }
  if (own) steps[id] = own
  else delete steps[id]
  const next: PresetTweak = { ...tweak }
  if (Object.keys(steps).length) next.steps = steps
  else delete next.steps
  return next
}

/** A step switched on or off. On is the default, so it removes the saved off. */
export const withEnabled = (tweak: PresetTweak | null, id: WorkflowStepId, enabled: boolean): PresetTweak =>
  withStep(tweak, id, stepWith(tweak?.steps?.[id], { enabled: enabled ? undefined : false }))

/** A step's effort set. */
export const withEffort = (
  tweak: PresetTweak | null,
  id: WorkflowStepId,
  effort: WorkflowEffort,
): PresetTweak => withStep(tweak, id, stepWith(tweak?.steps?.[id], { effort }))

/** A step's hand-off instruction set, or with null put back to the default. */
export const withInstructions = (
  tweak: PresetTweak | null,
  id: WorkflowStepId,
  instructions: string | null,
): PresetTweak =>
  withStep(tweak, id, stepWith(tweak?.steps?.[id], { instructions: instructions ?? undefined }))

/** The review rounds for one complexity set. */
export const withRounds = (tweak: PresetTweak | null, level: Complexity, rounds: number): PresetTweak => ({
  ...tweak,
  rounds: { ...tweak?.rounds, [level]: rounds },
})

/** The steps in a new order. */
export const withOrder = (tweak: PresetTweak | null, order: readonly WorkflowStepId[]): PresetTweak => ({
  ...tweak,
  order: [...order],
})

/** The body of the PUT for a tweak: only what is set, in the shape the board checks. */
export function tweakBody(tweak: PresetTweak): PresetTweak {
  const body: PresetTweak = {}
  if (tweak.order) body.order = tweak.order
  if (tweak.steps && Object.keys(tweak.steps).length) body.steps = tweak.steps
  if (tweak.rounds && COMPLEXITIES.some((level) => tweak.rounds![level] !== undefined))
    body.rounds = tweak.rounds
  return body
}

/**
 * What typing `text` in a round count says: the number, or why it is not one. Blank, fractions and anything
 * past the range are refused with the range in the words, so the field can show it where it is typed.
 */
export function parseRounds(text: string): { ok: true; rounds: number } | { ok: false; error: string } {
  const range = `Rounds are a whole number from 0 to ${ROUNDS_MAX}`
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: range }
  const rounds = Number(trimmed)
  return rounds > ROUNDS_MAX ? { ok: false, error: range } : { ok: true, rounds }
}

/** What is wrong with a hand-off instruction typed, or null: it is counted as it is saved (trimmed). */
export function instructionsProblem(text: string): string | null {
  const length = text.trim().length
  if (length > INSTRUCTIONS_MAX)
    return `${length - INSTRUCTIONS_MAX} characters over the limit of ${INSTRUCTIONS_MAX}`
  return null
}
