import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import { hasGitSide } from '#/lib/kinds'
import {
  CUSTOM_ID_PREFIX,
  DEFAULT_WORKFLOW_PRESET,
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_DEFS,
  customNameProblem,
  customSource,
  isWorkflowPreset,
  normalizeTweaks,
  readCustomWorkflows,
  readProjectTweaks,
  resolveWorkflow,
  validateTweaks,
  type CustomWorkflow,
  type FlowState,
  type ProjectTweaks,
  type ResolvedStep,
  type ResolvedSubStep,
  type TeamAgentRef,
  type ResolvedWorkflow,
  type WorkflowPresetId,
  type WorkflowRef,
} from '#/lib/workflow'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'
import { getProject } from './projects'
import { listAgents } from './projectAgents'

/**
 * A project's workflow: which preset its tickets' agents follow (`projects.workflowPreset`), what the
 * human changed in each preset (`projects.workflowTweaks`), and the preset a ticket names instead
 * (`tickets.workflowPreset`). The rules and the tree are `#/lib/workflow`; this reads and writes them,
 * and renders the text an agent follows (`renderWorkflowText`, served by `get_workflow`). The Team agent
 * each step runs is read from the project's agents (`projectAgents`) on every call and handed to the pure
 * module by name, so a rename or a delete shows in the next read.
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

/** The id (a preset's, or a custom workflow's) of the preset or workflow the id names, when the project has it. */
const known = (customs: readonly CustomWorkflow[], id: unknown): id is string =>
  isWorkflowPreset(id) || (typeof id === 'string' && customs.some((c) => c.id === id))

function projectRow(projectId: number) {
  const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!row) throw notFound('project')
  return row
}

/** The names of the project's Team agents, as the Team page spells them. */
export const teamNames = (projectId: number): string[] => listAgents(projectId).map((a) => a.name)

/**
 * The workflow the project's tickets follow (`active`, a preset's id or a custom workflow's; a stored one whose
 * workflow was deleted reads as Standard, and `fellBack` names it), the saved tweaks of each preset as they read
 * today (stale ones cleaned) and the project's own workflows.
 */
export function projectWorkflow(projectId: number) {
  const row = projectRow(projectId)
  const customs = readCustomWorkflows(row.workflowCustom)
  const stored = row.workflowPreset
  const active = known(customs, stored) ? stored : DEFAULT_WORKFLOW_PRESET
  return {
    active,
    fellBack: known(customs, stored) ? null : { id: stored },
    tweaks: readProjectTweaks(row.workflowTweaks),
    customs,
  }
}

type ProjectWorkflow = ReturnType<typeof projectWorkflow>

/** A preset or a custom workflow of the project: what to resolve (`source`) and the tweak saved for it. */
function findWorkflow(w: ProjectWorkflow, id: string) {
  if (isWorkflowPreset(id)) return { source: id as WorkflowRef, tweak: w.tweaks[id] as unknown, custom: null }
  const custom = w.customs.find((c) => c.id === id)
  if (!custom) return null
  return { source: customSource(custom) as WorkflowRef, tweak: custom.tweak as unknown, custom }
}

/** The ids a workflow can be named by in this project: the four presets, then its own workflows. */
const validIds = (w: ProjectWorkflow) => [...WORKFLOW_PRESETS, ...w.customs.map((c) => c.id)]
const unknownWorkflow = (field: string, w: ProjectWorkflow) =>
  new HttpError(400, `${field}: one of ${validIds(w).join(', ')}`)

/** The label of a workflow of the project, or its id when it is gone. */
const labelOf = (w: ProjectWorkflow, id: string) =>
  isWorkflowPreset(id) ? WORKFLOW_PRESET_DEFS[id].label : (w.customs.find((c) => c.id === id)?.name ?? id)

/** One workflow of the project resolved with its tweaks, for a ticket of `complexity` (null: the workflow as such). */
export function resolveFor(projectId: number, id: string, complexity: Complexity | null = null) {
  const w = projectWorkflow(projectId)
  const found = findWorkflow(w, id) ?? findWorkflow(w, DEFAULT_WORKFLOW_PRESET)!
  return resolveWorkflow(found.source, found.tweak, complexity, teamNames(projectId))
}

