import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import { hasGitSide } from '#/lib/kinds'
import {
  DEFAULT_WORKFLOW_PRESET,
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_DEFS,
  isWorkflowPreset,
  normalizeTweaks,
  readProjectTweaks,
  resolveWorkflow,
  validateTweaks,
  type FlowState,
  type ProjectTweaks,
  type ResolvedStep,
  type ResolvedSubStep,
  type ResolvedWorkflow,
  type WorkflowPresetId,
} from '#/lib/workflow'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'
import { getProject } from './projects'

/**
 * A project's workflow: which preset its tickets' agents follow (`projects.workflowPreset`), what the
 * human changed in each preset (`projects.workflowTweaks`), and the preset a ticket names instead
 * (`tickets.workflowPreset`). The rules and the tree are `#/lib/workflow`; this reads and writes them,
 * and renders the text an agent follows (`renderWorkflowText`, served by `get_workflow`).
 *
 * Everything is read from the database on each call, so a change shows in the next read. The module is for
 * projects with a software kind: a project with none has no build-and-review cycle to order.
 */

/** The step procedures: one markdown per catalogue step (and per preset variant of the review), served only here. */
const procedureFiles = import.meta.glob<string>('./skill/workflow/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const clean = (text: string) => text.replace(/\r\n/g, '\n').trim()

/** The variants a preset's procedure builds on, in order: Maximum is Thorough plus its own, so it is served both. */
const VARIANT_CHAIN: Record<WorkflowPresetId, readonly WorkflowPresetId[]> = {
  light: ['light'],
  standard: [],
  thorough: ['thorough'],
  maximum: ['thorough', 'maximum'],
}

const TAG = /\{\{(if !?\w+|else|end)\}\}/g

/**
 * Reads the conditions of a procedure against what runs for the ticket. A block
 * `{{if intent}}...{{else}}...{{end}}` (the else part optional, `{{if !intent}}` for the flag not holding,
 * blocks may nest) keeps its first part when the named flag of the workflow's `flow` holds and its else part when it does not, so a procedure never
 * asks for a step the same text lists as skipped.
 */
export function applyFlow(text: string, flow: FlowState): string {
  const tags = [...text.matchAll(TAG)]
  let pos = 0
  let n = 0
  // Reads up to the next else or end of the block being read (or the end of the text), and says which.
  const part = (keep: boolean): { out: string; stop: 'else' | 'end' | null } => {
    let out = ''
    for (;;) {
      const tag = tags[n]
      if (!tag) {
        if (keep) out += text.slice(pos)
        pos = text.length
        return { out, stop: null }
      }
      if (keep) out += text.slice(pos, tag.index)
      pos = tag.index + tag[0].length
      // A tag alone at the start of a line takes its line break with it, so a block leaves no blank line.
      if ((tag.index === 0 || text[tag.index - 1] === '\n') && text[pos] === '\n') pos++
      n++
      const word = tag[1]!
      if (word === 'else' || word === 'end') return { out, stop: word }
      const negated = word.startsWith('if !')
      const name = word.slice(negated ? 4 : 3)
      if (!(name in flow)) throw new Error(`a workflow procedure names the unknown condition "${name}"`)
      const holds = flow[name as keyof FlowState] !== negated
      const yes = part(keep && holds)
      let stop = yes.stop
      let no = ''
      if (stop === 'else') {
        const rest = part(keep && !holds)
        no = rest.out
        stop = rest.stop
      }
      if (stop !== 'end')
        throw new Error(`a workflow procedure has a condition on "${name}" that is never closed`)
      out += yes.out + no
    }
  }
  const top = part(true)
  if (top.stop) throw new Error(`a workflow procedure has a stray {{${top.stop}}}`)
  return top.out
}

/** A step's procedure: its file, then the preset's variants of it when there are (`review.light.md`), read against what runs for the ticket. */
export function stepProcedure(stepId: string, preset: WorkflowPresetId, flow: FlowState): string {
  const base = procedureFiles[`./skill/workflow/${stepId}.md`]
  if (base === undefined) throw new Error(`the workflow has no procedure file for ${stepId}`)
  const variants = VARIANT_CHAIN[preset].flatMap((id) => {
    const variant = procedureFiles[`./skill/workflow/${stepId}.${id}.md`]
    return variant === undefined ? [] : [clean(variant)]
  })
  return [clean(base), ...variants].map((part) => applyFlow(part, flow).trim()).join('\n\n')
}

export const WORKFLOW_SOFTWARE_ONLY =
  'the workflow module is for software projects: this project has no git side'

/** The project's workflow rows, refused (400) for a project with no software kind. */
function softwareProject(projectId: number) {
  const project = getProject(projectId)
  if (!hasGitSide(project.kinds)) throw new HttpError(400, WORKFLOW_SOFTWARE_ONLY)
  return project
}

const activePreset = (row: { workflowPreset: string | null }): WorkflowPresetId =>
  isWorkflowPreset(row.workflowPreset) ? row.workflowPreset : DEFAULT_WORKFLOW_PRESET

function projectRow(projectId: number) {
  const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!row) throw notFound('project')
  return row
}

