import { currentLocale, shared } from '#/i18n'

import type { Complexity } from './constants'
import {
  defaultTeamAgent,
  type ResolvedStep,
  type ResolvedSubStep,
  type ResolvedWorkflow,
  type TeamAgentRef,
} from './workflow'
import { effortText, groupSubSteps, lockReasonText, roundsText, skipText } from './workflowView'

/**
 * What the Workflow page draws as a graph, worked out from the resolved workflow alone: which nodes there are,
 * in what order, which of a round's phases run side by side and which frame holds which, and the words each
 * node is read by. The layout is automatic (nothing here is stored or dragged); this file only decides what
 * goes where, the component draws it.
 */

/** One row of a review round, top to bottom: a phase, phases side by side, or a full review framed on its own. */
export type RoundRow =
  | { kind: 'node'; step: ResolvedSubStep }
  | { kind: 'parallel'; group: string; steps: ResolvedSubStep[] }
  | { kind: 'frame'; step: ResolvedSubStep; rows: RoundRow[] }

/**
 * The rows of a round. Phases that share a `parallel` group become one row that forks and joins again; a
 * phase that holds phases (each of Maximum's two full reviews) is a frame with its own rows, a sibling of the
 * other and never inside it. A group of one is not parallel with anything and is drawn as a plain node.
 */
export function roundRows(phases: readonly ResolvedSubStep[]): RoundRow[] {
  return groupSubSteps(phases).map((item): RoundRow => {
    if (item.kind === 'parallel')
      return item.steps.length > 1
        ? { kind: 'parallel', group: item.group, steps: item.steps }
        : { kind: 'node', step: item.steps[0]! }
    return item.step.children.length
      ? { kind: 'frame', step: item.step, rows: roundRows(item.step.children) }
      : { kind: 'node', step: item.step }
  })
}

/** What the loop-back arrow of the round says: the count for the ticket's complexity, `No review rounds on low`. */
export function loopLabel(rounds: number, complexity: Complexity): string {
  return rounds > 0
    ? roundsText(rounds)
    : shared.t('workflowGraph.noRoundsOn', { complexity: shared.t(`workflowGraph.complexity.${complexity}`) })
}

/** A node of the graph a person can select: a step of the workflow, or a phase of the review round. */
export type GraphNode =
  | { kind: 'step'; id: string; step: ResolvedStep; next: string | null }
  | { kind: 'phase'; id: string; step: ResolvedSubStep }

const phasesOf = (rows: readonly RoundRow[]): ResolvedSubStep[] =>
  rows.flatMap((row) =>
    row.kind === 'node' ? [row.step] : row.kind === 'parallel' ? row.steps : phasesOf(row.rows),
  )

/** Every node in reading order: each step, and after the review its phases, then the fix pass and the gate. */
export function graphNodes(workflow: Pick<ResolvedWorkflow, 'steps'>): GraphNode[] {
  const nodes: GraphNode[] = []
  workflow.steps.forEach((step, i) => {
    // The hand-off goes to the next step that runs: a step skipped for this ticket or switched off is passed over.
    const next = workflow.steps.slice(i + 1).find((s) => !s.skipped)
    nodes.push({ kind: 'step', id: step.id, step, next: next?.label ?? null })
    if (!step.review) return
    for (const phase of [...phasesOf(roundRows(step.review.phases)), ...step.review.between])
      nodes.push({ kind: 'phase', id: phase.id, step: phase })
  })
  return nodes
}

/** The node with this id, or null when the workflow no longer has it (another preset, a step turned out of it). */
export const findNode = (workflow: Pick<ResolvedWorkflow, 'steps'>, id: string | null): GraphNode | null =>
  id === null ? null : (graphNodes(workflow).find((n) => n.id === id) ?? null)

