import { COMPLEXITIES, COMPLEXITY_EFFORT, type Complexity } from './constants'

/**
 * The workflow module: the order in which a ticket's agent delegates the build-and-review cycle (read
 * and claim, spec, build, gate, review rounds, preview, intent check, push, PR, CI, summary, hand-off),
 * as data. The board serves a project's active workflow to its agents (`get_workflow`) and the Workflow
 * page draws it as a tree; neither hard-codes the order.
 *
 * Pure and shared by the client and the server: no database, no I/O. The long procedure of each step is
 * markdown the server serves (src/server/skill/workflow/<id>.md); this file holds what the page and the
 * served text both show: the catalogue (every step the cycle can have), the four presets (an ordered
 * list of those steps, the review rounds per complexity, an effort each), the tweaks a human saves on
 * top of a preset, and `resolveWorkflow`, which turns a preset and its tweaks into the tree.
 *
 * A *preset* (`light|standard|thorough|maximum`) is not the review *depth* (`light|standard|deep`):
 * the depth is how hard one review hunts, the preset is which steps and phases a ticket goes through.
 */

// --- ids ---

export const WORKFLOW_PRESETS = ['light', 'standard', 'thorough', 'maximum'] as const
export type WorkflowPresetId = (typeof WORKFLOW_PRESETS)[number]
/** The preset of a project that never chose one, and of every project stored before presets existed. */
export const DEFAULT_WORKFLOW_PRESET: WorkflowPresetId = 'standard'

export const isWorkflowPreset = (value: unknown): value is WorkflowPresetId =>
  typeof value === 'string' && (WORKFLOW_PRESETS as readonly string[]).includes(value)

/** Every step the cycle can have, in the order the fullest preset runs them. Ids are stable. */
export const WORKFLOW_STEP_IDS = [
  'claim',
  'spec',
  'spec2',
  'build',
  'tests',
  'gate',
  'review',
  'preview',
  'intent',
  'push',
  'pr',
  'ci',
  'summary',
  'handoff',
] as const
export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number]

export const isWorkflowStep = (value: unknown): value is WorkflowStepId =>
  typeof value === 'string' && (WORKFLOW_STEP_IDS as readonly string[]).includes(value)

/** The thinking effort a step can be set to: `auto` follows the ticket's complexity (COMPLEXITY_EFFORT). */
export const WORKFLOW_EFFORTS = ['auto', 'low', 'medium', 'high'] as const
export type WorkflowEffort = (typeof WORKFLOW_EFFORTS)[number]
export type EffortLevel = Exclude<WorkflowEffort, 'auto'>

/** The longest hand-off instruction a human can save for a step, in characters. */
export const INSTRUCTIONS_MAX = 4000
/** The most review rounds a human can set for one complexity; the presets' own never pass it. */
export const ROUNDS_MAX = 12

/**
 * Who runs a step: the ticket agent itself (`you`), or an agent it starts. These are roles, resolved
 * against the project's agents by name and delegation notes: `spec`, `builder`, `intent` and the review's
 * phase agents, and `runner`, the `/feature-review` run that starts those phase agents.
 */
export type WorkflowAgent =
  | 'you'
  | 'spec'
  | 'builder'
  | 'runner'
  | 'env'
  | 'verify'
  | 'hunt'
  | 'refute'
  | 'merge'
  | 'intent'

/** The kinds of run a review round is made of; the work timeline and the run reports name them. */
export const REVIEW_PHASE_KINDS = ['spec', 'env', 'verify', 'hunt', 'refute', 'merge'] as const
export type ReviewPhaseKind = (typeof REVIEW_PHASE_KINDS)[number]

// --- the catalogue ---

/** Why a step cannot be turned off: always, or on every ticket above low (low may still drop it). */
export type WorkflowLock = 'always' | 'above-low'

export interface WorkflowStepDef {
  id: WorkflowStepId
  label: string
  /** One paragraph on what the step does: shown on the tree and at the head of the served step. */
  what: string
  /**
   * The default hand-off instruction: what the step receives and passes on, and what the ticket agent
   * checks when it returns. A human's edit replaces it for the preset.
   */
  handoff: string
  agent: WorkflowAgent
  /** `always`: never off. `above-low`: never off for a ticket above low. */
  lock: WorkflowLock | null
  /** Why the lock holds, for the tooltip of a switch that cannot be turned off. */
  lockReason: string | null
  /** The step is dropped for a low ticket (no spec agent, no extra passes). */
  aboveLow: boolean
  /** Steps that must come earlier in the order (those the preset has). */
  after: readonly WorkflowStepId[]
  /** `claim` stays first and `handoff` last, whatever else moves. */
  pinned: 'first' | 'last' | null
  /** The work timeline span the step opens (`start_span`), and whether it carries the round number. */
  span: { phase: string; round: boolean } | null
  /** The step has sub-steps in the tree (the review's phases): they belong to the preset, see `review`. */
  hasSubSteps: boolean
}

const ALWAYS = 'Locked: the ticket cannot be handed off without it.'

/** What each agent-run step is called in the tree and the served text. */
export const AGENT_LABELS: Record<WorkflowAgent, string> = {
  you: 'you',
  spec: 'spec',
  builder: 'builder',
  runner: '/feature-review',
  env: 'env',
  verify: 'verify',
  hunt: 'hunt',
  refute: 'refute',
  merge: 'merge',
  intent: 'intent',
}