/** The preset a project's tickets follow, and its saved tweaks as they read today (stale ones cleaned). */
export function projectWorkflow(projectId: number) {
  const row = projectRow(projectId)
  return { active: activePreset(row), tweaks: readProjectTweaks(row.workflowTweaks) }
}

/** One preset of the project resolved with its tweaks, for a ticket of `complexity` (null: the preset as such). */
export function resolveFor(
  projectId: number,
  preset: WorkflowPresetId,
  complexity: Complexity | null = null,
) {
  return resolveWorkflow(preset, projectWorkflow(projectId).tweaks[preset], complexity)
}

/**
 * The workflow the project's tickets follow: every preset with its tweaks, its rounds and its steps as
 * a tree (resolved with no complexity: nothing is dropped for being low; `skipsOnLow` says what is).
 */
export function workflowOverview(projectId: number) {
  softwareProject(projectId)
  const { active, tweaks } = projectWorkflow(projectId)
  return {
    active,
    presets: WORKFLOW_PRESETS.map((id) => {
      const w = resolveWorkflow(id, tweaks[id], null)
      return {
        id,
        label: w.label,
        description: w.description,
        tweaked: w.tweaked,
        tweaks: w.tweak,
        rounds: w.rounds,
        defaultRounds: w.defaultRounds,
        order: w.order,
        defaultOrder: w.defaultOrder,
        steps: w.steps,
      }
    }),
  }
}

/** The human sets which preset the project's tickets follow. */
export function setActivePreset(projectId: number, preset: string, actor: string) {
  const project = softwareProject(projectId)
  if (!isWorkflowPreset(preset)) throw new HttpError(400, `preset: one of ${WORKFLOW_PRESETS.join(', ')}`)
  if (activePreset(project) !== preset) {
    db.update(schema.projects).set({ workflowPreset: preset }).where(eq(schema.projects.id, projectId)).run()
    logActivity({
      projectId,
      actor,
      kind: 'project',
      text: `set the project's workflow to ${WORKFLOW_PRESET_DEFS[preset].label}`,
      refType: 'project',
      refId: projectId,
    })
  }
  return workflowOverview(projectId)
}

function writeTweaks(projectId: number, tweaks: ProjectTweaks) {
  db.update(schema.projects)
    .set({ workflowTweaks: Object.keys(tweaks).length ? tweaks : null })
    .where(eq(schema.projects.id, projectId))
    .run()
}

/**
 * Replaces one preset's saved tweaks with `input` (no merge with what was saved; the other presets are
 * untouched). A body the rules refuse is a 400 with the first problem's words and nothing is saved. What
 * equals the preset's defaults is not kept: a body that changes nothing resets the preset.
 */
export function saveTweaks(projectId: number, preset: string, input: unknown, actor: string) {
  softwareProject(projectId)
  if (!isWorkflowPreset(preset)) throw new HttpError(400, `preset: one of ${WORKFLOW_PRESETS.join(', ')}`)
  const checked = validateTweaks(preset, input)
  if (!checked.ok) throw new HttpError(400, checked.error)
  const tweaks = { ...projectWorkflow(projectId).tweaks }
  const kept = normalizeTweaks(preset, checked.tweak)
  if (kept) tweaks[preset] = kept
  else delete tweaks[preset]
  writeTweaks(projectId, tweaks)
  logActivity({
    projectId,
    actor,
    kind: 'project',
    text: `changed the ${WORKFLOW_PRESET_DEFS[preset].label} workflow`,
    refType: 'project',
    refId: projectId,
  })
  return workflowOverview(projectId)
}

