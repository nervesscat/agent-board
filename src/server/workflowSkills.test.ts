import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { COMPLEXITIES } from '#/lib/constants'
import { WORKFLOW_PRESETS, resolveWorkflow } from '#/lib/workflow'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-skills-'))

/**
 * The skills keep the rules that hold in every step and how to read a step; the delegation order, the
 * step procedures and the round counts are the project's workflow, which `get_workflow` serves. These tests
 * read the texts as an agent gets them (the board skill on both transports with an agent token, the session
 * skill, the review bundle's files, AGENTS.md) and the workflow text itself.
 */

const root = path.join(import.meta.dirname, '..', '..')
const skillDir = path.join(import.meta.dirname, 'skill')
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n')
const review = (p: string) => read(skillDir, 'review', p)
const flat = (text: string) => text.replace(/\s+/g, ' ')

let agents: typeof import('./agents')
let handle: (request: Request) => Promise<Response>
let projectId = 0
beforeAll(async () => {
  agents = await import('./agents')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: a bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'tester'),
  )
  handle = (request) => guarded({ request })
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'Acme' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'app', repoPath: '/r/acme' }).run()
})

const asAgent = (pathname: string) =>
  handle(new Request(`http://localhost${pathname}`, { headers: { authorization: 'Bearer gate_test' } }))

/** The board skill as an agent is served it, on each transport. */
async function boardSkills() {
  const out: Record<string, string> = {}
  for (const transport of ['mcp', 'rest'] as const) {
    const res = await asAgent(
      `/api/agent-setup/skill?client=claude${transport === 'rest' ? '&transport=rest' : ''}`,
    )
    expect(res.status).toBe(200)
    out[`board skill (${transport})`] = await res.text()
  }
  return out
}