/**
 * The workflows of the project: every preset with its tweaks, its rounds and its steps as a tree (resolved with
 * no complexity: nothing is dropped for being low; `skipsOnLow` says what is), then the project's own, each node
 * with the Team agent that runs it, `active` (the id the tickets follow, `fellBack` the deleted one it stood
 * for) and `team`: the names of the project's Team agents, for the picker of a node. An entry with `custom`
 * set is a project's own workflow and says which preset it descends from.
 */
export function workflowOverview(projectId: number) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  const team = teamNames(projectId)
  const entry = (id: string) => {
    const found = findWorkflow(w, id)!
    const r = resolveWorkflow(found.source, found.tweak, null, team)
    return {
      id,
      label: r.label,
      description: r.description,
      custom: found.custom ? { base: found.custom.base } : null,
      tweaked: r.tweaked,
      tweaks: r.tweak,
      rounds: r.rounds,
      defaultRounds: r.defaultRounds,
      order: r.order,
      defaultOrder: r.defaultOrder,
      steps: r.steps,
    }
  }
  return {
    active: w.active,
    fellBack: w.fellBack,
    team,
    presets: validIds(w).map(entry),
  }
}

/** The human sets which workflow (a preset or one of the project's own) the project's tickets follow. */
export function setActivePreset(projectId: number, preset: string, actor: string) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  if (!known(w.customs, preset)) throw unknownWorkflow('preset', w)
  if (projectRow(projectId).workflowPreset !== preset) {
    db.update(schema.projects).set({ workflowPreset: preset }).where(eq(schema.projects.id, projectId)).run()
    logActivity({
      projectId,
      actor,
      kind: 'project',
      text: `set the project's workflow to ${labelOf(w, preset)}`,
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

function writeCustoms(projectId: number, customs: readonly CustomWorkflow[]) {
  db.update(schema.projects)
    .set({ workflowCustom: customs.length ? [...customs] : null })
    .where(eq(schema.projects.id, projectId))
    .run()
}

const note = (projectId: number, actor: string, text: string) =>
  logActivity({ projectId, actor, kind: 'project', text, refType: 'project', refId: projectId })

/**
 * Replaces one workflow's saved tweaks with `input` (no merge with what was saved; the others are untouched).
 * A body the rules refuse is a 400 with the first problem's words and nothing is saved: a Team agent picked
 * for a node must be one of the project's, though a pick already saved for the node whose agent has since
 * left the Team may be sent back as it is. What equals the preset's defaults is not kept: a body that changes
 * nothing resets a preset. A custom workflow's `order` is its step list: a step left out of it is removed, a
 * kind it did not have is added, and a locked step cannot go; a body with no `order` keeps the stored one.
 */
export function saveTweaks(projectId: number, id: string, input: unknown, actor: string) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  const team = teamNames(projectId)
  const custom = w.customs.find((c) => c.id === id)
  if (custom) {
    const source = customSource(custom)
    const checked = validateTweaks(source, input, {
      team,
      stored: custom.tweak.agents,
      order: custom.tweak.order,
    })
    if (!checked.ok) throw new HttpError(400, checked.error)
    const tweak = normalizeTweaks(source, checked.tweak)!
    writeCustoms(
      projectId,
      w.customs.map((c) => (c.id === id ? { ...c, tweak } : c)),
    )
    note(projectId, actor, `changed the ${custom.name} workflow`)
    return workflowOverview(projectId)
  }
  if (!isWorkflowPreset(id)) throw unknownWorkflow('preset', w)
  const tweaks = { ...w.tweaks }
  const checked = validateTweaks(id, input, { team, stored: tweaks[id]?.agents })
  if (!checked.ok) throw new HttpError(400, checked.error)
  const kept = normalizeTweaks(id, checked.tweak)
  if (kept) tweaks[id] = kept
  else delete tweaks[id]
  writeTweaks(projectId, tweaks)
  note(projectId, actor, `changed the ${WORKFLOW_PRESET_DEFS[id].label} workflow`)
  return workflowOverview(projectId)
}

/**
 * Takes one workflow back to where it started: a preset to what ships (its saved tweaks removed; a preset with
 * none is left as it is), a custom workflow to the state it was created in, name and all.
 */
export function resetTweaks(projectId: number, id: string, actor: string) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  const custom = w.customs.find((c) => c.id === id)
  if (custom) {
    writeCustoms(
      projectId,
      w.customs.map((c) => (c.id === id ? { ...c, tweak: structuredClone(c.seed) } : c)),
    )
    note(projectId, actor, `reset the ${custom.name} workflow`)
    return workflowOverview(projectId)
  }
  if (!isWorkflowPreset(id)) throw unknownWorkflow('preset', w)
  const tweaks = { ...w.tweaks }
  if (tweaks[id]) {
    delete tweaks[id]
    writeTweaks(projectId, tweaks)
    note(projectId, actor, `reset the ${WORKFLOW_PRESET_DEFS[id].label} workflow`)
  }
  return workflowOverview(projectId)
}

// --- the project's own workflows ---

const newCustomId = () => `${CUSTOM_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 10)}`

/**
 * Duplicates a workflow of the project (a preset with the project's tweaks on it, or another of its own
 * workflows: whatever the page shows) into a new one named `input.name`; `input.from` is the id of the source.
 * The copy descends from the same built-in preset, so it keeps its review, and is changed on its own from
 * here. Its id is new and never used again.
 */
export function createCustom(projectId: number, input: unknown, actor: string) {
  softwareProject(projectId)
  const body = (typeof input === 'object' && input !== null ? input : {}) as {
    name?: unknown
    from?: unknown
  }
  const w = projectWorkflow(projectId)
  const name = customNameProblem(body.name, w.customs)
  if (!name.ok) throw new HttpError(400, name.error)
  const from = typeof body.from === 'string' ? findWorkflow(w, body.from) : null
  if (!from) throw unknownWorkflow('from', w)
  const resolved = resolveWorkflow(from.source, from.tweak, null, teamNames(projectId))
  const id = newCustomId()
  const source = customSource({ id, name: name.name, base: resolved.base })
  const tweak = normalizeTweaks(source, { ...resolved.tweak, order: resolved.order })!
  const custom: CustomWorkflow = {
    id,
    name: name.name,
    base: resolved.base,
    tweak,
    seed: structuredClone(tweak),
  }
  writeCustoms(projectId, [...w.customs, custom])
  note(projectId, actor, `made the workflow ${custom.name} from ${resolved.label}`)
  return { ...workflowOverview(projectId), created: id }
}

/** Renames one of the project's own workflows; a preset cannot be renamed. */
export function renameCustom(projectId: number, id: string, input: unknown, actor: string) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  const custom = w.customs.find((c) => c.id === id)
  if (!custom) {
    if (isWorkflowPreset(id))
      throw new HttpError(400, `${id} is one of the four presets: it cannot be renamed`)
    throw notFound('workflow')
  }
  const body = (typeof input === 'object' && input !== null ? input : {}) as { name?: unknown }
  const name = customNameProblem(
    body.name,
    w.customs.filter((c) => c.id !== id),
  )
  if (!name.ok) throw new HttpError(400, name.error)
  if (name.name !== custom.name) {
    writeCustoms(
      projectId,
      w.customs.map((c) => (c.id === id ? { ...c, name: name.name } : c)),
    )
    note(projectId, actor, `renamed the workflow ${custom.name} to ${name.name}`)
  }
  return workflowOverview(projectId)
}