export const WORKFLOW_STEPS: Readonly<Record<WorkflowStepId, WorkflowStepDef>> = {
  claim: {
    id: 'claim',
    label: 'Read and claim',
    what: "Reads the project (its instructions and its agents) and the whole ticket: the summary first, every post and reply, the decisions with their answers and the attachments. Then claims the ticket on a branch, sets up the ticket's worktree and installs.",
    handoff:
      "The ticket's context (its instructions, the human's posts and replies, the decisions with their answers, the attachments) goes into every brief that follows, with the worktree and the branch.",
    agent: 'you',
    lock: 'always',
    lockReason: 'Locked: nothing can start before the ticket is read and claimed.',
    aboveLow: false,
    after: [],
    pinned: 'first',
    span: null,
    hasSubSteps: false,
  },
  spec: {
    id: 'spec',
    label: 'Spec',
    what: 'The spec agent restates the ticket as a testable spec (the intent, the acceptance criteria, the surfaces the change touches, what is out of scope) and writes it to the run folder. The ticket agent turns the criteria into tasks, posts the spec and puts a decisive open question on a decision card.',
    handoff:
      "The spec's path and its open questions go to the builder with the ticket's context. A decisive open question stops the run on a decision card before anything is built on a guess.",
    agent: 'spec',
    lock: null,
    lockReason: null,
    aboveLow: true,
    after: ['claim'],
    pinned: null,
    span: { phase: 'spec', round: false },
    hasSubSteps: false,
  },
  spec2: {
    id: 'spec2',
    label: 'Second spec (independent)',
    what: 'A second spec agent writes its own spec from the ticket alone, never shown the first one. The ticket agent reconciles the two into the spec the builder gets, so a reading one spec missed is caught before anything is built.',
    handoff:
      "Brief it with the ticket's context only, never the first spec. Merge the two into one spec: the union of the criteria, the stricter reading where they differ; where the readings lead to different products, put both on a decision card.",
    agent: 'spec',
    lock: null,
    lockReason: null,
    aboveLow: true,
    after: ['claim'],
    pinned: null,
    span: { phase: 'spec', round: false },
    hasSubSteps: false,
  },
  build: {
    id: 'build',
    label: 'Build',
    what: "The builder writes the change in the ticket's worktree on its branch, with a check for every criterion that runs the real code, and commits it. It never pushes. Where the workflow has no spec step for the ticket, it works from the ticket's own instructions and verifies itself.",
    handoff:
      'The commits, what changed per criterion and the checks run go to the gate. The builder\'s "done" is a claim: re-run the checks and read the diff yourself.',
    agent: 'builder',
    lock: 'always',
    lockReason: 'Locked: nothing is delivered without the change being built.',
    aboveLow: false,
    after: ['claim', 'spec', 'spec2'],
    pinned: null,
    span: { phase: 'build', round: false },
    hasSubSteps: false,
  },
  tests: {
    id: 'tests',
    label: 'Test-writing pass',
    what: 'A dedicated pass by the builder that writes only tests: one that runs the real code for every criterion and every edge the spec lists, and a report of what each covers. It changes no product code.',
    handoff:
      'The new tests and their commits go to the gate with the build. A test that passes because it mocks the thing it checks goes back to the builder.',
    agent: 'builder',
    lock: null,
    lockReason: null,
    aboveLow: true,
    after: ['build'],
    pinned: null,
    span: { phase: 'build', round: false },
    hasSubSteps: false,
  },
  gate: {
    id: 'gate',
    label: 'Gate',
    what: "The ticket agent's own check before every review: the project's checks scoped to what changed, the whole diff read, and the added lines searched for what breaks the proof contract (skipped tests, lint or type ignores, branches on the test environment, mocks of the module under change).",
    handoff:
      'A pass goes on with the head SHA and a note of what ran. A failure goes back to the builder with its output and uses up no review round; the second return asks the human.',
    agent: 'you',
    lock: 'always',
    lockReason: 'Locked: no change moves on unchecked.',
    aboveLow: false,
    after: ['build', 'tests'],
    pinned: null,
    span: { phase: 'verify', round: false },
    hasSubSteps: false,
  },
  review: {
    id: 'review',
    label: 'Review',
    what: "Review rounds: /feature-review tries to break the branch in a worktree of its own and posts what each phase found. A round that does not survive goes back to the builder, then the gate, then the next round, until the change survives or the rounds for the ticket's complexity are used up.",
    handoff:
      "Each round's verdict, confirmed and plausible findings and failed criteria go to the builder as a fix pass. A surviving round ends the cycle and the verdict goes into the summary.",
    agent: 'runner',
    lock: null,
    lockReason: null,
    aboveLow: false,
    after: ['gate'],
    pinned: null,
    span: { phase: 'review', round: true },
    hasSubSteps: true,
  },
  preview: {
    id: 'preview',
    label: 'Preview',
    what: "Starts the ticket's preview of the head (the board's own preview run, or a hand start where the project has none) and takes screenshots of the finished thing at the state the ticket is about. It keeps running while the ticket is in review.",
    handoff:
      'The preview link and its screenshots go to the intent check and into the summary. A change with nothing to try has no preview, and the summary says why.',
    agent: 'you',
    lock: null,
    lockReason: null,
    aboveLow: false,
    after: ['gate'],
    pinned: null,
    span: { phase: 'preview', round: false },
    hasSubSteps: false,
  },
  intent: {
    id: 'intent',
    label: 'Intent check',
    what: 'The intent agent compares what the human asked, in their own words and attachments, with what was built (the preview, its screenshots and the diff), and says for each thing asked whether it was done as asked, done differently or not done.',
    handoff:
      'Brief it with only the human\'s words and the result, never the plan, the spec or the findings. "matches" goes on to the push; "does not match" goes back to the builder, the gate and one more review, outside the round budget; a second one asks the human.',
    agent: 'intent',
    lock: 'above-low',
    lockReason:
      "Locked above low: every ticket above low is checked against the human's own words before it is handed off.",
    aboveLow: false,
    after: ['build', 'review', 'preview'],
    pinned: null,
    span: null,
    hasSubSteps: false,
  },
  push: {
    id: 'push',
    label: 'Push',
    what: "Pushes the ticket's branch to origin once the intent check (when the ticket has one) matched on this head, and reads the ticket back to see the push registered.",
    handoff: 'The pushed head goes to the PR. A git lock is retried, never a failure.',
    agent: 'you',
    lock: 'always',
    lockReason: ALWAYS,
    aboveLow: false,
    after: ['intent', 'gate'],
    pinned: null,
    span: null,
    hasSubSteps: false,
  },
  pr: {
    id: 'pr',
    label: 'Pull request',
    what: "Opens the PR the project's way, titled and described in the repo's own terms, and records its number on the ticket.",
    handoff: 'The PR number goes to the CI wait and into the summary.',
    agent: 'you',
    lock: 'always',
    lockReason: ALWAYS,
    aboveLow: false,
    after: ['push'],
    pinned: null,
    span: { phase: 'pr', round: false },
    hasSubSteps: false,
  },
  ci: {
    id: 'ci',
    label: 'CI',
    what: "Waits for the PR's CI on the final head to pass the full suites; where CI does not run, runs the full suites locally once at the final head.",
    handoff:
      'Green CI on the final head ends the step. A failure goes back to the builder like a gate failure; a new commit changes the head, so the intent check runs again on it.',
    agent: 'you',
    lock: null,
    lockReason: null,
    aboveLow: false,
    after: ['pr'],
    pinned: null,
    span: { phase: 'pr', round: false },
    hasSubSteps: false,
  },
  summary: {
    id: 'summary',
    label: 'Summary',
    what: "Writes the ticket's summary, the one post the human reads on top of Main: what the change does and its state, each round's verdict, the PR and preview links, what to try, how it was tested and the intent check's verdict, with the screenshots. Then answers each of the human's posts it had answered with a plan.",
    handoff:
      'The summary goes to the hand-off; it is rewritten to the state at the last commit whenever the head changes.',
    agent: 'you',
    lock: 'always',
    lockReason: ALWAYS,
    aboveLow: false,
    after: ['intent', 'pr'],
    pinned: null,
    span: null,
    hasSubSteps: false,
  },
  handoff: {
    id: 'handoff',
    label: 'Hand-off',
    what: "Moves the ticket to review and reads the board's answer: the tasks still open, the subagent runs recorded without a report and the review phases the last round lacks. Each is fixed before the hand-off stands.",
    handoff:
      'The ticket stays in review with its preview running; the result goes back to whoever started this run.',
    agent: 'you',
    lock: 'always',
    lockReason: ALWAYS,
    aboveLow: false,
    after: [],
    pinned: 'last',
    span: null,
    hasSubSteps: false,
  },
}