/** What `get_workflow` serves for a ticket of `complexity` under `preset`, as an agent reads it. */
async function workflowText(preset: string, complexity: string | null) {
  const query = new URLSearchParams({ preset })
  if (complexity) query.set('complexity', complexity)
  const res = await asAgent(`/api/projects/${projectId}/workflow/effective?${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { text: string }).text
}

/** Every text that used to carry the cycle, as served. */
async function servedTexts() {
  const session = await asAgent('/api/agent-setup/session-skill')
  expect(session.status).toBe(200)
  return {
    ...(await boardSkills()),
    'session skill': await session.text(),
    'todo-review-ticket.md': review('agents/todo-review-ticket.md'),
    'todo-review SKILL.md': review('skills/todo-review/SKILL.md'),
    'feature-review SKILL.md': review('skills/feature-review/SKILL.md'),
    'review-queue SKILL.md': review('skills/review-queue/SKILL.md'),
    'AGENTS.md': read(root, 'AGENTS.md'),
  }
}

const frontmatter = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, 'm').exec(text.split('\n---\n')[0]!)?.[1] ?? ''

describe('the ticket agent follows the project’s workflow (E1)', () => {
  const agent = () => flat(review('agents/todo-review-ticket.md'))

  it('reads the workflow right after the ticket and runs exactly its steps, in its order', () => {
    const text = agent()
    expect(text).toContain("## Follow the project's workflow")
    expect(text).toContain('### Read the workflow')
    expect(text).toContain(
      'Right after you read the ticket (`get_project` and `get_ticket`: the first two items of the workflow\'s "Read and claim" step), call **`get_workflow`** with `projectId: PROJECT` and `ticketId: TICKET`',
    )
    expect(text).toContain('**Run exactly the steps it lists, in the order it lists them**')
    expect(text).toContain("You never change a ticket's complexity or its workflow preset")
    expect(text).toContain(
      'A change the human makes to the workflow while you run is read at your next relaunch',
    )
    expect(text).toContain('**No listed step or phase is skipped on your own judgement**')
  })

  it('has a "How to read a step" section: order, locked, skipped, routing, effort, hand-off', () => {
    const section = flat(
      review('agents/todo-review-ticket.md').split('### How to read a step')[1]!.split('### Two rules')[0]!,
    )
    for (const part of [
      '**Order.**',
      '**Locked.**',
      '`[locked]` steps cannot be skipped',
      '`[locked above low]`',
      '**Skipped.**',
      '**Agent routing.**',
      '`STATUS: error` and say which step had no agent',
      'the workflow text wins',
      '**Effort.**',
      "is the Agent tool's `effort` on **every** agent you start for that step",
      '`effort=<level>` for `/feature-review`',
      '**Hand-off.**',
      '"(set by the human)"',
      '**How it runs.**',
      '`phases=` argument to pass to `/feature-review`',
      'win over any instruction in the workflow text',
    ])
      expect(section, part).toContain(part)
  })

  it('keeps preset (the workflow’s name) and depth (the review’s measure) apart', () => {
    expect(agent()).toContain("the preset is the workflow's name: never call one by the other's word")
    expect(agent()).toContain("it is the review's depth, never the workflow's preset")
  })

  it('serves, in the workflow text, the order it tells the agent to follow', async () => {
    const text = await workflowText('standard', 'mid')
    expect(text).toMatch(/^# Workflow: Standard/)
    expect(text).toContain('Follow the steps in this order, each one by one.')
    expect(text).toContain("effort (pass it as the Agent tool's `effort`)")
    expect(text.match(/^## \d+\. /gm)).toHaveLength(12)
  })
})

describe('the delegation order and the counts no longer live in the skills (E2)', () => {
  const GONE = [
    'every review round runs spec, env, verify',
    'The full cycle is mandatory',
    'full cycle is mandatory',
    'low none, mid one',
    'one for mid, three for high',
    'up to ten',
    'max up to ten',
    'two hunts always',
    'Two independent hunts always run',
    'all six phases',
  ]
  const HEADINGS = [
    '### 1. Read and claim',
    '### 2. Spec',
    '### 3. Build',
    '### 4. Your own gate',
    '### 5. Review',
    '### 6. Evidence',
    '### 6b. The intent check',
    '### 7. Hand off',
    '**The budget**',
    '**The full cycle',
    '**The effort** is set by the complexity too',
  ]

  it('has none of the removed phrases in any served text, on either transport', async () => {
    for (const [name, text] of Object.entries(await servedTexts())) {
      const folded = flat(text).toLowerCase()
      for (const phrase of GONE) expect(folded, `${name}: ${phrase}`).not.toContain(phrase.toLowerCase())
    }
  })

  it('has none of the removed phrases in the review bundle’s other files either', () => {
    for (const p of agents.reviewBundlePaths().filter((f) => f.endsWith('.md'))) {
      const folded = flat(review(p)).toLowerCase()
      for (const phrase of GONE) expect(folded, `${p}: ${phrase}`).not.toContain(phrase.toLowerCase())
    }
  })

  it('has none of the step headings in the ticket agent', () => {
    const text = review('agents/todo-review-ticket.md')
    for (const heading of HEADINGS) expect(text, heading).not.toContain(heading)
  })

  it('has the descriptions say they follow the project’s workflow instead of listing it', () => {
    const ticket = frontmatter(review('agents/todo-review-ticket.md'), 'description')
    expect(ticket).toContain("by following the project's workflow")
    expect(ticket).toContain('get_workflow')
    const todo = frontmatter(review('skills/todo-review/SKILL.md'), 'description')
    expect(todo).toContain("follows the project's workflow")
    expect(todo).toContain('get_workflow')
    const feature = frontmatter(review('skills/feature-review/SKILL.md'), 'description')
    expect(feature).toContain("the ticket's workflow (get_workflow)")
    const queue = frontmatter(review('skills/review-queue/SKILL.md'), 'description')
    expect(queue).not.toMatch(/spec|hunt|rounds/)
    for (const description of [ticket, todo])
      for (const word of ['two hunts', 'low none', 'mid one', 'high three', 'refute, merge check'])
        expect(description, word).not.toContain(word)
  })
})

describe('the todo-review skill checks a result against the ticket’s workflow (E4)', () => {
  const text = () => flat(review('skills/todo-review/SKILL.md'))

  it('drives Step 4 by the workflow, and says nothing of a cycle of its own', () => {
    expect(text()).toContain(
      "What a ticket must have run comes from its own workflow (`get_workflow` with the ticket: the steps it lists, the review's rounds and phases), not from a cycle written here",
    )
    expect(text()).toContain(
      'every step the workflow lists for the ticket ran, in its order, and those it lists as skipped did not need to',
    )
    expect(text()).toContain(
      "`missingReviewPhases` is empty (it names each phase of the ticket's workflow that its last review round lacks",
    )
    expect(text()).toContain('The intent check ran on the head and its verdict is `matches`')
    expect(text()).not.toMatch(/mid, high or max ticket it names each phase/)
  })

  it('lists each ticket’s effective preset next to its complexity in plan.md, and takes no new argument', () => {
    expect(text()).toContain(
      'its complexity (the `complexity` field of its list row) and the preset of the workflow it follows next to it',
    )
    expect(text()).toContain("else the project's `workflowPreset` from `get_project`")
    const args = review('skills/todo-review/SKILL.md').split('## Arguments')[1]!.split('## Step 1')[0]!
    expect(args).not.toMatch(/workflow=|preset=/)
    expect(args).toContain("The depth is not the workflow's preset")
  })
})

describe('the feature-review skill runs the phases of its plan (E5)', () => {
  const skill = () => review('skills/feature-review/SKILL.md')

  it('takes phases=<list>, from the caller, the ticket’s workflow, or the six standard phases', () => {
    const text = flat(skill())
    expect(text).toContain('| `phases=<list>` |')
    expect(text).toContain('`phases=spec,env,verify,hunt,hunt,refute,merge`')
    expect(text).toContain("**`phases=<list>`**: the caller's plan.")
    expect(text).toContain(
      "**On a board ticket without `phases=`**: the ticket's workflow. `get_workflow` with the project and the ticket",
    )
    expect(text).toContain(
      '**No board, no ticket, or a board that does not answer**: the six standard phases',
    )
    expect(text).toContain('"no workflow: the six standard phases"')
  })

  it('runs every phase the plan lists, none skipped because findings look obvious', () => {
    const text = flat(skill())
    expect(text).toContain('**every phase the plan lists runs**')
    expect(text).toContain(
      'None is skipped because the findings look obvious, the change looks small or a finding was already reproduced',
    )
    expect(text).toContain('**Every hunt the plan lists runs.**')
    expect(text).not.toContain('**Two independent hunts always run.**')
    expect(text).toContain('The run follows its plan')
  })

  it('has a token for every phase argument any preset’s review gives', () => {
    const text = skill()
    const tokens = new Set<string>()
    for (const preset of WORKFLOW_PRESETS)
      for (const level of COMPLEXITIES)
        for (const step of resolveWorkflow(preset, undefined, level).steps)
          for (const run of step.review?.runs ?? []) for (const t of run.phasesArg.split(',')) tokens.add(t)
    expect([...tokens].sort()).toEqual(
      ['env', 'hunt', 'hunt-security', 'merge', 'refute', 'reviewer', 'spec', 'verify'].sort(),
    )
    for (const token of tokens) expect(text, token).toContain(`| \`${token}\` |`)
  })

  it('documents the single-reviewer plan (phases=reviewer) and the second run’s agent prefix', async () => {
    const text = flat(skill())
    expect(text).toContain('**The single-reviewer plan (`phases=reviewer`).**')
    expect(text).toContain('no spec, env, verify, refute or merge phase')
    expect(text).toContain('Spawn one `feature-review-hunt` agent')
    expect(text).toContain('`Hunts: one`')
    expect(text).toContain('`not run: single-reviewer plan`')
    expect(text).toContain('| `agent=<prefix>` |')
    // What the workflow tells the ticket agent to pass is what the skill documents.
    const light = await workflowText('light', 'mid')
    expect(light).toContain('Pass to /feature-review: phases=reviewer')
    const maximum = await workflowText('maximum', 'mid')
    expect(maximum).toContain('phases=spec,env,verify,hunt,hunt,hunt-security,refute,merge')
    expect(maximum).toContain('agent=<your name>/review-first')
  })
})

