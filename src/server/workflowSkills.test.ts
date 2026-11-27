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
      "`Team agent <name>` is the project's agent of that name",
      'brief a subagent with the `instructions` that agent has in `get_project` -> `agents`',
      "never the Team agent's name",
      'the workflow text wins',
      '**Effort.**',
      "is the Agent tool's `effort` on **every** agent you start for that step",
      '`effort=<level>` for `/feature-review`',
      '**Hand-off.**',
      '**How it runs.**',
      '`phases=` argument to pass to `/feature-review`',
      'win over any instruction in the workflow text',
    ])
      expect(section, part).toContain(part)
  })

  it("no longer says a hand-off can be the human's own wording (A3)", () => {
    expect(flat(agent())).not.toMatch(/set by the human|replaces the default/)
    expect(flat(review('agents/todo-review-ticket.md'))).not.toContain('(set by the human)')
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
      "the **intent** agent runs at its workflow step's effort (`low` by default in every preset) before the hand-off",
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

  it('lets the session skill send back a ticket without a preview only when the workflow does not skip the step', () => {
    const session = flat(read(skillDir, 'session.md'))
    expect(session).toContain(
      "is not handed off (unless the ticket's workflow lists the preview step as skipped, turned off on the Workflow page, which the summary says)",
    )
  })

  it('has review-queue hand the build cycle to the project’s workflow', () => {
    const queue = flat(review('skills/review-queue/SKILL.md'))
    expect(queue).toContain("the build cycle of the project's workflow (`get_workflow`")
    expect(queue).toContain("the rounds a ticket gets are the workflow's for its level")
    expect(queue).toContain(
      "except the intent agent, which runs at the effort its workflow step gives (`low` by default in every preset), whatever the ticket's complexity",
    )
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
      ['Post its result on the ticket `as` the agent this step names', mid],
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

  it('names the Team agent among what is tweakable, and promises no edited text (A10)', () => {
    const section = flat(readme().split('\n## Workflow\n')[1]!.split('\n## Cleanup\n')[0]!)
    const tweakable = section.slice(
      section.indexOf('**Tweakable, per preset.**'),
      section.indexOf('**Team agents.**'),
    )
    expect(tweakable).toContain('the Team agent each agent-starting step and each review phase runs')
    expect(tweakable).toContain('no text is written in the workflow')
    expect(section).not.toMatch(/hand-off instruction|edited.instructions|instructions\?/i)
    expect(section).toContain('briefs that agent with the instructions it has in the Team')
    expect(section).toContain("A step's span, run report and `agentName` always carry its **role**")
  })

  it('lists each new route and field in the REST table', () => {
    const rows = readme()
      .split('\n')
      .filter((l) => l.startsWith('|'))
    const row = (needle: string) => rows.find((l) => l.includes(needle))
    expect(row('`/api/projects/:id/workflow`')).toContain('{active, team, presets[]}')
    expect(row('`/api/projects/:id/workflow/:preset`')).toContain('{order?, steps?, agents?, rounds?}')
    expect(row('`/api/projects/:id/workflow/:preset`')).toContain('`steps`: `{enabled?, effort?}`')
    expect(row('`/api/projects/:id/workflow/:preset`')).not.toContain('instructions?')
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

  it('has the single-reviewer plan prepare the worktree and the env file, as Phase 1b does for a hunt (C1)', () => {
    const text = skill()
    expect(text).toContain(
      'There is no env phase, so **the run itself prepares the worktree** before it spawns the reviewer, as Phase 1b does for a hunt',
    )
    expect(text).toContain(
      "a prepared `node_modules` copied by hardlink with `cp -al` into a real directory, never a symlink or a junction, or the project's own install",
    )
    expect(text).toContain('write a small `00-env.md` with the test command that runs from the worktree')
    expect(text).toContain('and `Servers: none started`')
    expect(text).toContain("tell it the test slots' rule")
    expect(text).toContain(
      'it starts it itself on a free port, from the worktree, calls only that port, and stops it by the PID it recorded',
    )
    // Light's other rules stay: no spec file, no refute or merge, the survival rule of the workflow.
    expect(text).toContain('there is no `01-spec.md`, `02-verification.md`')
    expect(text).toContain('`Refutation: none (single reviewer)`')
  })

  it('has every place that asks for the intent verdict allow for the check turned off for a low ticket (C2)', async () => {
    const boardTexts = await boardSkills()
    for (const [name, text] of Object.entries(boardTexts)) {
      const t = flat(text)
      expect(t, name).toContain(
        '**When the workflow lists the intent step as skipped for the ticket** (a low ticket with the check turned off on the Workflow page; above low it is locked and always runs), no intent check is run and none is required before the hand-off or the push, and the summary says it was turned off on the Workflow page.',
      )
    }
    const agentsDoc = flat(read(root, 'AGENTS.md'))
    expect(agentsDoc).toContain('**When the workflow lists the intent step as skipped for the ticket**')
    const orchestrator = flat(review('skills/todo-review/SKILL.md'))
    expect(orchestrator).toContain(
      'its verdict is `matches`, unless the workflow lists the intent step as skipped for the ticket (a low ticket with the check turned off on the Workflow page): then none ran, none is required',
    )
    const ticketAgent = flat(review('agents/todo-review-ticket.md'))
    expect(ticketAgent).toContain(
      'When the workflow lists the intent step as skipped for the ticket (a low ticket with the check turned off on the Workflow page), you run no intent check and none is required before the push and the hand-off',
    )
    expect(flat(skill())).toContain(
      "When the ticket's workflow lists the intent step as skipped (a low ticket with the check turned off on the Workflow page), no check runs and none is required.",
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

describe('review fix pass: the intent effort, the browser rule and the screenshot source', () => {
  it('says the intent agent runs at the effort its workflow step gives, in every text that names its effort (C4)', async () => {
    const stale = [
      /always runs at/i,
      /runs at `?low`? effort,? whatever/i,
      /at `low` effort,? whatever/i,
      /effort low \(the Agent tool's `effort: low`\) for every complexity/i,
    ]
    const texts: Record<string, string> = {
      ...(await servedTexts()),
      'feature-review-intent.md': review('agents/feature-review-intent.md'),
      'mcp.ts': read(skillDir, '..', 'mcp.ts'),
      'defaultAgents.ts': read(skillDir, '..', 'defaultAgents.ts'),
    }
    for (const [name, text] of Object.entries(texts))
      for (const re of stale) expect(flat(text), `${name}: ${re}`).not.toMatch(re)
    const step =
      "the effort its workflow step gives (`low` by default in every preset), whatever the ticket's complexity"
    for (const [name, text] of [
      ['board skill', (await boardSkills())['board skill (mcp)']!],
      ['AGENTS.md', read(root, 'AGENTS.md')],
      ['feature-review', review('skills/feature-review/SKILL.md')],
      ['review-queue', review('skills/review-queue/SKILL.md')],
      ['todo-review', review('skills/todo-review/SKILL.md')],
      ['ticket agent', review('agents/todo-review-ticket.md')],
    ] as const)
      expect(flat(text), name).toContain(step)
    // The sentence that says each step's effort rules no longer carves out the intent agent as fixed.
    for (const [name, text] of [
      ['board skill', read(skillDir, 'board.md')],
      ['AGENTS.md', read(root, 'AGENTS.md')],
    ] as const)
      expect(flat(text), name).toContain(
        'the intent agent too, at the effort its own step gives, `low` by default in every preset)',
      )
  })

  it('keeps the needs-browser rule in the ticket agent for every workflow, and out of the preview step (C3)', async () => {
    const agent = flat(review('agents/todo-review-ticket.md'))
    const rule =
      'with `BROWSER=no` and a UI change, do everything else, leave the ticket in progress with its summary saying where you stopped, and return `STATUS: needs-browser`'
    expect(agent).toContain(rule)
    expect(agent).toContain('with or without a preview step in the workflow')
    // The rule sits in the always-on contract, not in a step procedure.
    const contract = flat(agent.slice(agent.indexOf('## The contract: proof, not claims')))
    expect(contract).toContain(rule)
    // The preview step only points at it, so a workflow with the step off still has the rule.
    const on = flat(await workflowText('standard', 'mid'))
    const { renderWorkflowText } = await import('./workflow')
    const offText = flat(
      renderWorkflowText(resolveWorkflow('standard', { steps: { preview: { enabled: false } } }, 'mid'), {
        source: 'project',
        projectPreset: 'standard',
        ticketId: null,
      }),
    )
    expect(on).toContain('your always-on `needs-browser` rule applies')
    expect(on).not.toContain('return `STATUS: needs-browser`')
    expect(offText).not.toContain('needs-browser')
  })

  it('has the orchestrator and the hand-off require screenshots of a UI change only where there is a preview step or the review took some (C3)', async () => {
    const orchestrator = flat(review('skills/todo-review/SKILL.md'))
    expect(orchestrator).toContain(
      'has screenshots in its attachments when the change has a UI and the workflow lists the preview step or the review produced screenshots',
    )
    expect(orchestrator).toContain(
      "with the preview turned off, the screenshots are the review's own, `shots/`, and the summary says the preview was turned off on the Workflow page; none are required when the review took none",
    )
    const rule =
      "With the preview turned off, the screenshots of a UI change are the review's own (`shots/`, the verify phase), required only where the review took them, and the summary says the preview was turned off on the Workflow page."
    for (const [name, text] of Object.entries(await boardSkills())) expect(flat(text), name).toContain(rule)
    expect(flat(read(root, 'AGENTS.md'))).toContain(rule)
    expect(flat(review('agents/todo-review-ticket.md'))).toContain(
      "the review's own run (`shots/`, the verify phase) where the preview is turned off",
    )
  })
})

describe('a step runs the Team agent the workflow names (B9, B11, B14)', () => {
  const render = async (
    tweak: object | undefined,
    team: string[],
    preset: 'standard' | 'maximum' = 'standard',
  ) => {
    const { renderWorkflowText } = await import('./workflow')
    return renderWorkflowText(resolveWorkflow(preset, tweak, 'mid', team), {
      source: 'project',
      projectPreset: preset,
      ticketId: null,
    })
  }
  const stepFiles = fs
    .readdirSync(path.join(skillDir, 'workflow'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [f, read(skillDir, 'workflow', f)] as const)

  it('has no step procedure name a role agent as the fixed one to brief with (B9)', () => {
    for (const [file, text] of stepFiles) {
      expect(flat(text), file).not.toMatch(/\*\*(spec|builder)\*\* agent's `instructions`/)
      expect(flat(text), file).not.toMatch(/`as: (spec|builder)`/)
    }
    for (const file of ['spec.md', 'spec2.md', 'build.md', 'tests.md']) {
      const text = flat(read(skillDir, 'workflow', file))
      expect(text, file).toMatch(/Team agent it names|agent this step names|Agent line/)
    }
  })

  it("serves a step bound to a Team agent with that agent to brief and none of the role's instructions (B9)", async () => {
    const text = flat(await render({ agents: { build: 'acme-dev' } }, ['acme-dev', 'builder']))
    expect(text).toContain('## 3. Build [locked] - Team agent `acme-dev` (role `builder`)')
    expect(text).toContain(
      "brief its subagent with the instructions of `acme-dev` (`get_project` -> `agents`), the project's `instructions` and the ticket's context",
    )
    expect(text).toContain(
      "Start a subagent briefed as this step's Agent line says (the Team agent it names, with that agent's `instructions` from `get_project`)",
    )
    // The only sentence that names the builder agent's instructions is the fix pass's, which has its own line.
    expect(text).not.toMatch(/the \*\*builder\*\* agent's `instructions`/)
    expect(text).toContain("run by the agent the review's `Between rounds` line names for it")
  })

  it('serves a built-in role, and a pick the Team lost, with the role it falls back to (B9)', async () => {
    const builtIn = flat(await render(undefined, []))
    expect(builtIn).toContain(
      'the Team has no agent named `builder`, so this runs as the built-in `builder` role',
    )
    expect(builtIn).toContain(
      'The human can add the role to the Team or pick another Team agent for it on the Workflow page.',
    )
    const gone = flat(await render({ agents: { build: 'acme-dev' } }, ['builder']))
    expect(gone).toContain(
      '## 3. Build [locked] - Team agent `builder` [picked `acme-dev` is not in the Team]',
    )
    expect(gone).toContain(
      "The workflow names `acme-dev` for it, but the project's Team has no agent of that name (deleted or renamed), so it runs as if none were picked.",
    )
  })

  it('keeps the intent agent blind whichever Team agent runs it (B9)', async () => {
    const text = flat(await render({ agents: { intent: 'acme-dev' } }, ['acme-dev']))
    expect(text).toContain(
      "brief its subagent with the instructions of `acme-dev` (`get_project` -> `agents`) and, besides them, only what the intent step lists: the human's own words and the result",
    )
    expect(text).toContain('Brief it with only two things besides them')
    const intent = flat(read(skillDir, 'workflow', 'intent.md'))
    expect(intent).toContain("Never give it the builder's plan, the spec, the review's findings")
  })

  it('has spans, run reports and agentName named by the role, never by the picked agent (B11)', async () => {
    const text = flat(
      await render(
        { agents: { 'review.hunt-a': 'sec-hunter', 'review.hunt-b': 'sec-hunter', spec: 'acme-dev' } },
        ['sec-hunter', 'acme-dev'],
      ),
    )
    expect(text).toContain(
      'Name its span, its run report and its `agentName` by the role `spec`, never by `acme-dev`',
    )
    expect(text).toContain(
      "A phase's span, run report and `agentName` carry its role (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`, `intent`), never the Team agent's name",
    )
    expect(text).toContain(
      'phases=spec,env,verify,hunt,hunt,refute,merge agents=spec,env,verify,sec-hunter,sec-hunter,refute,merge',
    )
    // The review step and the feature-review skill say the same, so the phase agents it starts follow.
    expect(flat(read(skillDir, 'workflow', 'review.md'))).toContain(
      "carry its role (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`), never the Team agent's name",
    )
    const skill = flat(review('skills/feature-review/SKILL.md'))
    expect(skill).toContain('| `agents=<list>` | the Team agent that briefs each phase of `phases=`')
    expect(skill).toContain("spans, run reports and `agentName` still carry the phase's own name")
  })

  it('says "never by" only of a name that differs from the role, for every preset and complexity (B11)', async () => {
    const { renderWorkflowText } = await import('./workflow')
    const roles = ['spec', 'builder', 'runner', 'env', 'verify', 'hunt', 'refute', 'merge', 'intent']
    const teams: [string, string[], Record<string, string> | undefined][] = [
      ['no Team', [], undefined],
      ['role agents', roles, undefined],
      [
        'a pick of another name',
        [...roles, 'acme-dev'],
        { spec: 'acme-dev', build: 'acme-dev', 'review.hunt-a': 'acme-dev', 'review.hunt-b': 'acme-dev' },
      ],
    ]
    let picked = 0
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of COMPLEXITIES)
        for (const [label, team, agents] of teams) {
          const w = resolveWorkflow(preset, agents && { agents }, complexity, team)
          const text = renderWorkflowText(w, { source: 'project', projectPreset: preset, ticketId: null })
          const at = `${preset}/${complexity}/${label}`
          for (const line of text.split('\n')) {
            const m = /by the role `([^`]+)`,? ?(?:never by `([^`]+)`)?/.exec(line)
            if (m?.[2]) {
              expect(m[2].toLowerCase(), `${at}: ${line.slice(0, 160)}`).not.toBe(m[1])
              picked++
            }
          }
          if (agents && !w.steps.every((x) => x.skipped || x.teamAgent?.source !== 'picked'))
            expect(text, at).toMatch(/by the role `[a-z]+`, never by `acme-dev`:/)
          if (team.length > 0 && !agents) expect(text, at).not.toContain('never by')
          // The role is also the agent's name: the line says so, and posts as the agent.
          if (team === roles)
            expect(text, at).toContain(
              "by the role `builder` (which is also the agent's name): the board counts this step's runs by role.",
            )
        }
    expect(picked).toBeGreaterThan(0)
  })

  it("posts a fix pass as the agent the Between rounds line names, never as the Build step's agent (B9)", async () => {
    const { renderWorkflowText } = await import('./workflow')
    const ctx = { source: 'project', projectPreset: 'standard', ticketId: null } as const
    const asBuild = 'Post its summary `as` the agent this step names (the Agent line).'
    const asFix =
      "except a fix pass (after a review round or after an intent return): that summary goes `as` the agent the review's `Between rounds` line names for the fix pass, with no `as` when that line names a built-in agent"
    const team = ['acme-dev', 'frh-fixer', 'builder']
    let withFix = 0
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of COMPLEXITIES) {
        const at = `${preset}/${complexity}`
        const picks = { agents: { build: 'acme-dev', 'review.fix': 'frh-fixer' } }
        for (const [label, tweak, names] of [
          ['build and fix bound apart', picks, 'Team agent `frh-fixer`'],
          ['unbound', undefined, 'Team agent `builder`'],
        ] as const) {
          const w = resolveWorkflow(preset, tweak, complexity, team)
          const text = flat(renderWorkflowText(w, { ...ctx, projectPreset: preset }))
          const hasFix = w.steps.some(
            (s) => !s.skipped && s.review?.between.some((b) => /fix/i.test(b.label)),
          )
          const build = w.steps.find((s) => s.id === 'build' && !s.skipped)
          if (!build) continue
          const from = text.indexOf('Start a subagent briefed as')
          const section = text.slice(from, text.indexOf(' ## ', from))
          if (hasFix) {
            withFix++
            // The fix pass has its own post name, the Between rounds line's agent, and the Build agent's name is not it.
            expect(section, `${at}/${label}`).toContain(asFix)
            expect(section, `${at}/${label}`).not.toContain(asBuild)
            expect(text, `${at}/${label}`).toContain(`Between rounds: fix pass (${names}`)
          } else {
            // No review, so no Between rounds line: a later round is a gate return, run by the Build step's agent.
            expect(section, `${at}/${label}`).toContain(asBuild)
            expect(section, `${at}/${label}`).not.toContain('Between rounds')
          }
        }
      }
    expect(withFix).toBeGreaterThan(0)
  })

  it('posts every pass as the agent that runs it: the round-end intent check, the intent step and a fix pass (B9)', async () => {
    const { renderWorkflowText } = await import('./workflow')
    const ctx = { source: 'project', projectPreset: 'standard', ticketId: null } as const
    const team = ['acme-dev', 'frh-fixer', 'acme-int', 'frh-int', 'builder', 'intent']
    const picks = {
      agents: {
        build: 'acme-dev',
        'review.fix': 'frh-fixer',
        intent: 'acme-int',
        'review.intent': 'frh-int',
      },
    }
    const sectionOf = (text: string, title: string) =>
      text.match(new RegExp(`## \\d+\\. ${title}.*?(?= ## \\d+\\. |$)`))?.[0] ?? null
    const roundEnd =
      "the review's round-end intent check is run and posted by the agent the review's `intent` phase line names, not by this one"
    const fixPass =
      "a fix pass (after a review round or after an intent return) is run and posted by the agent the review's `Between rounds` line names, not by this one"
    let roundEndRuns = 0
    let fixRuns = 0
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of COMPLEXITIES)
        for (const [label, tweak, names] of [
          [
            'picks apart',
            picks,
            { intent: 'frh-int', fix: 'frh-fixer', stepIntent: 'acme-int', build: 'acme-dev' },
          ],
          [
            'unbound',
            undefined,
            { intent: 'intent', fix: 'builder', stepIntent: 'intent', build: 'builder' },
          ],
        ] as const) {
          const at = `${preset}/${complexity}/${label}`
          const w = resolveWorkflow(preset, tweak, complexity, team)
          const text = flat(renderWorkflowText(w, { ...ctx, projectPreset: preset }))
          const reviewStep = w.steps.find((s) => s.id === 'review' && !s.skipped)
          const roundEndPhase = reviewStep?.review?.phases.some((p) => p.id === 'review.intent') ?? false
          const build = sectionOf(text, 'Build')
          const intent = sectionOf(text, 'Intent check')
          const review = sectionOf(text, 'Review')

          if (build) {
            // The Build step's Agent line posts only its own run; a fix pass is the Between rounds agent's, posted as it.
            const line = build.match(/Agent: .*?(?= Hand-off: )/)?.[0] ?? ''
            if (reviewStep) {
              fixRuns++
              expect(line, at).toContain(fixPass)
              expect(build, at).toContain(
                "except a fix pass (after a review round or after an intent return): that summary goes `as` the agent the review's `Between rounds` line names",
              )
              expect(review, at).toContain(`Between rounds: fix pass (Team agent \`${names.fix}\``)
            } else {
              expect(line, at).not.toContain('Between rounds')
              expect(build, at).not.toContain('Between rounds')
            }
          }

          if (intent) {
            const line = intent.match(/Agent: .*?(?= Hand-off: )/)?.[0] ?? ''
            // The step's own run is posted as the Intent step's agent.
            expect(line, at).toContain(`as: ${names.stepIntent}\``)
            if (roundEndPhase) {
              roundEndRuns++
              // The round-end check is run by the agent its phase line names, and every sentence that posts it says so.
              expect(review, at).toContain(`Intent check - Team agent \`${names.intent}\``)
              expect(line, at).toContain(roundEnd)
              expect(intent, at).toContain(
                "the round-end check of a review that has one is run and posted by the agent the review's `intent` phase line names, not as this step's agent",
              )
              expect(review, at).toContain(
                "by the agent the review's `intent` phase line names, and post it `as` that agent, none for a built-in one",
              )
            } else {
              expect(line, at).not.toContain(roundEnd)
              expect(intent, at).not.toContain('round-end check')
            }
            // An intent return's fix pass is run and posted by the Between rounds agent, or the Build agent with no review.
            expect(intent, at).toContain(
              reviewStep
                ? "(that fix pass is run and posted by the agent the review's `Between rounds` line names)"
                : 'back to the builder with the intent check',
            )
            if (!reviewStep) expect(intent, at).not.toContain('Between rounds')
          }
        }
    expect(roundEndRuns).toBeGreaterThan(0)
    expect(fixRuns).toBeGreaterThan(0)
  })

  it("names a step's agent by the Team agent the workflow names, never by a fixed agent name (B9)", async () => {
    // The intent and hunt agents are the step's pick: by default the agent named like the role, else the built-in.
    const fixed = [
      /the project's `(intent|hunt|spec|builder|runner|env|verify|refute|merge)` agent/,
      /project's `(intent|hunt|spec|builder|runner|env|verify|refute|merge)` agent/,
      // The bold role label too: "the project's **intent** agent" names a fixed agent, not the step's Team agent.
      /project's \*\*(intent|hunt|spec|builder|runner|env|verify|refute|merge)\*\*/,
      /The subagents are the project's `spec`/,
    ]
    const texts: Record<string, string> = {
      ...(await servedTexts()),
      'feature-review-intent.md': review('agents/feature-review-intent.md'),
      'feature-review-hunt.md': review('agents/feature-review-hunt.md'),
    }
    for (const file of fs.readdirSync(path.join(skillDir, 'workflow')))
      texts[`workflow/${file}`] = read(skillDir, 'workflow', file)
    for (const [file, text] of Object.entries(texts))
      for (const bad of fixed) expect(flat(text), `${file} ${bad}`).not.toMatch(bad)
    expect(flat(review('agents/todo-review-ticket.md'))).toContain(
      "The intent agent (the Team agent the intent step names in the project's workflow, `get_workflow`: by default the project's agent named `intent`, else the built-in `feature-review-intent`)",
    )
    expect(flat(review('skills/feature-review/SKILL.md'))).toContain(
      "It runs the Team agent the intent step names in the project's workflow (`get_workflow`; by default the project's agent named `intent`, else the built-in `feature-review-intent`)",
    )
  })

  it("has a review of a ticket with no phases= take the workflow's agents= too, an explicit agents= still winning (C1)", async () => {
    const skill = flat(review('skills/feature-review/SKILL.md'))
    expect(skill).toContain(
      "the `phases=` its review step gives for this run, and the `agents=` it prints with them for the same run (the human's Team picks for the review phases)",
    )
    expect(skill).toContain('An `agents=` given in the call still wins.')
    expect(skill).toContain(
      "on a board ticket with no `phases=`: the `agents=` the ticket's workflow gives with its plan",
    )
    expect(skill).toContain(
      "(an `agents=` given in the call, else the one the ticket's workflow gave with the plan, **The plan** rule 2)",
    )
    const queue = flat(review('skills/review-queue/SKILL.md'))
    expect(queue).toContain(
      "The runner reads both `phases=` and `agents=` of the ticket's workflow from `get_workflow` (it prints them together per run), so the human's Team picks for the review phases apply here too.",
    )
    expect(queue).toContain("pass `agents=` only to override the workflow's picks")
    // The workflow prints both for the run, so there is something to read.
    expect(flat(await workflowText('standard', 'mid'))).toMatch(/phases=\S+ agents=\S+ effort=/)
  })

  it('serves the review step as the skill the ticket agent runs itself, with no Team agent of its own (C2)', async () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of ['mid', 'high', 'max']) {
        const text = await workflowText(preset, complexity)
        const at = `${preset}/${complexity}`
        const heading = text.split('\n').find((l) => /^## \d+\. Review - /.test(l))
        expect(heading, at).toMatch(/^## \d+\. Review - agent \/feature-review(, effort \w+)?$/)
        const section = text.slice(text.indexOf(heading!), text.indexOf('\n## ', text.indexOf(heading!)))
        expect(section, at).not.toContain('Agent: ')
        expect(section, at).not.toMatch(/run by (built-in|Team agent)/)
      }
    for (const file of ['AGENTS.md', 'board.md'])
      expect(flat(file === 'AGENTS.md' ? read(root, file) : read(skillDir, file)), file).toContain(
        'The review step names none: you run it through the /feature-review Skill in your own session, and its phases name their own Team agents.',
      )
  })

  it("has the board skill, AGENTS.md and the MCP text say where a step's instructions come from (B14)", async () => {
    const sentence =
      "Each step that runs an agent names the **Team agent** that runs it (the human's pick on the Workflow page, else the Team agent named like the step's role, else the built-in role)"
    expect(flat(read(skillDir, 'board.md'))).toContain(sentence)
    expect(flat(read(root, 'AGENTS.md'))).toContain(sentence)
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer gate_test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      'claude',
    )
    const tools = ((await res.json()) as { result: { tools: { name: string; description: string }[] } })
      .result.tools
    const init = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer gate_test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        }),
      }),
      'claude',
    )
    const instructions = ((await init.json()) as { result: { instructions: string } }).result.instructions
    expect(instructions).toContain(
      "the project's workflow (get_workflow) names the Team agent that runs it: the human's pick on the Workflow page",
    )
    expect(instructions).toContain("never by that agent's name")
    const text = tools.map((t) => t.description).join('\n')
    expect(text).not.toContain('edited.instructions')
    expect(text).not.toContain('the human wrote it')
    expect(tools.find((t) => t.name === 'get_workflow')!.description).toContain(
      'teamAgent ({name, source, picked, missing}',
    )
  })
})

describe('the early look and the browser probes for a ticket that touches UI or starts from the human’s words', () => {
  /** One step of a served workflow text, by its label, flattened; empty when the text has no such step. */
  const step = (text: string, label: string) =>
    flat(text.split(/^## \d+\. /m).find((part) => part.startsWith(`${label} `)) ?? '')
  const project = (
    preset: 'light' | 'standard' | 'thorough' | 'maximum',
    complexity: 'low' | 'mid',
    tweak: object,
  ) =>
    import('./workflow').then(({ renderWorkflowText }) =>
      renderWorkflowText(resolveWorkflow(preset, tweak, complexity), {
        source: 'project',
        projectPreset: preset,
        ticketId: null,
      }),
    )
  const PROBES = [
    '390 px width',
    'Long unbroken strings',
    'Dark mode',
    'Keyboard focus',
    'Slow or failed saves',
  ]

  it('defines the two kinds of ticket once, in the claim step, and the later steps point at it', async () => {
    const text = await workflowText('standard', 'mid')
    const definition = "**An early-look ticket** is one that touches UI or starts from the human's own words."
    expect(flat(text).split(definition)).toHaveLength(2)
    const claim = step(text, 'Read and claim')
    expect(claim).toContain(definition)
    expect(claim).toContain(
      "It touches UI when the spec's Classification has `ui`, or, with no spec, when the diff changes what a browser renders",
    )
    expect(claim).toContain(
      "It starts from the human's own words when the human wrote it, or posted or replied on it before this claim",
    )
    expect(claim).toContain('not when an agent created it from its own finding')
    for (const label of ['Gate', 'Intent check'])
      expect(step(text, label), label).toContain("an early-look ticket (the claim step's item 5)")
  })

  it('starts the preview after the first gate and before round 1, and the preview step reuses it', async () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of ['mid', 'high'] as const) {
        const text = await workflowText(preset, complexity)
        const at = `${preset}/${complexity}`
        expect(step(text, 'Gate'), at).toContain(
          "4. **The early look**, for an early-look ticket (the claim step's item 5): once, after the first gate passes and before review round 1 starts. Start the preview of this head now, as the preview step says (its one build of this head: the preview step finds it running and reuses it)",
        )
        const preview = step(text, 'Preview')
        expect(preview, at).toContain(
          'When the gate already started it for this head (the early look, after the first gate and before round 1: the gate step says when), it runs: reuse it, take only the screenshots still missing and build nothing.',
        )
        expect(preview, at).toContain('never build the head twice for the preview')
      }
  })

  it('posts the preview and screenshots on Main as a plain "Direction OK?" post, never a decision card', async () => {
    for (const preset of WORKFLOW_PRESETS) {
      const gate = step(await workflowText(preset, 'mid'), 'Gate')
      expect(gate, preset).toContain(
        'Post them on Main as a plain post, not a decision card (an open card, even with `block: false`, reads as waiting on the human for the whole review): `post_update` with `tab: main`, `progress: false` and the screenshots in `files`, whose body opens with "Direction OK?", says what changed, gives the preview link and says that a reply under this post changes the ask.',
      )
      expect(gate, preset).toContain(
        'Do not wait for an answer: the ticket stays in progress and round 1 starts at once.',
      )
      // An open card holds the ticket as waiting on the human, the merge and the pick-up.
      expect(gate, preset).not.toContain('Post on Main an `ask_decision`')
      expect(gate, preset).not.toContain('Looks right')
      expect(gate, preset).not.toContain('reply under this card')
    }
    // The ticket agent's own rule that every question blocks names this post as an exception.
    expect(flat(review('agents/todo-review-ticket.md'))).toContain(
      'A `request_archive` card, an `ask_decision` with `block: false`, or the gate\'s early-look "Direction OK?" post on Main, is not a question you wait on: the ticket stays where it is.',
    )
  })

  it('reads the replies under the post before each next round and hands a changed ask to the fix pass and the intent check', async () => {
    const text = await workflowText('standard', 'mid')
    const gate = step(text, 'Gate')
    expect(gate).toContain(
      "Before each next round and before the hand-off, read every reply under the post: they are the human's words, like a decision answer.",
    )
    expect(gate).toContain(
      "A reply that changes the ask is handled before that round: it goes to the fix pass's brief as the human's words and to the intent check's brief",
    )
    expect(gate).toContain(
      'when round 1 survived and no round follows, it gets a fix pass, the gate and one more review round',
    )
    expect(step(text, 'Build')).toContain(
      'A reply under the early look\'s "Direction OK?" post that changes the ask goes in it first, as the human\'s words.',
    )
  })

  it('asks for no early preview or direction post with the preview off, nor for a ticket with no review', async () => {
    for (const preset of WORKFLOW_PRESETS) {
      const off = flat(await project(preset, 'mid', { steps: { preview: { enabled: false } } }))
      expect(off, preset).not.toContain('Direction OK?')
      expect(off, preset).not.toContain('Start the preview of this head now')
      expect(off, preset).not.toContain('needs-browser')
      expect(off, preset).not.toContain('the screenshots the gate took for the early look')
      const low = flat(await workflowText(preset, 'low'))
      expect(low, preset).not.toContain('Direction OK?')
      expect(low, preset).not.toContain('**The early look**')
      expect(low, preset).not.toContain('alongside review round 1')
    }
    // With the preview off the round-1 intent run still runs, on the diff alone.
    const standardOff = await project('standard', 'mid', { steps: { preview: { enabled: false } } })
    expect(step(standardOff, 'Gate')).toContain(
      'The preview step is turned off, so there is no preview and no direction post.',
    )
    expect(step(standardOff, 'Intent check')).toContain('only the diff at that head.')
  })

  it('runs the intent check alongside round 1 on the diff and the gate’s screenshots, and keeps the run before the hand-off', async () => {
    for (const preset of ['light', 'standard'] as const) {
      const text = await workflowText(preset, 'mid')
      const intent = step(text, 'Intent check')
      expect(intent, preset).toContain(
        "For an early-look ticket (the claim step's item 5) it also runs once alongside review round 1: start it as round 1 starts, on the head the first gate passed, briefed with the human's own words (below) and only the diff at that head and the screenshots the gate took for the early look.",
      )
      expect(intent, preset).toContain("Its `does not match` lines go to the builder with round 1's findings")
      expect(intent, preset).toContain('It counts toward the SECOND `does not match`.')
      expect(intent, preset).toContain(
        'The run after the last review round and before the hand-off still runs.',
      )
      expect(intent, preset).toContain(
        'After the last review round passes (a ticket with no review: after its gate and evidence) and before every hand-off',
      )
      expect(intent, preset).toContain(
        "Never give it the builder's plan, the spec, the review's findings or the options an agent put on a card: it must not inherit their reading.",
      )
      expect(step(text, 'Gate'), preset).toContain(
        "The intent step's round-1 run starts with it (that step says how).",
      )
    }
    // Thorough and Maximum check intent at the end of every round already: round 1's is the early one.
    for (const preset of ['thorough', 'maximum'] as const) {
      const text = await workflowText(preset, 'mid')
      expect(step(text, 'Intent check'), preset).toContain(
        "For an early-look ticket (the claim step's item 5), round 1's round-end intent check is its early check: no second run in round 1.",
      )
      expect(flat(text), preset).not.toContain('alongside review round 1')
      expect(step(text, 'Gate'), preset).not.toContain('round-1 run')
    }
  })

  it('has the intent agent file name its run alongside round 1 and its inputs, and the round in its report', () => {
    const file = review('agents/feature-review-intent.md')
    expect(frontmatter(file, 'description')).toContain(
      "Runs at low effort after the last review round and before every hand-off, on every ticket, and also alongside review round 1 for a ticket that touches UI or starts from the human's own words.",
    )
    const input = flat(file.split('## Input')[1]!.split('## Task')[0]!)
    expect(input).toContain(
      "A run alongside review round 1 (for a ticket that touches UI or starts from the human's own words) gets only the diff at the head the first gate passed and the screenshots the gate took then",
    )
    expect(input).toContain('the run before the hand-off gets the preview of the head being handed off')
    expect(input).toContain('Your report carries the round.')
    expect(flat(file)).toContain('open the preview (when you were given one)')
  })

  it('has a round-1 hunt on a UI change drive a browser through the fixed probe list', () => {
    const file = review('agents/feature-review-hunt.md')
    const section = file.split('## Browser probes on a UI change')[1]!.split('\n## ')[0]!
    expect(flat(section)).toContain(
      'In round 1 (`ROUND` 1), when your sections include `ui` (a change that touches UI',
    )
    expect(flat(section)).toContain('the browser flag is `yes`')
    expect(flat(section)).toContain(
      'drive a browser against the changed pages, not only the code and unit probes',
    )
    // All five in one numbered list, in order.
    const list = [...section.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => [m[1], m[2]])
    expect(list).toEqual(PROBES.map((name, i) => [String(i + 1), name]))
    expect(flat(section)).toContain(
      'A probe you could not run (the flag `no`, no base URL, the page unreachable) goes in your report with why.',
    )
    expect(flat(file)).toContain('the round (`ROUND`)')
  })

  it('lets the single reviewer start the page for the round-1 browser probes on a UI change', async () => {
    const allowed =
      'in round 1 of a UI change with the browser flag `yes`, to run the browser probes on the changed pages'
    const light = flat(await workflowText('light', 'mid'))
    expect(light).toContain(
      `The reviewer starts a server only when reproducing a finding needs one or, ${allowed}, from the worktree, on a free port it picks, and stops it by its PID before it returns.`,
    )
    expect(flat(review('skills/feature-review/SKILL.md'))).toContain(
      `Starting a server is the reviewer's own call, only when reproducing a finding needs one or, ${allowed}: it starts it itself on a free port, from the worktree`,
    )
    const section = review('agents/feature-review-hunt.md')
      .split('## Browser probes on a UI change')[1]!
      .split('\n## ')[0]!
    expect(flat(section)).toContain(
      'the single reviewer, whose `00-env.md` starts no servers, starts the page itself for these probes: from the worktree, on a free port, stopped by its PID before it returns',
    )
  })

  it('has the ui checklist and the hunt report template agree with the probe list', () => {
    const ui = flat(review('skills/feature-review/checklists.md').split('\n## ui\n')[1]!.split('\n## ')[0]!)
    expect(ui).toContain(
      'the hunt\'s fixed probe list (`feature-review-hunt.md`, "Browser probes on a UI change")',
    )
    for (const name of PROBES) expect(ui.toLowerCase(), name).toContain(name.toLowerCase())
    const template = flat(review('run-reports/hunt.md'))
    expect(template).toContain('- **probes** (`probes`): on a UI change, each of the fixed browser probes')
    for (const name of PROBES) expect(template.toLowerCase(), name).toContain(name.toLowerCase())
    expect(template).toContain('run in a browser or not, and for each one not run, why')
  })

  it('gives a UI ticket with no review a five-minute browser probe in the gate, and no review round', async () => {
    for (const preset of ['light', 'standard'] as const) {
      const text = await workflowText(preset, 'low')
      const gate = step(text, 'Gate')
      expect(gate, preset).toContain(
        "**A browser probe for a ticket that touches UI** (the claim step's item 5), in this gate, about five minutes and no more: on the changed pages, hover what reacts to hover, scroll each page to its end, check that sticky elements (headers, bars, toolbars) stay put and cover nothing, and repeat it all at 390 px width.",
      )
      expect(gate, preset).toContain('What it finds wrong goes back to the builder as a gate return.')
      expect(text, preset).toContain('- Review - skipped')
      expect(text, preset).not.toContain('phases=')
      // A ticket with a review gets the round-1 hunt's probes instead.
      expect(flat(await workflowText(preset, 'mid')), preset).not.toContain('about five minutes')
    }
    // With the preview off the probe runs against the app started from the worktree.
    const off = step(await project('standard', 'low', { steps: { preview: { enabled: false } } }), 'Gate')
    expect(off).toContain('Run it against the app started from the worktree on a free port from `PORTS`')
  })

  it('keeps probe scripts in the review folder for the next round, and keeps the worktree clean', () => {
    const hunt = flat(review('agents/feature-review-hunt.md'))
    expect(hunt).toContain(
      '**Kept probes.** `WORKDIR/probes/` keeps probe scripts from one round to the next',
    )
    expect(hunt).toContain('Look there first: rerun each script that fits the change at this head')
    expect(hunt).toContain('write new ones only for what they miss')
    expect(hunt).toContain('Save a copy of each probe worth rerunning')
    expect(hunt).toContain(
      'Probe files in the worktree: only under your prefix, deleted before you finish (the copies in `WORKDIR/probes/` stay).',
    )
    expect(hunt).toContain('`git -C WORKTREE status --porcelain` must show nothing of yours.')
    expect(hunt).not.toContain(
      'Probe files: only inside the worktree, only under your prefix, deleted before you finish.',
    )
  })

  it('never deletes the kept probes between rounds: the setup that recreates the review folder keeps them', async () => {
    const skill = flat(review('skills/feature-review/SKILL.md'))
    const recreate = [...skill.matchAll(/recreate `WORKDIR`[^.]*/g)].map((m) => m[0])
    expect(recreate.length).toBeGreaterThan(0)
    for (const sentence of recreate) expect(sentence).toContain('keeping only its `probes/` folder')
    expect(flat(review('agents/feature-review-hunt.md'))).toContain(
      "the review's setup keeps that folder when it recreates `WORKDIR`",
    )
    // Nothing else in the bundle or the served text removes it.
    const texts = [
      ...agents
        .reviewBundlePaths()
        .filter((p) => p.endsWith('.md'))
        .map((p) => flat(review(p))),
      flat(await workflowText('standard', 'mid')),
      flat(await workflowText('maximum', 'high')),
    ]
    for (const text of texts) expect(text).not.toMatch(/(rm|remove|delete)[^.]{0,40}probes\//i)
    expect(flat(await workflowText('standard', 'mid'))).toContain(
      "It names the review's kept probe scripts (`probes/` in the review folder), which the builder reruns on its fix.",
    )
  })

  it('has the claim step reproduce or measure a symptom on the human’s machine before any lanes, in every workflow', async () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const complexity of COMPLEXITIES)
        expect(
          step(await workflowText(preset, complexity), 'Read and claim'),
          `${preset}/${complexity}`,
        ).toContain(
          "6. **A symptom on the human's machine** (slow, a device, a screen size): when the ticket reports one, reproduce or measure it on that machine first, or ask the human for the measurement, before you split the work into lanes or brief any builder.",
        )
  })

  it('names no ticket, host or private path in the bundle files it changed', () => {
    const banned = [
      new RegExp(`#${'\\d'}{3,}\\b`),
      new RegExp(`localhost:${'47'}100`),
      new RegExp(`/${'home'}/`),
    ]
    for (const file of [
      'agents/feature-review-hunt.md',
      'agents/feature-review-intent.md',
      'skills/feature-review/checklists.md',
      'run-reports/hunt.md',
    ])
      for (const pattern of banned) expect(review(file), `${file}: ${pattern}`).not.toMatch(pattern)
  })
})