// --- the presets ---

/** One phase (or a group of phases) inside a review round, shown under the review step. Read-only. */
export interface ReviewSubStepDef {
  /** `review.<name>`; a nested one `review.<group>.<name>`. */
  id: string
  label: string
  what: string
  agent: WorkflowAgent
  /** The kind of run it is, for the phases the board counts; null for the groups and the ticket agent's own. */
  phase: ReviewPhaseKind | null
  /** Sub-steps sharing a group name run in parallel with each other. */
  parallel: string | null
  children: ReviewSubStepDef[]
}

/** One run of `/feature-review` a round makes: its phases as the `phases=` argument names them. */
export interface ReviewRunDef {
  id: string
  label: string
  /**
   * The phase tokens of `phases=`: the six kinds (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`), `hunt`
   * repeated for each independent hunt, `hunt-security` for a hunt with the security checklist and
   * `reviewer` for the single reviewer of a light review.
   */
  phases: string[]
  /** A second review is a separate runner under its own agent name, never shown the first one's findings. */
  agentSuffix: string | null
}

export interface ReviewPlanDef {
  /** The phases of one round, in order. */
  phases: ReviewSubStepDef[]
  /** What happens between two rounds: the fix pass and the gate. */
  between: ReviewSubStepDef[]
  /** When a round survives, in a sentence. */
  survival: string
  runs: ReviewRunDef[]
}

export interface WorkflowPresetDef {
  id: WorkflowPresetId
  label: string
  description: string
  /** The default order. */
  steps: readonly WorkflowStepId[]
  /** The review rounds per complexity: the budget of the review step. */
  rounds: Readonly<Record<Complexity, number>>
  /** The effort a step has before the human sets one; absent is `auto`. Only agent-run steps have one. */
  effort: Readonly<Partial<Record<WorkflowStepId, WorkflowEffort>>>
  review: ReviewPlanDef
  /** The preset's own words for a step, where they differ from the catalogue's. */
  text: Readonly<Partial<Record<WorkflowStepId, { what?: string; handoff?: string }>>>
}

const sub = (
  id: string,
  label: string,
  agent: WorkflowAgent,
  what: string,
  extra: { phase?: ReviewPhaseKind | null; parallel?: string; children?: ReviewSubStepDef[] } = {},
): ReviewSubStepDef => ({
  id,
  label,
  what,
  agent,
  phase: extra.phase === undefined ? null : extra.phase,
  parallel: extra.parallel ?? null,
  children: extra.children ?? [],
})

const FIX = sub(
  'review.fix',
  'Fix pass',
  'builder',
  'A round that did not survive goes to the builder with its findings and failed criteria, each with its scenario; the builder fixes only those.',
)
const BETWEEN_GATE = sub(
  'review.gate',
  'Gate',
  'you',
  'The ticket agent runs its own gate on the fix pass before the next round starts.',
)

/** The standard phases of one review round; `prefix` namespaces them inside a second full review. */
function standardPhases(prefix: string, extraHunts: boolean): ReviewSubStepDef[] {
  const id = (name: string) => `${prefix}.${name}`
  return [
    sub(
      id('spec'),
      'Spec',
      'spec',
      'Restates the intent of the change as a testable spec: acceptance criteria, classification and surfaces.',
      {
        phase: 'spec',
      },
    ),
    sub(
      id('env'),
      'Environment',
      'env',
      "Provisions an isolated runtime from the review's own worktree and proves the running code is the commit under review.",
      {
        phase: 'env',
      },
    ),
    sub(
      id('verify'),
      'Verify',
      'verify',
      'Executes each acceptance criterion (tests, HTTP, browser) and records PASS, FAIL or UNVERIFIED with the evidence.',
      {
        phase: 'verify',
        parallel: 'checks',
      },
    ),
    sub(
      id('hunt-a'),
      'Hunt A',
      'hunt',
      'Applies the change-type checklists to the change and reports candidate findings, each with a concrete failure scenario.',
      {
        phase: 'hunt',
        parallel: 'checks',
      },
    ),
    sub(
      id('hunt-b'),
      'Hunt B',
      'hunt',
      "A second hunt, independent of the first: it never sees hunt A's findings, so a finding both reach is more certain.",
      {
        phase: 'hunt',
        parallel: 'checks',
      },
    ),
    ...(extraHunts
      ? [
          sub(
            id('hunt-security'),
            'Security hunt',
            'hunt',
            'A third hunt with the security checklist alone: authentication, authorisation, injection, secrets, unsafe input and data exposure.',
            {
              phase: 'hunt',
              parallel: 'checks',
            },
          ),
        ]
      : []),
    sub(
      id('refute'),
      'Refute',
      'refute',
      'Tries to disprove each candidate finding, reproduces the survivors and issues CONFIRMED, PLAUSIBLE or REFUTED.',
      {
        phase: 'refute',
      },
    ),
    sub(
      id('merge'),
      'Merge check',
      'merge',
      'Merges the latest base into a scratch copy and runs the scoped checks on it, so a conflict or a new failure shows before the PR.',
      {
        phase: 'merge',
      },
    ),
  ]
}