describe('the board skill, AGENTS.md, the session skill and review-queue point at the workflow (E6)', () => {
  it('has the board skill on both transports name get_workflow and keep the blind brief', async () => {
    for (const [name, text] of Object.entries(await boardSkills())) {
      const t = flat(text)
      expect(t, name).toContain('`get_workflow`')
      expect(t, name).toContain("**The project's workflow sets the cycle.**")
      expect(t, name).toContain('Run exactly the steps it lists, in its order')
      expect(t, name).toContain(
        "never the builder's plan, the spec, the review's findings or the options an agent put on a card",
      )
      expect(t, name).toContain(
        '`missingReviewPhases` for a ticket whose project has a software kind, whose workflow lists a review for it',
      )
      expect(t, name).toContain("the phases of the ticket's workflow its last review round lacks")
    }
  })

  it('has AGENTS.md say the same, and stay in step with board.md', () => {
    const agentsDoc = flat(read(root, 'AGENTS.md'))
    const board = flat(read(skillDir, 'board.md'))
    for (const sentence of [
      "**The project's workflow sets the cycle.**",
      'Run exactly the steps it lists, in its order, each as its text says; a workflow change made while you work is read at your next relaunch.',
      'None is skipped because findings look obvious, the change looks small or a finding was already reproduced; each phase posts its result, so a skipped phase is visible.',
      "then one more review round of the project's workflow (the numbering continues), then the intent check again.",
      "a review that does not survive after the workflow's last round goes to a human decision",
      'the build goes to hand-off only with evidence for every criterion',
      'the **intent** agent runs at `low` effort before the hand-off',
      'Max is for work built from scratch (a whole site or app, a new product or standalone service); a feature in an existing codebase is at most high, however difficult.',
    ]) {
      expect(agentsDoc, `AGENTS.md: ${sentence}`).toContain(sentence)
      expect(board, `board.md: ${sentence}`).toContain(sentence)
    }
    expect(agentsDoc).toContain('each phase of that workflow its last review round lacks')
  })

  it('has the session skill send the cycle to the workflow, without copying it', () => {
    const session = flat(read(skillDir, 'session.md'))
    expect(session).toContain("the order of it is the project's workflow (`get_workflow`")
    expect(session).toContain('you never change it')
    expect(session).not.toMatch(/writes the spec, starts the builder/)
  })

  it('has review-queue hand the build cycle to the project’s workflow', () => {
    const queue = flat(review('skills/review-queue/SKILL.md'))
    expect(queue).toContain("the build cycle of the project's workflow (`get_workflow`")
    expect(queue).toContain("the rounds a ticket gets are the workflow's for its level")
    expect(queue).toContain('except the intent agent, which runs at `low` effort whatever the complexity')
  })
})