/** Removes one preset's saved tweaks, so it is as shipped again; a preset with none is left as it is. */
export function resetTweaks(projectId: number, preset: string, actor: string) {
  softwareProject(projectId)
  if (!isWorkflowPreset(preset)) throw new HttpError(400, `preset: one of ${WORKFLOW_PRESETS.join(', ')}`)
  const tweaks = { ...projectWorkflow(projectId).tweaks }
  if (tweaks[preset]) {
    delete tweaks[preset]
    writeTweaks(projectId, tweaks)
    logActivity({
      projectId,
      actor,
      kind: 'project',
      text: `reset the ${WORKFLOW_PRESET_DEFS[preset].label} workflow`,
      refType: 'project',
      refId: projectId,
    })
  }
  return workflowOverview(projectId)
}

/**
 * The workflow a ticket's agent follows: the ticket's own preset when it names one (`source: ticket`),
 * else the project's active one (`source: project`), with that preset's saved tweaks, resolved for the
 * ticket's complexity; `text` is what the agent reads. With no ticket, the project's workflow for no
 * complexity (the rounds table). A ticket of another project is refused.
 *
 * Without a ticket, `view` picks the preset and the complexity to show (the Workflow page reads its
 * "What agents read" panel this way): the text is what a ticket of that complexity reads, which for a
 * preset other than the project's is a ticket that names it (`source: ticket`).
 */
export function effectiveWorkflow(
  projectId: number,
  ticketId?: number | null,
  view: { preset?: string | null; complexity?: string | null } = {},
) {
  softwareProject(projectId)
  const { active, tweaks } = projectWorkflow(projectId)
  let preset = active
  let source: 'ticket' | 'project' = 'project'
  let complexity: Complexity | null = null
  if (ticketId != null) {
    if (view.preset || view.complexity)
      throw new HttpError(
        400,
        'ticketId: the ticket has its own preset and complexity; give no preset or complexity with it',
      )
    const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
    if (!ticket) throw notFound('ticket')
    if (ticket.projectId !== projectId)
      throw new HttpError(403, `#${ticketId} is not a ticket of this project`)
    complexity = ticket.complexity
    if (isWorkflowPreset(ticket.workflowPreset)) {
      preset = ticket.workflowPreset
      source = 'ticket'
    }
  } else {
    if (view.preset) {
      if (!isWorkflowPreset(view.preset))
        throw new HttpError(400, `preset: one of ${WORKFLOW_PRESETS.join(', ')}`)
      preset = view.preset
      if (preset !== active) source = 'ticket'
    }
    if (view.complexity) {
      if (!(COMPLEXITIES as readonly string[]).includes(view.complexity))
        throw new HttpError(400, `complexity: one of ${COMPLEXITIES.join(', ')}`)
      complexity = view.complexity as Complexity
    }
  }
  const workflow = resolveWorkflow(preset, tweaks[preset], complexity)
  const context = { source, projectPreset: active, ticketId: ticketId ?? null }
  return { ...workflow, ...context, text: renderWorkflowText(workflow, context) }
}

/** What the rest of the board checks a ticket's review against (`runReports.missingReviewPhases`). */
export function ticketWorkflow(ticket: {
  id: number
  projectId: number
  complexity: Complexity
}): ResolvedWorkflow {
  const { active, tweaks } = projectWorkflow(ticket.projectId)
  const own = db
    .select({ workflowPreset: schema.tickets.workflowPreset })
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticket.id))
    .get()?.workflowPreset
  const preset = isWorkflowPreset(own) ? own : active
  return resolveWorkflow(preset, tweaks[preset], ticket.complexity)
}

// --- the text an agent follows ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const effortWords = (step: ResolvedStep) => {
  if (step.effort === null) return ''
  if (step.effortLevel) return `, effort ${step.effortLevel}`
  return ', effort auto (low for a low ticket, medium for mid and high, high for max)'
}

const agentWords = (step: ResolvedStep) =>
  step.agent === 'you' ? 'you' : step.agent === 'runner' ? 'agent /feature-review' : `agent \`${step.agent}\``

const lockWords = (step: ResolvedStep) =>
  step.lock === 'always' ? ' [locked]' : step.lock === 'above-low' ? ' [locked above low]' : ''