/**
 * Deletes one of the project's own workflows; a preset cannot be deleted. The project and the tickets that
 * named it are left as they are and follow the project's default when read (Standard for the project's own
 * pick, the project's workflow for a ticket's), which the Workflow page and the ticket say.
 */
export function deleteCustom(projectId: number, id: string, actor: string) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  const custom = w.customs.find((c) => c.id === id)
  if (!custom) {
    if (isWorkflowPreset(id))
      throw new HttpError(400, `${id} is one of the four presets: it cannot be deleted`)
    throw notFound('workflow')
  }
  writeCustoms(
    projectId,
    w.customs.filter((c) => c.id !== id),
  )
  note(projectId, actor, `deleted the workflow ${custom.name}`)
  return workflowOverview(projectId)
}

/**
 * A ticket's workflow id checked before it is saved: null (follow the project's), a preset, or one of the
 * ticket's own project's workflows; anything else is a 400 naming the valid ids.
 */
export function assertWorkflowId(projectId: number, id: string | null | undefined) {
  if (id === null || id === undefined || isWorkflowPreset(id)) return
  const w = projectWorkflow(projectId)
  if (!known(w.customs, id)) throw unknownWorkflow('workflowPreset', w)
}

/**
 * The workflow a ticket's agent follows: the ticket's own when it names one of the project's (`source: ticket`),
 * else the project's active one (`source: project`; a ticket naming a deleted workflow lands here, `fellBack`
 * says which), with that workflow's saved tweaks, resolved for the ticket's complexity; `text` is what the agent
 * reads. With no ticket, the project's workflow for no complexity (the rounds table). A ticket of another
 * project is refused.
 *
 * Without a ticket, `view` picks the workflow and the complexity to show (the Workflow page reads its
 * "What agents read" panel this way): the text is what a ticket of that complexity reads, which for a
 * workflow other than the project's is a ticket that names it (`source: ticket`).
 */