describe('the seeded default agents no longer assert an unconditional order (E7)', () => {
  it('says "as many as the workflow lists" and keeps the stored texts of existing projects alone', async () => {
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    const note = (name: string) => flat(DEFAULT_AGENTS.find((a) => a.name === name)!.delegation)
    expect(note('hunt')).toContain('As many independent hunts run as the workflow lists')
    expect(note('hunt')).not.toContain('Two independent hunts always')
    expect(note('refute')).toContain('every **hunt** the workflow lists')
    expect(note('builder')).toContain("How many review rounds the ticket gets is its workflow's")
    expect(note('intent')).toContain('one more review round of the workflow')
    for (const agent of DEFAULT_AGENTS)
      expect(flat(agent.delegation), agent.name).not.toMatch(/up to ten|three for high|all six phases/)
    // The page's "add defaults" fills in what is missing and never rewrites an agent the project has.
    const { addDefaultAgents } = await import('./defaultAgents')
    const { createAgent, listAgents } = await import('./projectAgents')
    const { db, schema } = await import('#/db')
    const id = db.insert(schema.projects).values({ name: 'Stored' }).returning().get().id
    createAgent(id, { name: 'hunt', instructions: 'mine', delegation: 'Two hunts always.' }, 'tester')
    addDefaultAgents(id, 'tester')
    expect(listAgents(id).find((a) => a.name === 'hunt')!.delegation).toBe('Two hunts always.')
  })
})