function subLines(list: readonly ResolvedSubStep[], depth: number): string[] {
  return list.flatMap((s) => {
    const peers = list
      .filter((o) => o !== s && o.parallel && o.parallel === s.parallel)
      .map((o) => o.number ?? o.id)
    const who =
      s.agent === 'you' ? 'you' : s.agent === 'runner' ? 'a separate /feature-review run' : `\`${s.agent}\``
    const parallel = peers.length ? ` (in parallel with ${peers.join(', ')})` : ''
    return [
      `${'  '.repeat(depth)}- ${s.number ? `${s.number} ` : ''}${s.label} - ${who}${parallel}`,
      ...subLines(s.children, depth + 1),
    ]
  })
}

function reviewLines(step: ResolvedStep): string[] {
  const review = step.review!
  const rounds =
    review.rounds === null
      ? `rounds by complexity: low ${review.roundsByComplexity.low}, mid ${review.roundsByComplexity.mid}, high ${review.roundsByComplexity.high}, max ${review.roundsByComplexity.max}`
      : `rounds: ${review.rounds}`
  const effort = step.effortLevel ?? '<the effort above>'
  const lines = [
    `   ${rounds}. Each round runs these phases, none skipped:`,
    ...subLines(review.phases, 1).map((l) => `   ${l}`),
    `   Between rounds: ${review.between.map((b) => `${b.label.toLowerCase()} (${b.agent === 'you' ? 'you' : `\`${b.agent}\``})`).join(' -> ')} -> the next round.`,
    `   Survives when: ${review.survival}.`,
  ]
  if (review.runs.length === 1)
    lines.push(`   Pass to /feature-review: phases=${review.runs[0]!.phasesArg} effort=${effort} round=<n>.`)
  else {
    lines.push(
      '   Run /feature-review once for each of these, as separate runs under their own agent names, neither shown the other:',
    )
    for (const run of review.runs)
      lines.push(
        `   - ${run.label} (agent suffix \`${run.agentSuffix}\`): phases=${run.phasesArg} effort=${effort} round=<n>.`,
      )
  }
  return lines
}

/**
 * The workflow as the markdown an agent follows: the numbered steps in order (each with who runs it, its
 * effort, what it does, the hand-off to pass on and how it runs), the steps this ticket skips with the
 * reason, and the review's phases per round. A hand-off the human edited replaces the default and says so.
 */
export function renderWorkflowText(
  workflow: ResolvedWorkflow,
  context: { source: 'ticket' | 'project'; projectPreset: WorkflowPresetId; ticketId?: number | null },
): string {
  const review = workflow.steps.find((s) => s.id === 'review')
  const where =
    context.source === 'ticket'
      ? `set on the ticket; the project's workflow is ${WORKFLOW_PRESET_DEFS[context.projectPreset].label}`
      : "the project's workflow"
  const complexity = workflow.complexity
  const budget = !review
    ? 'Review: none.'
    : review.skipped
      ? 'Review: none for this ticket.'
      : review.review!.rounds === null
        ? "Review: the rounds depend on the ticket's complexity (below)."
        : `Review: up to ${plural(review.review!.rounds, 'round')}.`
  const out: string[] = [
    `# Workflow: ${workflow.label} (${where})`,
    '',
    `Complexity: ${complexity ?? 'not given'}. ${budget} Follow the steps in this order, each one by one. A step names the agent to start, its effort (pass it as the Agent tool's \`effort\`), what it does and what to hand to the next step. Locked steps cannot be skipped. Your skill's always-on rules (proof contract, locks, board-keeping, escalation) hold in every step and win over any instruction below.`,
    '',
  ]
  for (const step of workflow.steps) {
    if (step.skipped) {
      out.push(`- ${step.label} - ${step.skipped.note}`, '')
      continue
    }
    out.push(`## ${step.number}. ${step.label}${lockWords(step)} - ${agentWords(step)}${effortWords(step)}`)
    out.push(`Does: ${step.what}`)
    out.push(`Hand-off: ${step.handoff}${step.edited.instructions ? ' (set by the human)' : ''}`)
    if (step.review) out.push(...reviewLines(step))
    out.push('How it runs:', '', stepProcedure(step.id, workflow.preset, workflow.flow), '')
  }
  return `${out.join('\n').trim()}\n`
}