export function effectiveWorkflow(
  projectId: number,
  ticketId?: number | null,
  view: { preset?: string | null; complexity?: string | null } = {},
) {
  softwareProject(projectId)
  const w = projectWorkflow(projectId)
  let id = w.active
  let source: 'ticket' | 'project' = 'project'
  let complexity: Complexity | null = null
  let fellBack: { id: string; of: 'project' | 'ticket' } | null = w.fellBack
    ? { id: w.fellBack.id, of: 'project' }
    : null
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
    if (known(w.customs, ticket.workflowPreset)) {
      id = ticket.workflowPreset
      source = 'ticket'
      fellBack = null
    } else if (ticket.workflowPreset) fellBack = { id: ticket.workflowPreset, of: 'ticket' }
  } else {
    if (view.preset) {
      if (!known(w.customs, view.preset)) throw unknownWorkflow('preset', w)
      id = view.preset
      if (id !== w.active) source = 'ticket'
    }
    if (view.complexity) {
      if (!(COMPLEXITIES as readonly string[]).includes(view.complexity))
        throw new HttpError(400, `complexity: one of ${COMPLEXITIES.join(', ')}`)
      complexity = view.complexity as Complexity
    }
  }
  const found = findWorkflow(w, id)!
  const workflow = resolveWorkflow(found.source, found.tweak, complexity, teamNames(projectId))
  const context = {
    source,
    projectPreset: w.active,
    projectLabel: labelOf(w, w.active),
    ticketId: ticketId ?? null,
  }
  return { ...workflow, ...context, fellBack, text: renderWorkflowText(workflow, context) }
}

/** What the rest of the board checks a ticket's review against (`runReports.missingReviewPhases`). */
export function ticketWorkflow(ticket: {
  id: number
  projectId: number
  complexity: Complexity
}): ResolvedWorkflow {
  const w = projectWorkflow(ticket.projectId)
  const own = db
    .select({ workflowPreset: schema.tickets.workflowPreset })
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticket.id))
    .get()?.workflowPreset
  // A ticket naming a workflow that is gone follows the project's.
  const found = findWorkflow(w, known(w.customs, own) ? own : w.active)!
  return resolveWorkflow(found.source, found.tweak, ticket.complexity, teamNames(ticket.projectId))
}

// --- the text an agent follows ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const effortWords = (step: ResolvedStep) => {
  if (step.effort === null) return ''
  if (step.effortLevel) return `, effort ${step.effortLevel}`
  return ', effort auto (low for a low ticket, medium for mid and high, high for max)'
}