describe('the step procedures are served only by get_workflow (E8, D3)', () => {
  it('keeps skill/workflow/* out of the review bundle and the tar', () => {
    expect(agents.reviewBundlePaths().filter((p) => /workflow/i.test(p))).toEqual([])
    const tar = agents.reviewBundle().toString('latin1')
    expect(tar).not.toMatch(/skill\/workflow/)
  })

  it('serves what the ticket agent lost, step by step, so nothing was cut', async () => {
    const mid = flat(await workflowText('standard', 'mid'))
    const low = flat(await workflowText('standard', 'low'))
    const must: [string, string][] = [
      // claim
      ['git -C REPO worktree add -b <branch> <path> origin/BASE', mid],
      ['`cp -al <prepared>/node_modules <path>/node_modules`', mid],
      ['`add_workspace` with its `path` and `branch` at once', mid],
      ['a ticket with an empty body and a screenshot is a bug report', mid],
      // spec, and the no-spec path
      ['WORKDIR/01-spec.md', mid],
      ['Post its result on the ticket `as: spec`', mid],
      ['A **decisive** open question', mid],
      ['write its acceptance criteria yourself', low],
      // build
      ['**With no spec: the builder codes and verifies itself.**', low],
      ['the holder line `#<TICKET> builder <ISO time>`', mid],
      // gate
      ['`WORKDIR/02-build.md`', mid],
      ['`.skip(`', mid],
      ['`depth.md`', mid],
      ['sends the change back at most twice', mid],
      // review
      ['`~/.claude/feature-review/ledger.jsonl`', mid],
      ['`git merge-base --is-ancestor origin/BASE <sha>`', mid],
      ['**The budget** is the `rounds` this workflow lists', mid],
      ['Survives when:', mid],
      ['phases=spec,env,verify,hunt,hunt,refute,merge', mid],
      ["Pass it as the Agent tool's `effort` on every subagent you start for the round", mid],
      // preview, intent
      ['`start_run` it (or `start_preview` on the workspace)', mid],
      ['The preview comes before the move to review, never after it', mid],
      ["Never give it the builder's plan, the spec, the review's findings", mid],
      // push, pr, ci, summary, hand-off
      ['`git -C <worktree> push -u origin <branch>`', mid],
      ['`post_review_result`', mid],
      ['`gh pr checks <number> --watch`', mid],
      ['CI run locally: green on <sha>', mid],
      ['`set_ticket_summary`', mid],
      ['`missingRunReports`', mid],
      ['`missingReviewPhases`', mid],
    ]
    for (const [phrase, text] of must) expect(text, phrase).toContain(flat(phrase))
  })
})