const INTENT_EACH_ROUND = sub(
  'review.intent',
  'Intent check',
  'intent',
  "The intent agent compares the human's own words with the result at the end of every round, so a round that drifts from what was asked is caught while the builder still has rounds left.",
  { phase: null },
)

/** The intent step's hand-off in the presets whose reviews check intent at the end of every round: there a `does not match` is an ordinary round of the budget. */
const INTENT_COUNTS_AS_ROUND =
  'Brief it with only the human\'s words and the result, never the plan, the spec or the findings. "matches" goes on to the push; "does not match" goes back to the builder, the gate and the next review round, an ordinary round of the budget in this workflow; a second one asks the human.'

const STANDARD_SURVIVAL =
  'the verdict is SHIP, the works check is YES, the base check is NO and every acceptance criterion is PASS by execution (UNVERIFIED only for a reason the escalation rules name that could not be got past)'

const standardTokens = ['spec', 'env', 'verify', 'hunt', 'hunt', 'refute', 'merge']
const thoroughTokens = ['spec', 'env', 'verify', 'hunt', 'hunt', 'hunt-security', 'refute', 'merge']

const STANDARD_STEPS: WorkflowStepId[] = [
  'claim',
  'spec',
  'build',
  'gate',
  'review',
  'preview',
  'intent',
  'push',
  'pr',
  'ci',
  'summary',
  'handoff',
]

export const WORKFLOW_PRESET_DEFS: Readonly<Record<WorkflowPresetId, WorkflowPresetDef>> = {
  light: {
    id: 'light',
    label: 'Light',
    description:
      'Build, gate, one reviewer, the intent check and the hand-off: no spec agent, no environment, no separate hunts.',
    steps: STANDARD_STEPS.filter((id) => id !== 'spec'),
    rounds: { low: 0, mid: 1, high: 2, max: 3 },
    effort: { intent: 'low' },
    review: {
      phases: [
        sub(
          'review.reviewer',
          'Reviewer',
          'hunt',
          "One reviewer reads the diff against the ticket's instructions and the gate's results and reports what it can reproduce, in the hunt's finding format. There is no spec, environment, verify, refute or merge phase.",
          { phase: 'hunt' },
        ),
      ],
      between: [FIX, BETWEEN_GATE],
      survival:
        "the reviewer reproduced no finding and the builder's evidence covers every acceptance criterion",
      runs: [{ id: 'review', label: 'Review', phases: ['reviewer'], agentSuffix: null }],
    },
    text: {
      review: {
        what: "One reviewer tries to break the branch: it reads the diff against the ticket's instructions and the gate's results and reports what it can reproduce. A round that does not survive goes back to the builder, then the gate, then the next round, until the change survives or the rounds for the ticket's complexity are used up.",
        handoff:
          "The reviewer's findings, each with its scenario, go to the builder as a fix pass. A surviving round ends the cycle and the reviewer's verdict goes into the summary.",
      },
    },
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    description:
      'The full cycle: spec, build, gate, review rounds with spec, environment, verify, two independent hunts, refute and a merge check, then the intent check, PR, CI, preview and hand-off.',
    steps: STANDARD_STEPS,
    rounds: { low: 0, mid: 1, high: 3, max: 10 },
    effort: { intent: 'low' },
    review: {
      phases: standardPhases('review', false),
      between: [FIX, BETWEEN_GATE],
      survival: STANDARD_SURVIVAL,
      runs: [{ id: 'review', label: 'Review', phases: standardTokens, agentSuffix: null }],
    },
    text: {},
  },
  thorough: {
    id: 'thorough',
    label: 'Thorough',
    description:
      'Standard plus a dedicated test-writing pass, a third hunt with the security checklist, the intent check at the end of every review round, and one more review round at every level above low.',
    steps: [
      'claim',
      'spec',
      'build',
      'tests',
      'gate',
      'review',
      'preview',
      'intent',
      'push',
      'pr',
      'ci',
      'summary',
      'handoff',
    ],
    rounds: { low: 0, mid: 2, high: 4, max: 11 },
    effort: { intent: 'low' },
    review: {
      phases: [...standardPhases('review', true), INTENT_EACH_ROUND],
      between: [FIX, BETWEEN_GATE],
      survival: `${STANDARD_SURVIVAL}, and the intent check at the end of the round matches`,
      runs: [{ id: 'review', label: 'Review', phases: thoroughTokens, agentSuffix: null }],
    },
    text: { intent: { handoff: INTENT_COUNTS_AS_ROUND } },
  },
  maximum: {
    id: 'maximum',
    label: 'Maximum',
    description:
      'Thorough plus a second, independent spec, a second full review of every round by a different agent that never sees the first, and high effort on every agent.',
    steps: [
      'claim',
      'spec',
      'spec2',
      'build',
      'tests',
      'gate',
      'review',
      'preview',
      'intent',
      'push',
      'pr',
      'ci',
      'summary',
      'handoff',
    ],
    rounds: { low: 0, mid: 3, high: 5, max: 12 },
    effort: {
      spec: 'high',
      spec2: 'high',
      build: 'high',
      tests: 'high',
      review: 'high',
      intent: 'low',
    },
    review: {
      phases: [
        sub(
          'review.first',
          'First review',
          'runner',
          'A full review of the round: every phase the Thorough review runs.',
          { children: standardPhases('review.first', true) },
        ),
        sub(
          'review.second',
          'Second review (different agent)',
          'runner',
          "A second full review of the same round by a separate runner under its own agent name. It never sees the first review's findings, so what both find is certain and what only one finds is not lost.",
          { children: standardPhases('review.second', true) },
        ),
        sub(
          'review.reconcile',
          'Reconcile',
          'you',
          'The ticket agent merges both reviews before deciding the round: a finding either review confirmed goes to the builder; a verdict that differs is read, never averaged.',
        ),
        INTENT_EACH_ROUND,
      ],
      between: [FIX, BETWEEN_GATE],
      survival: `both reviews survive (${STANDARD_SURVIVAL}), the reconciliation leaves no finding open and the intent check at the end of the round matches`,
      runs: [
        { id: 'review.first', label: 'First review', phases: thoroughTokens, agentSuffix: 'first' },
        { id: 'review.second', label: 'Second review', phases: thoroughTokens, agentSuffix: 'second' },
      ],
    },
    text: {
      intent: { handoff: INTENT_COUNTS_AS_ROUND },
      review: {
        what: "Two full reviews of every round: /feature-review runs twice as separate runners under their own agent names, the second never shown the first one's findings, and the ticket agent reconciles both before deciding the round. A round that does not survive goes back to the builder, then the gate, then the next round, until the change survives or the rounds for the ticket's complexity are used up.",
        handoff:
          "Both reviews' verdicts and the reconciled findings, each with its scenario, go to the builder as a fix pass. A surviving round ends the cycle and both verdicts go into the summary.",
      },
    },
  },
}