/**
 * Who runs a node, as the text names it: the Team agent (or the built-in role the Team lacks), the role when
 * the two differ, and a stored pick the Team no longer has.
 */
function teamWords(ref: TeamAgentRef, role: string): string {
  const kind = ref.source === 'default' ? 'built-in' : 'Team agent'
  const roleNote = ref.name.toLowerCase() === role ? '' : ` (role \`${role}\`)`
  const missing = ref.missing ? ` [picked \`${ref.picked}\` is not in the Team]` : ''
  return `${kind} \`${ref.name}\`${roleNote}${missing}`
}

const agentWords = (step: ResolvedStep) =>
  step.agent === 'runner'
    ? 'agent /feature-review'
    : step.teamAgent === null
      ? 'you'
      : teamWords(step.teamAgent, step.agent)

/** How the ticket agent briefs the agent of a step, and what it names it as: one paragraph under the step's heading. */
function agentLine(step: ResolvedStep, flow: FlowState): string | null {
  const ref = step.teamAgent
  if (!ref) return null
  const role = step.agent
  // The role is also the agent's name when the two match: "never by" is only said of a name that differs.
  const same = ref.name.toLowerCase() === role
  const named = `Name its span, its run report and its \`agentName\` by the role \`${role}\`${same ? " (which is also the agent's name)" : `, never by \`${ref.name}\``}: the board counts this step's runs by role.`
  const posts =
    ref.source === 'default'
      ? 'It is no Team agent, so post its work with `progress: true` and no `as`.'
      : `Post its work \`as: ${ref.name}\` (\`progress: true\`).`
  // One rule for every pass: it is posted `as` the agent that ran it. A step's Agent line speaks for this
  // step's own run only; a pass another node's agent runs says so here, so no line posts it as this agent.
  const others: string[] = []
  if (step.id === 'build' && flow.review)
    others.push(
      "a fix pass (after a review round or after an intent return) is run and posted by the agent the review's `Between rounds` line names, not by this one",
    )
  if (step.id === 'intent' && flow.roundIntent)
    others.push(
      "the review's round-end intent check is run and posted by the agent the review's `intent` phase line names, not by this one",
    )
  const scope = others.length
    ? ` That is this step's own run: ${others.join('; ')} (with no \`as\` when that line names a built-in agent).`
    : ''
  return `Agent: ${agentSource(ref, role)} ${named} ${posts}${scope}`
}

/** Where a node's agent comes from and what to brief it with: the Team agent's instructions, or the built-in role's. */
function agentSource(ref: TeamAgentRef, role: string): string {
  const brief =
    role === 'intent'
      ? `brief its subagent with the instructions of \`${ref.name}\` (\`get_project\` -> \`agents\`) and, besides them, only what the intent step lists: the human's own words and the result.`
      : `brief its subagent with the instructions of \`${ref.name}\` (\`get_project\` -> \`agents\`), the project's \`instructions\` and the ticket's context.`
  const gone = ref.missing
    ? ` The workflow names \`${ref.picked}\` for it, but the project's Team has no agent of that name (deleted or renamed), so it runs as if none were picked.`
    : ''
  if (ref.source === 'picked') return `a Team agent picked for this step on the Workflow page: ${brief}`
  if (ref.source === 'role') return `the Team agent named like its role: ${brief}${gone}`
  return `the Team has no agent named \`${role}\`, so this runs as the built-in \`${role}\` role: brief its subagent as that role (the review bundle's agent file for it where there is one, else this step's procedure), with ${role === 'intent' ? 'only what the intent step lists' : "the project's `instructions` and the ticket's context"}.${gone} The human can add the role to the Team or pick another Team agent for it on the Workflow page.`
}

const lockWords = (step: ResolvedStep) =>
  step.lock === 'always' ? ' [locked]' : step.lock === 'above-low' ? ' [locked above low]' : ''