describe('the repo says nothing of the board’s tickets, hosts or private paths (E9)', () => {
  // Built from parts so this file does not contain the patterns it looks for.
  const banned = [
    new RegExp(`#${'9'}\\d\\d\\b`),
    new RegExp(`ticket ${'9'}\\d\\d`, 'i'),
    new RegExp(`localhost:${'47'}100`),
    new RegExp(`/${'home'}/`),
  ]

  it('has none of it in the new workflow files', () => {
    const files = [
      ...fs.readdirSync(path.join(skillDir, 'workflow')).map((f) => path.join(skillDir, 'workflow', f)),
      path.join(root, 'src', 'lib', 'workflow.ts'),
      path.join(root, 'src', 'server', 'workflow.ts'),
      path.join(root, 'src', 'server', 'workflowSkills.test.ts'),
      path.join(root, 'src', 'server', 'skill', 'review', 'agents', 'todo-review-ticket.md'),
      path.join(root, 'src', 'server', 'skill', 'review', 'skills', 'feature-review', 'SKILL.md'),
    ]
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      for (const pattern of banned) expect(text, `${path.basename(file)}: ${pattern}`).not.toMatch(pattern)
    }
  })
})

describe('the README documents the workflow (I1)', () => {
  const readme = () => read(root, 'README.md')

  it('has a Workflow section: presets, tweaks, locked steps, the ticket override, get_workflow and the query', () => {
    const section = flat(readme().split('\n## Workflow\n')[1]!.split('\n## ')[0]!)
    for (const part of [
      'Light',
      'Standard',
      'Thorough',
      'Maximum',
      '**Tweakable, per preset.**',
      'the review rounds per complexity (0 to 12)',
      '**Locked steps** cannot be turned off',
      "**A ticket's own workflow.**",
      '`workflowPreset`',
      '`get_workflow`',
      '`GET /api/projects/:id/workflow/effective?ticketId=`',
      '`?preset=` and `?complexity=`',
    ])
      expect(section, part).toContain(part)
  })

  it('lists each new route and field in the REST table', () => {
    const rows = readme()
      .split('\n')
      .filter((l) => l.startsWith('|'))
    const row = (needle: string) => rows.find((l) => l.includes(needle))
    expect(row('`/api/projects/:id/workflow`')).toContain('{active, presets[]}')
    expect(row('`/api/projects/:id/workflow/:preset`')).toContain('{order?, steps?, rounds?}')
    expect(row('`/api/projects/:id/workflow/effective?ticketId=`')).toContain('get_workflow')
    expect(row('`workflowPreset` on GET `/api/projects/:id`')).toBeDefined()
    expect(
      rows.find((l) => l.includes('`/api/projects/:id/tickets`') && l.includes('`/api/tickets/:id`')),
    ).toContain('`workflowPreset` on create and PATCH')
  })
})