/** The presets in the order they are offered, lightest to heaviest. */
export const WORKFLOW_PRESET_LIST: readonly WorkflowPresetDef[] = WORKFLOW_PRESETS.map(
  (id) => WORKFLOW_PRESET_DEFS[id],
)

/** The preset of an id; anything stored that is not one (a catalogue that changed) reads as Standard. */
export const workflowPreset = (id: unknown): WorkflowPresetDef =>
  isWorkflowPreset(id) ? WORKFLOW_PRESET_DEFS[id] : WORKFLOW_PRESET_DEFS[DEFAULT_WORKFLOW_PRESET]

// --- tweaks ---

/** What the human sets on one step; every field is optional and left out when it is the default. */
export interface StepTweak {
  /** false turns the step off; a locked step cannot be turned off (the intent check only for a low ticket). */
  enabled?: boolean
  effort?: WorkflowEffort
  /** Replaces the step's hand-off instruction (at most INSTRUCTIONS_MAX characters). */
  instructions?: string
}

/**
 * What the human changed in one preset: the order of its steps, each step's switch, effort and hand-off
 * instruction, and the review rounds per complexity. Agent, model, sub-steps and procedure stay with the
 * preset.
 */
export interface PresetTweak {
  order?: WorkflowStepId[]
  steps?: Partial<Record<WorkflowStepId, StepTweak>>
  rounds?: Partial<Record<Complexity, number>>
}

/** A project's saved tweaks: one per preset it changed. */
export type ProjectTweaks = Partial<Record<WorkflowPresetId, PresetTweak>>

/** The preset's own default effort for a step with an agent (`auto` when it names none), null with no agent. */
export function defaultEffort(preset: WorkflowPresetId, id: WorkflowStepId): WorkflowEffort | null {
  if (WORKFLOW_STEPS[id].agent === 'you') return null
  return WORKFLOW_PRESET_DEFS[preset].effort[id] ?? 'auto'
}

/** The hand-off instruction a step has before the human edits it: the preset's wording, else the catalogue's. */
export const defaultHandoff = (preset: WorkflowPresetId, id: WorkflowStepId) =>
  WORKFLOW_PRESET_DEFS[preset].text[id]?.handoff ?? WORKFLOW_STEPS[id].handoff

/** The text of what a step does for the preset: its own wording, else the catalogue's. */
export const stepWhat = (preset: WorkflowPresetId, id: WorkflowStepId) =>
  WORKFLOW_PRESET_DEFS[preset].text[id]?.what ?? WORKFLOW_STEPS[id].what

/** An effort as the agent runs it: `auto` follows the ticket's complexity; with none given, null. */
export function effortLevel(effort: WorkflowEffort, complexity: Complexity | null): EffortLevel | null {
  if (effort !== 'auto') return effort
  return complexity ? COMPLEXITY_EFFORT[complexity] : null
}

/** What the order of a preset breaks, in words naming the pair, or null when it holds. */
export function orderProblem(preset: WorkflowPresetId, order: readonly string[]): string | null {
  const def = WORKFLOW_PRESET_DEFS[preset]
  const own = new Set<string>(def.steps)
  const seen = new Set<string>()
  for (const id of order) {
    if (!isWorkflowStep(id)) return `order: unknown step "${id}"`
    if (!own.has(id)) return `order: "${id}" is not a step of the ${def.label} workflow`
    if (seen.has(id)) return `order: "${id}" is listed twice`
    seen.add(id)
  }
  const missing = def.steps.filter((id) => !seen.has(id))
  if (missing.length)
    return `order: it must list every step of the ${def.label} workflow once (missing: ${missing.join(', ')})`
  if (order[0] !== 'claim') return 'claim must stay first'
  if (order.at(-1) !== 'handoff') return 'handoff must stay last'
  for (const id of def.steps) {
    for (const dep of WORKFLOW_STEPS[id].after) {
      if (!own.has(dep)) continue
      if (order.indexOf(dep) > order.indexOf(id)) return `${id} must come after ${dep}`
    }
  }
  return null
}

/**
 * The order with one step moved a place up or down, or why it cannot be: the move swaps neighbours, and
 * a swap that breaks `orderProblem` is refused with its words. A step already at an end cannot go past it.
 */
