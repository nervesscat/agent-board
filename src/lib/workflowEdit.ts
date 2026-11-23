import { COMPLEXITIES, type Complexity } from './constants'
import {
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
 * on, an effort back to the preset's or a Team agent put back to the default is left out, never saved as a value.
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

/**
 * The Team agent of a node (a step id or a review phase's id) set, or with null put back to the default.
 * What is kept for the other nodes is sent back as it is, a pick whose agent has left the Team included.
 */
export function withAgent(tweak: PresetTweak | null, nodeId: string, agent: string | null): PresetTweak {
  const agents = { ...tweak?.agents }
  if (agent === null) delete agents[nodeId]
  else agents[nodeId] = agent
  const next: PresetTweak = { ...tweak }
  if (Object.keys(agents).length) next.agents = agents
  else delete next.agents
  return next
}

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

/**
 * A step taken out of a custom workflow: the new step list, and nothing left of the step in the tweak (its
 * switch and effort, the Team agent of its node, and for the review the Team agent of every phase of its
 * round), since the board refuses a setting for a step the workflow does not have.
 */
export function withoutStep(
  tweak: PresetTweak | null,
  id: WorkflowStepId,
  order: readonly WorkflowStepId[],
): PresetTweak {
  const next = withOrder(tweak, order)
  if (next.steps && id in next.steps) {
    const { [id]: _gone, ...rest } = next.steps
    if (Object.keys(rest).length) next.steps = rest
    else delete next.steps
  }
  if (next.agents) {
    const kept = Object.fromEntries(
      Object.entries(next.agents).filter(
        ([node]) => node !== id && !(id === 'review' && node.startsWith('review.')),
      ),
    )
    if (Object.keys(kept).length) next.agents = kept
    else delete next.agents
  }
  return next
}

/** The body of the PUT for a tweak: only what is set, in the shape the board checks. */
export function tweakBody(tweak: PresetTweak): PresetTweak {
  const body: PresetTweak = {}
  if (tweak.order) body.order = tweak.order
  if (tweak.steps && Object.keys(tweak.steps).length) body.steps = tweak.steps
  if (tweak.agents && Object.keys(tweak.agents).length) body.agents = tweak.agents
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