describe('review fix pass: one folder per review, the plan of a skipped review, and the switches', () => {
  const skill = () => flat(review('skills/feature-review/SKILL.md'))

  it('gives each of a round’s reviews its own folder, claim, worktree and ledger line (C1)', async () => {
    const text = skill()
    expect(text).toContain(
      '`SLUG` = `<repo-dir-name>-<target>` (e.g. `myapp-pr-123`, `webapp-diff`), and `<repo-dir-name>-<target>-<AGENT_TAG>` when `agent=<prefix>` was given',
    )
    expect(text).toContain("(`AGENT_TAG` = the prefix's last segment")
    expect(text).toContain('never share a folder, a claim or a worktree')
    // A claim is cleared by a ledger line of the same target and the same agent only.
    expect(text).toContain(
      'no entry for this target (and this `agent`, when `agent=` was given) written after the claim',
    )
    expect(text).toContain('plus `"agent": "<the agent= prefix>"` when `agent=` was given')
    expect(text).toContain('never the review of the same target by a run with another prefix or none')
    // The workflow tells the agent the paths and the reconcile reads both folders.
    const maximum = flat(await workflowText('maximum', 'mid'))
    expect(maximum).toContain('`~/.claude/feature-review/<repo-dir>-<branch>-review-first/`')
    expect(maximum).toContain('`.../<repo-dir>-<branch>-review-second/`')
    expect(maximum).toContain("from each review's own `review.md` in its folder above")
    expect(maximum).toContain(
      "only the ledger line that names that same agent counts (its `path` is that run's own folder",
    )
    expect(maximum).toContain("so the first review's line never makes the second unnecessary")
    // The suffixes the workflow passes are the folders' tags.
    expect(maximum).toContain('agent=<your name>/review-first')
    expect(maximum).toContain('agent=<your name>/review-second')
  })

  it('names the plan when the ticket’s workflow lists its review as skipped but one is asked for (C2)', async () => {
    const text = skill()
    expect(text).toContain(
      'When that workflow lists the ticket\'s review as skipped (a low ticket, no rounds for its level, or the review step turned off) it gives no `phases=`; if a review is asked for anyway (a queue review of its PR, a person\'s request), run the six standard phases and say so in the report: "workflow lists no review for this ticket: the six standard phases"',
    )
    expect(text).toContain('A workflow whose review is Light gives `phases=reviewer`, and that is the plan.')
    const queue = flat(review('skills/review-queue/SKILL.md'))
    expect(queue).toContain('**The plan follows the workflow.**')
    expect(queue).toContain('a project on the Light workflow is reviewed by one reviewer')
    expect(queue).toContain("The runner's `NOTES` names the plan it used")
    expect(flat(review('agents/feature-review-runner.md'))).toContain(
      'the plan the review ran when it was not the six standard phases',
    )
  })

  it('has the hand-off, the board skill, AGENTS.md, the ticket agent and todo-review follow a switched-off step (C7)', async () => {
    const rule = 'its items are not run and not required'
    const boardTexts = await boardSkills()
    for (const [name, text] of Object.entries(boardTexts)) {
      const t = flat(text)
      expect(t, name).toContain("**The project's workflow decides which of these run.**")
      expect(t, name).toContain(rule)
      expect(t, name).toContain(
        'The push, the pull request and the summary are locked: they are always done.',
      )
      // The always-on phrases stay.
      expect(t, name).toContain('Preview running, started before the move to review.')
    }
    const agentsDoc = flat(read(root, 'AGENTS.md'))
    expect(agentsDoc).toContain("**The project's workflow decides which of these run.**")
    expect(agentsDoc).toContain(rule)
    expect(agentsDoc).toContain(
      'The push, the pull request and the summary are locked: they are always done.',
    )
    const ticketAgent = flat(review('agents/todo-review-ticket.md'))
    expect(ticketAgent).toContain('The preview comes before the move to review, never after it')
    expect(ticketAgent).toContain(
      'A step the workflow lists as skipped because the human turned it off on the Workflow page (the preview, or CI) is not run and not required',
    )
    expect(ticketAgent).toContain(
      'The push, the pull request and the summary are locked and are always done.',
    )
    const orchestrator = flat(review('skills/todo-review/SKILL.md'))
    expect(orchestrator).toContain(
      "not required when the ticket's workflow lists CI as skipped, turned off on the Workflow page",
    )
    expect(orchestrator).toContain(
      "(unless the ticket's workflow lists the preview step as skipped: then none is required and the summary says it was turned off on the Workflow page)",
    )
  })

  it('lets a ticket whose workflow lists no review have no depth, and one that lists a review have one (C8)', () => {
    const ticketAgent = flat(review('agents/todo-review-ticket.md'))
    expect(ticketAgent).toContain('When the workflow lists no review for the ticket there is no depth')
    expect(ticketAgent).toContain(
      'A ticket whose workflow lists a review round for it, a low one included, has one and gets a depth.',
    )
    expect(ticketAgent).toContain('none (no review for this ticket: <low ticket | no rounds | review off>)')
    expect(ticketAgent).not.toContain('(low: no review)')
    const orchestrator = flat(review('skills/todo-review/SKILL.md'))
    expect(orchestrator).toContain(
      "Skip this measure when the ticket's workflow lists no review round for it (a low ticket, a level with no rounds, or the review turned off)",
    )
    expect(orchestrator).toContain('a low ticket included, a review ran and is required')
    expect(orchestrator).not.toContain('A low ticket skips this measure')
  })
})