export function moveStep(
  preset: WorkflowPresetId,
  order: readonly WorkflowStepId[],
  id: WorkflowStepId,
  direction: 'up' | 'down',
): { ok: true; order: WorkflowStepId[] } | { ok: false; reason: string } {
  const at = order.indexOf(id)
  const to = direction === 'up' ? at - 1 : at + 1
  if (at < 0) return { ok: false, reason: `${id} is not a step of this workflow` }
  if (to < 0) return { ok: false, reason: `${id} is already first` }
  if (to >= order.length) return { ok: false, reason: `${id} is already last` }
  const next = [...order]
  ;[next[at], next[to]] = [next[to]!, next[at]!]
  const problem = orderProblem(preset, next)
  return problem ? { ok: false, reason: problem } : { ok: true, order: next }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stepWord = (id: string, preset: WorkflowPresetDef) =>
  `${id} is not a step of the ${preset.label} workflow`

/**
 * Checks a tweak a human sends for one preset, and answers it typed or with every problem found, the
 * first one first. Nothing is dropped or fixed silently: an unknown key, an unknown step or one the
 * preset does not have, a locked step turned off, an effort on a step that runs no agent, an effort or a
 * round count out of range, an instruction past INSTRUCTIONS_MAX, an order that breaks a dependency.
 * Run `normalizeTweaks` on the result before saving it.
 */
export function validateTweaks(
  presetId: WorkflowPresetId,
  input: unknown,
): { ok: true; tweak: PresetTweak } | { ok: false; error: string; errors: string[] } {
  const preset = WORKFLOW_PRESET_DEFS[presetId]
  const errors: string[] = []
  const tweak: PresetTweak = {}
  if (!isRecord(input))
    return { ok: false, error: 'tweaks must be an object', errors: ['tweaks must be an object'] }
  for (const key of Object.keys(input))
    if (!['order', 'steps', 'rounds'].includes(key))
      errors.push(`unknown key "${key}": a tweak has order, steps and rounds`)

  if (input.order !== undefined) {
    if (!Array.isArray(input.order) || input.order.some((x) => typeof x !== 'string'))
      errors.push('order: a list of step ids')
    else {
      const problem = orderProblem(presetId, input.order as string[])
      if (problem) errors.push(problem)
      else tweak.order = input.order as WorkflowStepId[]
    }
  }

  if (input.steps !== undefined) {
    if (!isRecord(input.steps)) errors.push('steps: an object keyed by step id')
    else {
      const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
      for (const [id, value] of Object.entries(input.steps)) {
        if (!isWorkflowStep(id)) {
          errors.push(`steps: unknown step "${id}"`)
          continue
        }
        if (!preset.steps.includes(id)) {
          errors.push(`steps: ${stepWord(id, preset)}`)
          continue
        }
        if (!isRecord(value)) {
          errors.push(`steps.${id}: an object with enabled, effort and instructions`)
          continue
        }
        const own: StepTweak = {}
        for (const key of Object.keys(value))
          if (!['enabled', 'effort', 'instructions'].includes(key))
            errors.push(`steps.${id}: unknown key "${key}" (enabled, effort and instructions)`)
        if (value.enabled !== undefined) {
          if (typeof value.enabled !== 'boolean') errors.push(`steps.${id}.enabled: true or false`)
          else if (!value.enabled && WORKFLOW_STEPS[id].lock === 'always')
            errors.push(`${id} is locked: it cannot be turned off`)
          else own.enabled = value.enabled
        }
        if (value.effort !== undefined) {
          if (
            typeof value.effort !== 'string' ||
            !(WORKFLOW_EFFORTS as readonly string[]).includes(value.effort)
          )
            errors.push(`steps.${id}.effort: one of ${WORKFLOW_EFFORTS.join(', ')}`)
          else if (WORKFLOW_STEPS[id].agent === 'you')
            errors.push(`steps.${id}.effort: ${id} runs no agent of its own, so it has no effort`)
          else own.effort = value.effort as WorkflowEffort
        }
        if (value.instructions !== undefined) {
          if (typeof value.instructions !== 'string') errors.push(`steps.${id}.instructions: text`)
          else if (value.instructions.trim().length > INSTRUCTIONS_MAX)
            errors.push(`steps.${id}.instructions: at most ${INSTRUCTIONS_MAX} characters`)
          else own.instructions = value.instructions.trim()
        }
        steps[id] = own
      }
      tweak.steps = steps
    }
  }

  if (input.rounds !== undefined) {
    if (!isRecord(input.rounds)) errors.push('rounds: an object keyed by complexity (low, mid, high, max)')
    else {
      const rounds: Partial<Record<Complexity, number>> = {}
      for (const [level, n] of Object.entries(input.rounds)) {
        if (!(COMPLEXITIES as readonly string[]).includes(level))
          errors.push(`rounds: unknown complexity "${level}" (low, mid, high, max)`)
        else if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > ROUNDS_MAX)
          errors.push(`rounds.${level}: a whole number from 0 to ${ROUNDS_MAX}`)
        else rounds[level as Complexity] = n
      }
      tweak.rounds = rounds
    }
  }

  return errors.length ? { ok: false, error: errors[0]!, errors } : { ok: true, tweak }
}

/**
 * A tweak reduced to what differs from the preset: values equal to the default (the default order, an
 * enabled step, the preset's effort, the default instruction, the preset's rounds) are dropped, and
 * a tweak with nothing left is null. Expects a tweak `validateTweaks` accepted.
 */
export function normalizeTweaks(
  presetId: WorkflowPresetId,
  tweak: PresetTweak | null | undefined,
): PresetTweak | null {
  if (!tweak) return null
  const preset = WORKFLOW_PRESET_DEFS[presetId]
  const out: PresetTweak = {}
  if (tweak.order && tweak.order.some((id, i) => id !== preset.steps[i])) out.order = [...tweak.order]
  const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
  for (const [id, own] of Object.entries(tweak.steps ?? {}) as [WorkflowStepId, StepTweak][]) {
    const kept: StepTweak = {}
    if (own.enabled === false) kept.enabled = false
    if (own.effort !== undefined && own.effort !== defaultEffort(presetId, id)) kept.effort = own.effort
    const text = own.instructions?.trim()
    if (text && text !== defaultHandoff(presetId, id)) kept.instructions = text
    if (Object.keys(kept).length) steps[id] = kept
  }
  if (Object.keys(steps).length) out.steps = steps
  const rounds: Partial<Record<Complexity, number>> = {}
  for (const level of COMPLEXITIES) {
    const n = tweak.rounds?.[level]
    if (n !== undefined && n !== preset.rounds[level]) rounds[level] = n
  }
  if (Object.keys(rounds).length) out.rounds = rounds
  return Object.keys(out).length ? out : null
}