function subLines(list: readonly ResolvedSubStep[], depth: number): string[] {
  return list.flatMap((s) => {
    const peers = list
      .filter((o) => o !== s && o.parallel && o.parallel === s.parallel)
      .map((o) => o.number ?? o.id)
    const who = s.teamAgent
      ? teamWords(s.teamAgent, s.agent)
      : s.agent === 'runner'
        ? 'a separate /feature-review run'
        : 'you'
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
    `   Between rounds: ${review.between.map((b) => `${b.label.toLowerCase()} (${b.teamAgent ? teamWords(b.teamAgent, b.agent) : 'you'})`).join(' -> ')} -> the next round.`,
    `   Survives when: ${review.survival}.`,
    "   Each phase above runs the agent its line names, briefed with that agent's Team instructions (`get_project` -> `agents`), the project's `instructions` and the ticket's context; a built-in agent is a role the Team has no agent for, briefed as the review skill briefs a phase with no agent of its own. A phase's span, run report and `agentName` carry its role (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`, `intent`), never the Team agent's name, so the board still counts every phase of the round.",
  ]
  if (review.runs.length === 1)
    lines.push(
      `   Pass to /feature-review: phases=${review.runs[0]!.phasesArg} agents=${review.runs[0]!.agentsArg} effort=${effort} round=<n>.`,
    )
  else {
    lines.push(
      '   Run /feature-review once for each of these, as separate runs under their own agent names, neither shown the other:',
    )
    for (const run of review.runs)
      lines.push(
        `   - ${run.label} (agent suffix \`${run.agentSuffix}\`): phases=${run.phasesArg} agents=${run.agentsArg} effort=${effort} round=<n>.`,
      )
  }
  return lines
}

/**
 * The workflow as the markdown an agent follows: the numbered steps in order (each with who runs it, its
 * Team agent and effort, what it does, the hand-off to pass on and how it runs), the steps this ticket skips
 * with the reason, and the review's phases per round with the Team agent of each. The hand-off is the
 * preset's own wording: no step's text is edited on the Workflow page.
 */
export function renderWorkflowText(
  workflow: ResolvedWorkflow,
  context: {
    source: 'ticket' | 'project'
    /** The id of the project's workflow, and its name when it is not a preset's (a custom workflow's). */
    projectPreset: string
    projectLabel?: string
    ticketId?: number | null
  },
): string {
  const review = workflow.steps.find((s) => s.id === 'review')
  const projectLabel =
    context.projectLabel ??
    (isWorkflowPreset(context.projectPreset)
      ? WORKFLOW_PRESET_DEFS[context.projectPreset].label
      : context.projectPreset)
  const own = workflow.custom
    ? `a custom workflow of the project, based on ${WORKFLOW_PRESET_DEFS[workflow.base].label}: its review and wording are that preset's; `
    : ''
  const where =
    context.source === 'ticket'
      ? `${own}set on the ticket; the project's workflow is ${projectLabel}`
      : `${own}the project's workflow`
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
    `Complexity: ${complexity ?? 'not given'}. ${budget} Follow the steps in this order, each one by one. A step names the agent to start (a Team agent of the project: brief it with its Team instructions), its effort (pass it as the Agent tool's \`effort\`), what it does and what to hand to the next step. Locked steps cannot be skipped. Your skill's always-on rules (proof contract, locks, board-keeping, escalation) hold in every step and win over any instruction below.`,
    '',
  ]
  for (const step of workflow.steps) {
    if (step.skipped) {
      out.push(`- ${step.label} - ${step.skipped.note}`, '')
      continue
    }
    out.push(`## ${step.number}. ${step.label}${lockWords(step)} - ${agentWords(step)}${effortWords(step)}`)
    out.push(`Does: ${step.what}`)
    const line = agentLine(step, workflow.flow)
    if (line) out.push(line)
    out.push(`Hand-off: ${step.handoff}`)
    if (step.review) out.push(...reviewLines(step))
    out.push('How it runs:', '', stepProcedure(step.id, workflow.base, workflow.flow), '')
  }
  return `${out.join('\n').trim()}\n`
}