/** What a node shows, whether it is a step or a phase. */
export interface NodeView {
  id: string
  /** `3` for a step, `5.3` for a phase; null for a step that does not run. */
  number: string | null
  label: string
  /** The Team agent that runs it; null where the ticket agent does. */
  team: TeamAgentRef | null
  /** Who runs it when no Team agent does: `you`. */
  agentLabel: string
  /** The role the Team agent runs it as (`builder`, `hunt`): spans and run reports are named by it. */
  role: string
  lock: 'always' | 'above-low' | null
  lockReason: string | null
  /** `Off`, `Skipped on low`, `No review rounds`; null when it runs. */
  skipped: string | null
  /** A step a low ticket skips, shown on a ticket that is not low as a note. */
  skipsOnLow: boolean
  /** The effort chip's text; null when it runs no agent. */
  effort: string | null
  /** The human changed something on it, in words (`its Team agent`); null when nothing. */
  changed: string | null
  /** What it reads as: `3. Build, agent builder, locked`. */
  name: string
}

/** The words for what the human changed on a step, for its marker. */
export function changedText(step: Pick<ResolvedStep, 'edited'>): string | null {
  const parts = [
    step.edited.moved && shared.t('workflowView.changed.moved'),
    step.edited.enabled && shared.t('workflowView.changed.off'),
    step.edited.effort && shared.t('workflowView.changed.effort'),
    step.edited.agent && shared.t('workflowView.changed.agent'),
  ].filter((p): p is string => Boolean(p))
  return parts.length ? parts.join(shared.t('workflowView.separator')) : null
}

function readAs(view: Omit<NodeView, 'name'>, numbered: boolean): string {
  const who = view.team ? view.team.name : view.agentLabel
  const states = [
    view.lock && shared.t('workflowView.name.locked'),
    view.skipped?.toLocaleLowerCase(currentLocale()) ??
      (view.skipsOnLow ? shared.t('workflowView.name.skipsOnLow') : null),
    view.team?.missing && shared.t('workflowChips.agentMissing'),
    view.changed && shared.t('workflowChips.changed'),
  ].filter((s): s is string => Boolean(s))
  const title = view.number === null ? view.label : `${view.number}${numbered ? '.' : ''} ${view.label}`
  return [title, shared.t('workflowView.name.agent', { name: who }), ...states].join(
    shared.t('workflowView.separator'),
  )
}

/** Who runs a node when no Team agent does: `you` is the ticket agent (a word), a role (`/feature-review`) is a name. */
const agentLabelText = (node: Pick<ResolvedStep, 'agent' | 'agentLabel'>): string =>
  node.agent === 'you' ? shared.t('workflowView.you') : node.agentLabel

export function stepView(step: ResolvedStep): NodeView {
  const view = {
    id: step.id,
    number: step.number === null ? null : String(step.number),
    label: step.label,
    team: step.teamAgent,
    agentLabel: agentLabelText(step),
    role: step.agent,
    lock: step.lock,
    lockReason: lockReasonText(step),
    skipped: skipText(step),
    skipsOnLow: step.skipped === null && step.skipsOnLow,
    effort: effortText(step),
    changed: changedText(step),
  }
  return { ...view, name: readAs(view, true) }
}

export function phaseView(phase: ResolvedSubStep): NodeView {
  const view = {
    id: phase.id,
    number: phase.number,
    label: phase.label,
    team: phase.teamAgent,
    agentLabel: agentLabelText(phase),
    role: phase.agent,
    lock: null,
    lockReason: null,
    skipped: null,
    skipsOnLow: false,
    effort: null,
    changed: phase.teamAgent?.picked != null ? shared.t('workflowView.changed.agent') : null,
  }
  return { ...view, name: readAs(view, false) }
}

/** The node's view, for either kind. */
export const nodeView = (node: GraphNode): NodeView =>
  node.kind === 'step' ? stepView(node.step) : phaseView(node.step)

/** What a node with no pick runs: the Team agent named like its role, else the role's built-in agent. */
export function defaultAgentName(role: string, team: readonly string[]): string {
  return role === 'you' ? role : defaultTeamAgent(role as Exclude<ResolvedStep['agent'], 'you'>, team).name
}

/**
 * The columns of a row of parallel phases at most: the row is drawn side by side only when the room is there
 * and stacks below that, so a phone never gets a row of cards too narrow for their words. Capped at four (the
 * most a preset runs side by side); a larger group wraps after the fourth.
 */
export const parallelColumns = (count: number): 2 | 3 | 4 => (count <= 2 ? 2 : count === 3 ? 3 : 4)