/**
 * What a saved tweak still means to the catalogue: unknown steps and values that no longer pass are
 * dropped, an order that no longer holds is dropped (the default order stands), and a locked step's off
 * switch is ignored. Stored data outlives the catalogue, so reading it never throws.
 */
function readSaved(presetId: WorkflowPresetId, saved: unknown): PresetTweak | null {
  if (!isRecord(saved)) return null
  const preset = WORKFLOW_PRESET_DEFS[presetId]
  const tweak: PresetTweak = {}
  if (Array.isArray(saved.order)) {
    const known = saved.order.filter(
      (id): id is WorkflowStepId => isWorkflowStep(id) && preset.steps.includes(id),
    )
    if (!orderProblem(presetId, known)) tweak.order = known
  }
  if (isRecord(saved.steps)) {
    const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
    for (const [id, value] of Object.entries(saved.steps)) {
      if (!isWorkflowStep(id) || !preset.steps.includes(id) || !isRecord(value)) continue
      const own: StepTweak = {}
      if (value.enabled === false && WORKFLOW_STEPS[id].lock !== 'always') own.enabled = false
      if (
        typeof value.effort === 'string' &&
        (WORKFLOW_EFFORTS as readonly string[]).includes(value.effort) &&
        WORKFLOW_STEPS[id].agent !== 'you'
      )
        own.effort = value.effort as WorkflowEffort
      if (typeof value.instructions === 'string' && value.instructions.trim())
        own.instructions = value.instructions.trim().slice(0, INSTRUCTIONS_MAX)
      steps[id] = own
    }
    tweak.steps = steps
  }
  if (isRecord(saved.rounds)) {
    const rounds: Partial<Record<Complexity, number>> = {}
    for (const level of COMPLEXITIES) {
      const n = saved.rounds[level]
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ROUNDS_MAX) rounds[level] = n
    }
    tweak.rounds = rounds
  }
  return normalizeTweaks(presetId, tweak)
}

/** The tweaks of a project as stored: what is not a known preset's tweak is dropped, each one cleaned. */
export function readProjectTweaks(saved: unknown): ProjectTweaks {
  const out: ProjectTweaks = {}
  if (!isRecord(saved)) return out
  for (const id of WORKFLOW_PRESETS) {
    const tweak = readSaved(id, saved[id])
    if (tweak) out[id] = tweak
  }
  return out
}

// --- resolving ---

/** Why a step is not run for this ticket. */
export type SkipReason = 'low' | 'off' | 'rounds'

export interface ResolvedSubStep {
  id: string
  label: string
  what: string
  agent: WorkflowAgent
  agentLabel: string
  phase: ReviewPhaseKind | null
  parallel: string | null
  /** `5.3`: the parent's number and its place among its siblings; null when the parent is not numbered. */
  number: string | null
  children: ResolvedSubStep[]
}

export interface ResolvedReview {
  /** The rounds for the ticket's complexity, null when no complexity is given. */
  rounds: number | null
  roundsByComplexity: Record<Complexity, number>
  defaultRounds: Record<Complexity, number>
  survival: string
  /** The phases of one round, then what happens between two rounds. */
  phases: ResolvedSubStep[]
  between: ResolvedSubStep[]
  /** The `/feature-review` runs one round makes, each with its `phases=` argument. */
  runs: (ReviewRunDef & { phasesArg: string })[]
  /** The kind of run each round needs and how many of each: what the hand-off checks. */
  perRound: { phase: ReviewPhaseKind; expected: number }[]
}

export interface ResolvedStep {
  id: WorkflowStepId
  label: string
  what: string
  agent: WorkflowAgent
  /** `you`, `spec`, `/feature-review`: how the tree and the served text name who runs it. */
  agentLabel: string
  /** The hand-off instruction in force: the human's when they set one, else the default. */
  handoff: string
  handoffDefault: string
  lock: WorkflowLock | null
  lockReason: string | null
  /** Its place in the order, from 0, skipped steps included. */
  position: number
  /** 1-based among the steps this ticket runs; null when it is skipped. */
  number: number | null
  /** The step's switch as saved (a locked step is always on). */
  enabled: boolean
  /** Null when the step runs for this ticket. */
  skipped: { reason: SkipReason; note: string } | null
  /** The step does not run for a low ticket (so the page can say so when no complexity is picked). */
  skipsOnLow: boolean
  /** Null when the step runs no agent of its own. */
  effort: WorkflowEffort | null
  effortDefault: WorkflowEffort | null
  /** The level an agent runs at: `auto` resolved by complexity; null without an agent or a complexity. */
  effortLevel: EffortLevel | null
  /** Null on every step but the review. */
  review: ResolvedReview | null
  /** The step's `start_span` phase, and whether it carries the review round. */
  span: { phase: string; round: boolean } | null
  /** What the human changed on it. */
  edited: { enabled: boolean; effort: boolean; instructions: boolean; moved: boolean; any: boolean }
  /** Why a move is refused (words naming the pair), null when it is allowed. */
  moveBlocked: { up: string | null; down: string | null }
}

export interface ResolvedWorkflow {
  preset: WorkflowPresetId
  label: string
  description: string
  /** The ticket's complexity this was resolved for; null for the preset as such. */
  complexity: Complexity | null
  /** The saved tweak in force, as it is stored (normalized); null when the preset is as shipped. */
  tweak: PresetTweak | null
  tweaked: boolean
  /** The order in force, and the preset's own. */
  order: WorkflowStepId[]
  defaultOrder: WorkflowStepId[]
  /** Every step in order, the skipped ones included (they carry `skipped` and no number). */
  steps: ResolvedStep[]
  /** How many steps run for this ticket. */
  numbered: number
  /** The review's rounds per complexity, and the preset's own. */
  rounds: Record<Complexity, number>
  defaultRounds: Record<Complexity, number>
}

function resolveSub(def: ReviewSubStepDef, parent: string | null, at: number): ResolvedSubStep {
  const number = parent === null ? null : `${parent}.${at + 1}`
  return {
    id: def.id,
    label: def.label,
    what: def.what,
    agent: def.agent,
    agentLabel: AGENT_LABELS[def.agent],
    phase: def.phase,
    parallel: def.parallel,
    number,
    children: def.children.map((child, i) => resolveSub(child, number, i)),
  }
}

/** The phase kinds of a plan's sub-steps, in the order the board's checks list them. */
function phaseCounts(defs: readonly ReviewSubStepDef[]): Map<ReviewPhaseKind, number> {
  const counts = new Map<ReviewPhaseKind, number>()
  const walk = (list: readonly ReviewSubStepDef[]) => {
    for (const d of list) {
      if (d.phase) counts.set(d.phase, (counts.get(d.phase) ?? 0) + 1)
      walk(d.children)
    }
  }
  walk(defs)
  return counts
}

function resolveReview(
  preset: WorkflowPresetDef,
  number: number | null,
  rounds: Record<Complexity, number>,
  complexity: Complexity | null,
): ResolvedReview {
  const at = number === null ? null : String(number)
  const counts = phaseCounts(preset.review.phases)
  return {
    rounds: complexity ? rounds[complexity] : null,
    roundsByComplexity: rounds,
    defaultRounds: { ...preset.rounds },
    survival: preset.review.survival,
    phases: preset.review.phases.map((d, i) => resolveSub(d, at, i)),
    between: preset.review.between.map((d) => resolveSub(d, null, 0)),
    runs: preset.review.runs.map((r) => ({ ...r, phasesArg: r.phases.join(',') })),
    perRound: REVIEW_PHASE_KINDS.flatMap((phase) => {
      const expected = counts.get(phase)
      return expected ? [{ phase, expected }] : []
    }),
  }
}

/**
 * A preset and its saved tweaks as the tree a ticket of `complexity` goes through: every step in order
 * with its number (skipped ones with the reason and no number), agent, effort, hand-off text, lock,
 * what the human edited and where it can move; the review with its rounds, its phases per round, what
 * happens between rounds and the `/feature-review` runs a round makes. With no complexity nothing is
 * skipped for being low (steps that skip a low ticket say so in `skipsOnLow`) and the rounds are the table.
 *
 * `tweak` is the preset's own tweak as stored (`projectTweaks[preset]`); it is read leniently, never
 * thrown on: what the catalogue no longer has is ignored and a broken order falls back to the default.
 */
export function resolveWorkflow(
  presetId: WorkflowPresetId,
  tweak?: unknown,
  complexity: Complexity | null = null,
): ResolvedWorkflow {
  const preset = workflowPreset(presetId)
  const id = preset.id
  const saved = readSaved(id, tweak)
  const order = saved?.order ? [...saved.order] : [...preset.steps]
  const rounds = { ...preset.rounds, ...saved?.rounds }
  let counter = 0
  const steps: ResolvedStep[] = order.map((stepId, position) => {
    const def = WORKFLOW_STEPS[stepId]
    const own = saved?.steps?.[stepId]
    const enabled = def.lock === 'always' ? true : own?.enabled !== false
    const roundsHere = stepId === 'review' && complexity ? rounds[complexity] : null
    let skipped: ResolvedStep['skipped'] = null
    if (def.aboveLow && complexity === 'low') skipped = { reason: 'low', note: 'skipped: low ticket' }
    else if (!enabled && (def.lock !== 'above-low' || complexity === 'low'))
      skipped = {
        reason: 'off',
        note:
          def.lock === 'above-low'
            ? 'skipped: turned off for low tickets on the Workflow page'
            : 'skipped: turned off on the Workflow page',
      }
    else if (roundsHere === 0)
      skipped =
        complexity === 'low'
          ? { reason: 'low', note: 'skipped: low ticket (no review rounds)' }
          : { reason: 'rounds', note: `skipped: no review rounds for a ${complexity} ticket` }
    const number = skipped ? null : ++counter
    const effortDefaultValue = defaultEffort(id, stepId)
    const effort = effortDefaultValue === null ? null : (own?.effort ?? effortDefaultValue)
    const handoffDefault = defaultHandoff(id, stepId)
    const handoff = own?.instructions ?? handoffDefault
    const moved = order.indexOf(stepId) !== preset.steps.indexOf(stepId)
    const edited = {
      enabled: own?.enabled === false,
      effort: own?.effort !== undefined,
      instructions: own?.instructions !== undefined,
      moved,
      any: false,
    }
    edited.any = edited.enabled || edited.effort || edited.instructions || edited.moved
    const up = moveStep(id, order, stepId, 'up')
    const down = moveStep(id, order, stepId, 'down')
    return {
      id: stepId,
      label: def.label,
      what: stepWhat(id, stepId),
      agent: def.agent,
      agentLabel: AGENT_LABELS[def.agent],
      handoff,
      handoffDefault,
      lock: def.lock,
      lockReason: def.lockReason,
      position,
      number,
      enabled,
      skipped,
      skipsOnLow:
        def.aboveLow || (def.lock === 'above-low' && !enabled) || (stepId === 'review' && rounds.low === 0),
      effort,
      effortDefault: effortDefaultValue,
      effortLevel: effort === null ? null : effortLevel(effort, complexity),
      review: stepId === 'review' ? resolveReview(preset, number, rounds, complexity) : null,
      span: def.span,
      edited,
      moveBlocked: { up: up.ok ? null : up.reason, down: down.ok ? null : down.reason },
    }
  })
  const normalized = normalizeTweaks(id, saved)
  return {
    preset: id,
    label: preset.label,
    description: preset.description,
    complexity,
    tweak: normalized,
    tweaked: normalized !== null,
    order,
    defaultOrder: [...preset.steps],
    steps,
    numbered: counter,
    rounds,
    defaultRounds: { ...preset.rounds },
  }
}

/**
 * The runs of each kind one review round needs under this workflow, in the order the board's checks list
 * them (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`): Standard one each and two hunts, Light one
 * hunt, Thorough three hunts, Maximum twice Thorough's. Empty when the workflow has no review for the
 * ticket (low, a review switched off, no rounds).
 */
export function reviewPhaseRuns(workflow: ResolvedWorkflow): { phase: ReviewPhaseKind; expected: number }[] {
  const review = workflow.steps.find((s) => s.id === 'review')
  if (!review || review.skipped || !review.review) return []
  return review.review.perRound.map((p) => ({ ...p }))
}
