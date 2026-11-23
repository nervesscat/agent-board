import { COMPLEXITIES, COMPLEXITY_EFFORT, type Complexity } from './constants'

/**
 * The workflow module: the order in which a ticket's agent delegates the build-and-review cycle (read
 * and claim, spec, build, gate, review rounds, preview, intent check, push, PR, CI, summary, hand-off),
 * as data. The board serves a project's active workflow to its agents (`get_workflow`) and the Workflow
 * page draws it as a graph; neither hard-codes the order.
 *
 * Pure and shared by the client and the server: no database, no I/O. The long procedure of each step is
 * markdown the server serves (src/server/skill/workflow/<id>.md); this file holds what the page and the
 * served text both show: the catalogue (every step the cycle can have), the four presets (an ordered
 * list of those steps, the review rounds per complexity, an effort each), the tweaks a human saves on
 * top of a preset, and `resolveWorkflow`, which turns a preset and its tweaks into the resolved workflow.
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

/** A project's own workflow has an id of this shape: never one of the four presets' ids, never reused. */
export const CUSTOM_ID_PREFIX = 'custom-'
export const isCustomWorkflowId = (value: unknown): value is string =>
  typeof value === 'string' && /^custom-[a-z0-9]{6,32}$/.test(value)
/** The longest name a custom workflow has, after trimming. */
export const CUSTOM_NAME_MAX = 60

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

/** The most review rounds a human can set for one complexity; the presets' own never pass it. */
export const ROUNDS_MAX = 12

/**
 * Who runs a step: the ticket agent itself (`you`), or an agent it starts. These are roles, resolved
 * against the project's agents by name and delegation notes: `spec`, `builder`, `intent` and the review's
 * phase agents, and `runner`, the `/feature-review` run that starts those phase agents. The ticket agent
 * runs `runner` itself through the Skill tool, so no Team agent is named for it (its phases name theirs).
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
  /** One paragraph on what the step does: shown in the node's panel and at the head of the served step. */
  what: string
  /**
   * The hand-off: what the step receives and passes on, and what the ticket agent checks when it returns.
   * It is the preset's own wording; nothing on the Workflow page edits it.
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
  /** The step has sub-steps in the graph (the review's phases): they belong to the preset, see `review`. */
  hasSubSteps: boolean
}

const ALWAYS = 'Locked: the ticket cannot be handed off without it.'

/** What each agent-run step is called in the graph and the served text. */
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
  /**
   * When a round survives, in a sentence. `roundIntent` is whether the round-end intent check runs for the
   * ticket: when it does not (the check is turned off for a low ticket), the rule does not ask for it.
   */
  survival: (roundIntent: boolean) => string
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

const ROUND_INTENT_ID = 'review.intent'

const INTENT_EACH_ROUND = sub(
  ROUND_INTENT_ID,
  'Intent check',
  'intent',
  "The intent agent compares the human's own words with the result at the end of every round, so a round that drifts from what was asked is caught while the builder still has rounds left.",
  { phase: null },
)

/** The intent step's hand-off for a ticket with no review: a `does not match` has only the builder and the gate to go back to. */
const INTENT_WITHOUT_REVIEW =
  'Brief it with only the human\'s words and the result, never the plan, the spec or the findings. "matches" goes on to the push; "does not match" goes back to the builder and the gate, then the check again, outside the round budget; a second one asks the human.'

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
      survival: () =>
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
      survival: () => STANDARD_SURVIVAL,
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
      survival: (roundIntent) =>
        roundIntent
          ? `${STANDARD_SURVIVAL}, and the intent check at the end of the round matches`
          : STANDARD_SURVIVAL,
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
      survival: (roundIntent) =>
        roundIntent
          ? `both reviews survive (${STANDARD_SURVIVAL}), the reconciliation leaves no finding open and the intent check at the end of the round matches`
          : `both reviews survive (${STANDARD_SURVIVAL}) and the reconciliation leaves no finding open`,
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
}

/**
 * What the human changed in one preset: the order of its steps, each step's switch and effort, the Team
 * agent each node runs and the review rounds per complexity. Sub-steps and procedure stay with the preset,
 * and so does every text: instructions are written on the project's Team page, never here.
 */
export interface PresetTweak {
  order?: WorkflowStepId[]
  steps?: Partial<Record<WorkflowStepId, StepTweak>>
  /**
   * The Team agent a node runs, by name, keyed by node id: a step id (`build`) or a review phase's id
   * (`review.hunt-a`). Only nodes with an agent of their own have one (see `bindableNodes`).
   */
  agents?: Record<string, string>
  rounds?: Partial<Record<Complexity, number>>
}

/** A project's saved tweaks: one per preset it changed. */
export type ProjectTweaks = Partial<Record<WorkflowPresetId, PresetTweak>>

/**
 * A project's own workflow: a copy of a preset (or of another custom workflow) that is then changed on its
 * own. `base` is the built-in preset it descends from, which keeps supplying what a custom workflow cannot
 * edit: the review's phases and rounds table, the default effort of a step, the preset's wording and the
 * variants of the step procedures. `tweak.order` is always there: for a custom workflow it is the set of
 * steps it has, in its order. `seed` is the tweak it was created with, which Reset returns it to.
 */
export interface CustomWorkflow {
  id: string
  name: string
  base: WorkflowPresetId
  tweak: PresetTweak
  seed: PresetTweak
}

/**
 * What the model works from: a preset, or a custom workflow. `base` is the built-in preset def, `steps` the
 * default step set and order (a preset's own; a custom workflow's as created), `custom` whether the step set
 * can differ from `steps`.
 */
export interface WorkflowSource {
  id: string
  label: string
  description: string
  base: WorkflowPresetDef
  steps: readonly WorkflowStepId[]
  custom: boolean
  /** A custom workflow's tweak as created (Reset returns to it); null for a preset. */
  seed: PresetTweak | null
}

/** A preset's id, or the source of a workflow (a custom one's) the caller built with `customSource`. */
export type WorkflowRef = WorkflowPresetId | WorkflowSource

const presetSource = (def: WorkflowPresetDef): WorkflowSource => ({
  id: def.id,
  label: def.label,
  description: def.description,
  base: def,
  steps: def.steps,
  custom: false,
  seed: null,
})

/** The source of a custom workflow: its base preset's review and wording, its created order as the default. */
export function customSource(custom: {
  id: string
  name: string
  base: WorkflowPresetId
  seed?: PresetTweak | null
}): WorkflowSource {
  const base = workflowPreset(custom.base)
  const seedOrder = custom.seed?.order
  return {
    id: custom.id,
    label: custom.name,
    description: `Your own workflow, copied from ${base.label}.`,
    base,
    steps: seedOrder && !customOrderProblem(seedOrder) ? seedOrder : base.steps,
    custom: true,
    seed: custom.seed ?? null,
  }
}

/** The source behind a ref; an id that is not a preset reads as Standard. */
const sourceOf = (ref: WorkflowRef): WorkflowSource =>
  typeof ref === 'string' ? presetSource(workflowPreset(ref)) : ref

/** The preset's own default effort for a step with an agent (`auto` when it names none), null with no agent. */
export function defaultEffort(ref: WorkflowRef, id: WorkflowStepId): WorkflowEffort | null {
  if (WORKFLOW_STEPS[id].agent === 'you') return null
  return sourceOf(ref).base.effort[id] ?? 'auto'
}

/** The hand-off of a step before what else runs changes it: the preset's wording, else the catalogue's. */
export const stepHandoff = (ref: WorkflowRef, id: WorkflowStepId) =>
  sourceOf(ref).base.text[id]?.handoff ?? WORKFLOW_STEPS[id].handoff

// --- Team agents ---

/** A node of the graph that runs an agent: a step, or a phase of the review's round. */
export interface WorkflowNode {
  /** A step id (`build`), or a phase's id (`review.hunt-a`, `review.first.hunt-b`). */
  id: string
  label: string
  /** The role: what the Team's agent of that name (or the built-in default of the role) is called. */
  agent: Exclude<WorkflowAgent, 'you'>
  kind: 'step' | 'phase'
}

/** The sub-steps of a plan that are phases (not groups), with their role; the ticket agent's own are `you`. */
function planPhases(preset: WorkflowPresetDef): ReviewSubStepDef[] {
  const out: ReviewSubStepDef[] = []
  const walk = (list: readonly ReviewSubStepDef[]) => {
    for (const d of list) {
      out.push(d)
      walk(d.children)
    }
  }
  walk(preset.review.phases)
  walk(preset.review.between)
  return out
}

/**
 * Whether a step can name a Team agent: it starts an agent of its own. The ticket agent's own steps do not,
 * and neither does the review step (`runner`): the ticket agent runs `/feature-review` itself through the
 * Skill tool, and the phases it starts are the nodes that name their agents.
 */
const stepNamesTeamAgent = (id: WorkflowStepId) => {
  const role = WORKFLOW_STEPS[id].agent
  return role !== 'you' && role !== 'runner'
}

/**
 * The nodes of a preset that run an agent and so can name a Team agent: its steps that start an agent of
 * their own (not `you`, not the review step) and the review's phases with one. Groups (Maximum's two
 * reviews) and the ticket agent's own steps and phases are not nodes of that kind.
 */
export function bindableNodes(
  ref: WorkflowRef,
  steps: readonly WorkflowStepId[] = sourceOf(ref).steps,
): WorkflowNode[] {
  const preset = sourceOf(ref).base
  return [
    ...steps.flatMap((id): WorkflowNode[] => {
      const def = WORKFLOW_STEPS[id]
      return def.agent === 'you' || !stepNamesTeamAgent(id)
        ? []
        : [{ id, label: def.label, agent: def.agent, kind: 'step' }]
    }),
    // The review's phases belong to the workflow only while it has the review step.
    ...(steps.includes('review') ? planPhases(preset) : []).flatMap((d): WorkflowNode[] =>
      d.agent === 'you' || d.children.length
        ? []
        : [{ id: d.id, label: d.label, agent: d.agent, kind: 'phase' }],
    ),
  ]
}

/** The Team agent a node resolves to: the pick, or the default; `missing` when a stored pick is not in the Team. */
export interface TeamAgentRef {
  /** The agent that runs the node: the Team agent's own spelling, or the built-in role's name. */
  name: string
  /** `picked`: the human's pick. `role`: the Team agent named like the role. `default`: the built-in agent of the role. */
  source: 'picked' | 'role' | 'default'
  /** The stored pick: the Team agent's spelling when it is in the Team, the stored name when it is not. */
  picked: string | null
  /** A pick is stored and no Team agent has that name any more: the node runs as if none were stored. */
  missing: boolean
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** What a node runs with no pick: the Team agent named like its role, else the role's built-in agent. */
export function defaultTeamAgent(
  role: Exclude<WorkflowAgent, 'you'>,
  team: readonly string[] = [],
): Pick<TeamAgentRef, 'name' | 'source'> {
  const own = team.find((name) => sameName(name, role))
  return own === undefined ? { name: role, source: 'default' } : { name: own, source: 'role' }
}

/**
 * The Team agent a node runs, from its role, the pick stored for it and the names of the project's Team. With
 * no Team given nothing is in it: every node runs the built-in agent of its role, and a stored pick is missing.
 */
export function teamAgentFor(
  role: Exclude<WorkflowAgent, 'you'>,
  pick: string | undefined,
  team: readonly string[] = [],
): TeamAgentRef {
  if (pick === undefined) return { ...defaultTeamAgent(role, team), picked: null, missing: false }
  const own = team.find((name) => sameName(name, pick))
  if (own !== undefined) return { name: own, source: 'picked', picked: own, missing: false }
  return { ...defaultTeamAgent(role, team), picked: pick, missing: true }
}

/** The text of what a step does for the preset: its own wording, else the catalogue's. */
export const stepWhat = (ref: WorkflowRef, id: WorkflowStepId) =>
  sourceOf(ref).base.text[id]?.what ?? WORKFLOW_STEPS[id].what

/**
 * What runs for a ticket, read from the resolved steps: the served text and the review's phases are built
 * from it, so nothing asks for a step the same text lists as skipped.
 */
export interface FlowState {
  /** The spec step or the second spec runs, so there is a spec for the builder. */
  spec: boolean
  /** The (first) spec step runs: a second spec has one to reconcile with. */
  firstSpec: boolean
  tests: boolean
  /** The review has rounds for this ticket. */
  review: boolean
  /** The review ends every round with the intent check (Thorough and Maximum) and that check runs. */
  roundIntent: boolean
  preview: boolean
  intent: boolean
  ci: boolean
}

/** The text of a step that depends on what else runs for the ticket, else null (its default stands). */
function flowText(id: WorkflowStepId, flow: FlowState): { what?: string; handoff?: string } | null {
  switch (id) {
    case 'intent':
      return {
        ...(flow.preview
          ? {}
          : {
              what: 'The intent agent compares what the human asked, in their own words and attachments, with what was built (the diff and any screenshots the review took), and says for each thing asked whether it was done as asked, done differently or not done.',
            }),
        ...(flow.review ? {} : { handoff: INTENT_WITHOUT_REVIEW }),
      }
    case 'spec2':
      return flow.firstSpec
        ? null
        : {
            what: "A spec agent writes the ticket's only spec from the ticket alone, to `01-spec.md`: the Spec step is not run for this ticket, so the builder gets this spec as it is, with nothing to merge.",
            handoff:
              "Brief it with the ticket's context. Its spec is the one the builder gets; where the readings lead to different products, put both on a decision card.",
          }
    case 'preview':
      return flow.intent
        ? null
        : {
            handoff:
              'The preview link and its screenshots go into the summary. A change with nothing to try has no preview, and the summary says why.',
          }
    case 'ci':
      return flow.intent
        ? null
        : {
            handoff:
              'Green CI on the final head ends the step. A failure goes back to the builder like a gate failure.',
          }
    case 'push':
      return flow.intent
        ? null
        : {
            what: "Pushes the ticket's branch to origin and reads the ticket back to see the push registered.",
          }
    case 'summary':
      return flow.intent && flow.review && flow.preview
        ? null
        : {
            what: `Writes the ticket's summary, the one post the human reads on top of Main: what the change does and its state, ${flow.review ? "each round's verdict, " : ''}the PR ${flow.preview ? 'and preview links' : 'link'}, what to try, how it was tested${flow.intent ? " and the intent check's verdict" : ''}, with the screenshots. Then answers each of the human's posts it had answered with a plan.`,
          }
    case 'pr':
      return flow.ci ? null : { handoff: 'The PR number goes into the summary.' }
    case 'gate':
      return flow.review
        ? null
        : {
            what: "The ticket agent's own check before the change goes on: the project's checks scoped to what changed, the whole diff read, and the added lines searched for what breaks the proof contract (skipped tests, lint or type ignores, branches on the test environment, mocks of the module under change).",
            handoff:
              'A pass goes on with the head SHA and a note of what ran. A failure goes back to the builder with its output; the second return asks the human.',
          }
    case 'handoff':
      return flow.review && flow.preview
        ? null
        : {
            what: `Moves the ticket to review and reads the board's answer: the tasks still open${flow.review ? ', the subagent runs recorded without a report and the review phases the last round lacks' : ' and the subagent runs recorded without a report'}. Each is fixed before the hand-off stands.`,
            handoff: `The ticket stays in review${flow.preview ? ' with its preview running' : ''}; the result goes back to whoever started this run.`,
          }
    default:
      return null
  }
}

/** An effort as the agent runs it: `auto` follows the ticket's complexity; with none given, null. */
export function effortLevel(effort: WorkflowEffort, complexity: Complexity | null): EffortLevel | null {
  if (effort !== 'auto') return effort
  return complexity ? COMPLEXITY_EFFORT[complexity] : null
}

/**
 * What the order of steps breaks for a custom workflow, in words naming the step, or null when it holds. A
 * custom workflow's steps are its own list: each a known kind once, every step with a lock kept (a locked
 * step cannot be removed), `claim` first, `handoff` last, and each step after the ones it must follow.
 */
export function customOrderProblem(order: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const id of order) {
    if (!isWorkflowStep(id)) return `order: "${id}" is not a kind of step the workflow has`
    if (seen.has(id)) return `order: "${id}" is listed twice`
    seen.add(id)
  }
  for (const id of WORKFLOW_STEP_IDS)
    if (WORKFLOW_STEPS[id].lock !== null && !seen.has(id)) return `${id} is locked: it cannot be removed`
  if (order[0] !== 'claim') return 'claim must stay first'
  if (order.at(-1) !== 'handoff') return 'handoff must stay last'
  for (const id of order as readonly WorkflowStepId[]) {
    for (const dep of WORKFLOW_STEPS[id].after) {
      if (!seen.has(dep)) continue
      if (order.indexOf(dep) > order.indexOf(id)) return `${id} must come after ${dep}`
    }
  }
  return null
}

/** What the order of a preset (or a custom workflow's step list) breaks, in words naming the pair, or null when it holds. */
export function orderProblem(ref: WorkflowRef, order: readonly string[]): string | null {
  const source = sourceOf(ref)
  if (source.custom) return customOrderProblem(order)
  const def = source.base
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
  ref: WorkflowRef,
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
  const problem = orderProblem(ref, next)
  return problem ? { ok: false, reason: problem } : { ok: true, order: next }
}

// --- the steps of a custom workflow ---

/** Whether a step can be taken out of a custom workflow: the ones with no lock. */
export const removableStep = (id: WorkflowStepId): boolean =>
  WORKFLOW_STEPS[id].lock === null && WORKFLOW_STEPS[id].pinned === null

/** The kinds of step a custom workflow does not have yet, in the catalogue's order. */
export const addableSteps = (order: readonly WorkflowStepId[]): WorkflowStepId[] =>
  WORKFLOW_STEP_IDS.filter((id) => !order.includes(id))

/**
 * The order with a step of a kind the workflow lacks added where it belongs: after the steps that come before
 * it in the catalogue, else the first place the dependencies allow. Refused with words for a kind that is
 * not one of the catalogue's or one the workflow has already.
 */
export function addStep(
  order: readonly WorkflowStepId[],
  id: string,
): { ok: true; order: WorkflowStepId[] } | { ok: false; reason: string } {
  if (!isWorkflowStep(id)) return { ok: false, reason: `"${id}" is not a kind of step the workflow has` }
  if (order.includes(id)) return { ok: false, reason: `${id} is already a step of this workflow` }
  const canon = (x: WorkflowStepId) => WORKFLOW_STEP_IDS.indexOf(x)
  let preferred = 1
  order.forEach((other, i) => {
    if (canon(other) < canon(id)) preferred = i + 1
  })
  const places = [preferred, ...Array.from({ length: order.length }, (_, i) => i)]
  for (const at of places) {
    if (at < 1 || at > order.length - 1) continue
    const next = [...order.slice(0, at), id, ...order.slice(at)]
    if (!customOrderProblem(next)) return { ok: true, order: next }
  }
  return { ok: false, reason: `${id} has no place in this workflow's order` }
}

/** The order without a step, or why it cannot go: a locked step stays, and so does one that is not there. */
export function removeStep(
  order: readonly WorkflowStepId[],
  id: string,
): { ok: true; order: WorkflowStepId[] } | { ok: false; reason: string } {
  if (!isWorkflowStep(id)) return { ok: false, reason: `"${id}" is not a kind of step the workflow has` }
  if (!order.includes(id)) return { ok: false, reason: `${id} is not a step of this workflow` }
  if (!removableStep(id)) return { ok: false, reason: `${id} is locked: it cannot be removed` }
  return { ok: true, order: order.filter((x) => x !== id) }
}

/**
 * The name of a custom workflow checked: trimmed, 1 to 60 characters, and not the name of a preset or of
 * another workflow of the project (in any casing). `others` are the project's workflows without the one
 * being renamed.
 */
export function customNameProblem(
  name: unknown,
  others: readonly { name: string }[],
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== 'string' || !name.trim())
    return { ok: false, error: 'name: give the workflow a name (1 to 60 characters)' }
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length > CUSTOM_NAME_MAX)
    return { ok: false, error: `name: at most ${CUSTOM_NAME_MAX} characters` }
  const taken = [...WORKFLOW_PRESET_LIST.map((p) => p.label), ...others.map((o) => o.name)]
  if (taken.some((t) => t.toLowerCase() === trimmed.toLowerCase()))
    return { ok: false, error: `name: "${trimmed}" is already the name of a workflow of this project` }
  return { ok: true, name: trimmed }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stepWord = (id: string, source: WorkflowSource) => `${id} is not a step of the ${source.label} workflow`

/**
 * What `validateTweaks` needs to know about the project: the names of its Team agents (a pick must be one of
 * them, in any casing), and the picks already stored for the preset, which stay as they are even when their
 * agent has left the Team, so a body that carries them back unchanged is not refused for them.
 */
export interface TweakContext {
  team?: readonly string[]
  stored?: Readonly<Record<string, string>> | null
  /** A custom workflow's steps as stored: the step set a body without an `order` keeps. */
  order?: readonly WorkflowStepId[] | null
}

/**
 * Checks a tweak a human sends for one preset, and answers it typed or with every problem found, the
 * first one first. Nothing is dropped or fixed silently: an unknown key (an instruction text is one), an
 * unknown step or one the preset does not have, a locked step turned off, an effort on a step that runs no
 * agent, an effort or a round count out of range, an order that breaks a dependency, a Team agent picked
 * for a node that runs none or that the project's Team does not have. Run `normalizeTweaks` on the result
 * before saving it.
 */
export function validateTweaks(
  ref: WorkflowRef,
  input: unknown,
  context: TweakContext = {},
): { ok: true; tweak: PresetTweak } | { ok: false; error: string; errors: string[] } {
  const source = sourceOf(ref)
  const preset = source.base
  const errors: string[] = []
  const tweak: PresetTweak = {}
  if (!isRecord(input))
    return { ok: false, error: 'tweaks must be an object', errors: ['tweaks must be an object'] }
  for (const key of Object.keys(input))
    if (!['order', 'steps', 'rounds', 'agents'].includes(key))
      errors.push(`unknown key "${key}": a tweak has order, steps, agents and rounds`)

  if (input.order !== undefined) {
    if (!Array.isArray(input.order) || input.order.some((x) => typeof x !== 'string'))
      errors.push('order: a list of step ids')
    else {
      const problem = orderProblem(source, input.order as string[])
      if (problem) errors.push(problem)
      else tweak.order = input.order as WorkflowStepId[]
    }
  }
  // The steps the workflow has: a preset's own; a custom workflow's as sent, else as stored.
  const own: readonly WorkflowStepId[] = source.custom
    ? (tweak.order ?? (context.order && !customOrderProblem(context.order) ? context.order : source.steps))
    : source.steps
  // A custom workflow always keeps its step list, so a body that leaves it out keeps the stored one.
  if (source.custom && tweak.order === undefined && input.order === undefined) tweak.order = [...own]

  if (input.steps !== undefined) {
    if (!isRecord(input.steps)) errors.push('steps: an object keyed by step id')
    else {
      const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
      for (const [id, value] of Object.entries(input.steps)) {
        if (!isWorkflowStep(id)) {
          errors.push(`steps: unknown step "${id}"`)
          continue
        }
        if (!own.includes(id)) {
          errors.push(`steps: ${stepWord(id, source)}`)
          continue
        }
        if (!isRecord(value)) {
          errors.push(`steps.${id}: an object with enabled and effort`)
          continue
        }
        const mine: StepTweak = {}
        for (const key of Object.keys(value))
          if (!['enabled', 'effort'].includes(key))
            errors.push(`steps.${id}: unknown key "${key}" (enabled and effort)`)
        if (value.enabled !== undefined) {
          if (typeof value.enabled !== 'boolean') errors.push(`steps.${id}.enabled: true or false`)
          else if (!value.enabled && WORKFLOW_STEPS[id].lock === 'always')
            errors.push(`${id} is locked: it cannot be turned off`)
          else mine.enabled = value.enabled
        }
        if (value.effort !== undefined) {
          if (
            typeof value.effort !== 'string' ||
            !(WORKFLOW_EFFORTS as readonly string[]).includes(value.effort)
          )
            errors.push(`steps.${id}.effort: one of ${WORKFLOW_EFFORTS.join(', ')}`)
          else if (WORKFLOW_STEPS[id].agent === 'you')
            errors.push(`steps.${id}.effort: ${id} runs no agent of its own, so it has no effort`)
          else mine.effort = value.effort as WorkflowEffort
        }
        steps[id] = mine
      }
      tweak.steps = steps
    }
  }

  if (input.agents !== undefined) {
    if (!isRecord(input.agents)) errors.push('agents: an object keyed by node id, each a Team agent name')
    else {
      const agents: Record<string, string> = {}
      const nodes = new Map(bindableNodes(source, own).map((n) => [n.id, n]))
      const phases = new Map(planPhases(preset).map((d) => [d.id, d]))
      for (const [id, value] of Object.entries(input.agents)) {
        if (isWorkflowStep(id) && !own.includes(id)) {
          errors.push(`agents: ${stepWord(id, source)}`)
          continue
        }
        if (!isWorkflowStep(id) && phases.has(id) && !own.includes('review')) {
          errors.push(`agents: ${id} is a phase of the review, and this workflow has no review step`)
          continue
        }
        if (!nodes.has(id)) {
          const def = isWorkflowStep(id) ? WORKFLOW_STEPS[id] : phases.get(id)
          if (!def) errors.push(`agents: unknown node "${id}"`)
          else if ('children' in def && def.children.length)
            errors.push(`agents.${id}: ${id} is a group of reviews: name an agent for each of its phases`)
          else errors.push(`agents.${id}: ${id} runs no agent of its own, so it has no Team agent`)
          continue
        }
        if (typeof value !== 'string' || !value.trim()) {
          errors.push(`agents.${id}: the name of one of the project's Team agents`)
          continue
        }
        const team = context.team?.find((name) => sameName(name, value))
        const stored = Object.entries(context.stored ?? {}).find(
          ([node, name]) => node === id && sameName(name, value),
        )?.[1]
        if (team !== undefined) agents[id] = team
        else if (stored !== undefined) agents[id] = stored
        else
          errors.push(
            `agents.${id}: "${value.trim()}" is not one of the project's Team agents (add it on the Team page first)`,
          )
      }
      tweak.agents = agents
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
 * enabled step, the preset's effort, the Team agent named like the node's role, the preset's rounds) are dropped, and
 * a tweak with nothing left is null. Expects a tweak `validateTweaks` accepted.
 */
export function normalizeTweaks(ref: WorkflowRef, tweak: PresetTweak | null | undefined): PresetTweak | null {
  if (!tweak) return null
  const source = sourceOf(ref)
  const preset = source.base
  const out: PresetTweak = {}
  // A custom workflow's order is its step list: always kept, and the steps below are those it has.
  const own: readonly WorkflowStepId[] = source.custom ? (tweak.order ?? source.steps) : preset.steps
  if (source.custom) out.order = [...own]
  else if (tweak.order && tweak.order.some((id, i) => id !== preset.steps[i])) out.order = [...tweak.order]
  const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
  for (const [id, mine] of Object.entries(tweak.steps ?? {}) as [WorkflowStepId, StepTweak][]) {
    if (!own.includes(id)) continue
    const kept: StepTweak = {}
    if (mine.enabled === false) kept.enabled = false
    if (mine.effort !== undefined && mine.effort !== defaultEffort(source, id)) kept.effort = mine.effort
    if (Object.keys(kept).length) steps[id] = kept
  }
  if (Object.keys(steps).length) out.steps = steps
  const roles = new Map(bindableNodes(source, own).map((n) => [n.id, n.agent]))
  const agents: Record<string, string> = {}
  for (const [id, name] of Object.entries(tweak.agents ?? {})) {
    const role = roles.get(id)
    if (role !== undefined && name.trim() && !sameName(name, role)) agents[id] = name.trim()
  }
  if (Object.keys(agents).length) out.agents = agents
  // The rounds belong to the review step: a workflow without it keeps none, so adding it back starts from the preset's.
  const rounds: Partial<Record<Complexity, number>> = {}
  if (own.includes('review'))
    for (const level of COMPLEXITIES) {
      const n = tweak.rounds?.[level]
      if (n !== undefined && n !== preset.rounds[level]) rounds[level] = n
    }
  if (Object.keys(rounds).length) out.rounds = rounds
  return Object.keys(out).length ? out : null
}

/**
 * What a saved tweak still means to the catalogue: unknown steps and nodes, values that no longer pass and
 * keys the page no longer has (a step's instruction text) are dropped, an order that no longer holds is dropped (the default order stands), and a locked step's off
 * switch is ignored. Stored data outlives the catalogue, so reading it never throws.
 */
function readSaved(ref: WorkflowRef, saved: unknown): PresetTweak | null {
  const source = sourceOf(ref)
  const preset = source.base
  const tweak: PresetTweak = {}
  if (source.custom) {
    // A custom workflow keeps its own step list; one that no longer holds is read as the one it was created with.
    const known = isRecord(saved) && Array.isArray(saved.order) ? saved.order.filter(isWorkflowStep) : []
    tweak.order = known.length && !customOrderProblem(known) ? known : [...source.steps]
  } else if (isRecord(saved) && Array.isArray(saved.order)) {
    const known = saved.order.filter(
      (id): id is WorkflowStepId => isWorkflowStep(id) && preset.steps.includes(id),
    )
    if (!orderProblem(source, known)) tweak.order = known
  }
  if (!isRecord(saved)) return source.custom ? normalizeTweaks(source, tweak) : null
  const own: readonly WorkflowStepId[] = tweak.order ?? source.steps
  if (isRecord(saved.steps)) {
    const steps: Partial<Record<WorkflowStepId, StepTweak>> = {}
    for (const [id, value] of Object.entries(saved.steps)) {
      if (!isWorkflowStep(id) || !own.includes(id) || !isRecord(value)) continue
      const mine: StepTweak = {}
      if (value.enabled === false && WORKFLOW_STEPS[id].lock !== 'always') mine.enabled = false
      if (
        typeof value.effort === 'string' &&
        (WORKFLOW_EFFORTS as readonly string[]).includes(value.effort) &&
        WORKFLOW_STEPS[id].agent !== 'you'
      )
        mine.effort = value.effort as WorkflowEffort
      steps[id] = mine
    }
    tweak.steps = steps
  }
  if (isRecord(saved.agents)) {
    const ids = new Set(bindableNodes(source, own).map((n) => n.id))
    const agents: Record<string, string> = {}
    for (const [id, name] of Object.entries(saved.agents))
      if (ids.has(id) && typeof name === 'string' && name.trim()) agents[id] = name.trim()
    tweak.agents = agents
  }
  if (isRecord(saved.rounds)) {
    const rounds: Partial<Record<Complexity, number>> = {}
    for (const level of COMPLEXITIES) {
      const n = saved.rounds[level]
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ROUNDS_MAX) rounds[level] = n
    }
    tweak.rounds = rounds
  }
  return normalizeTweaks(source, tweak)
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

/**
 * The custom workflows of a project as stored, each cleaned: an entry with no valid id or name is dropped, a
 * base that is not a preset reads as Standard, and its tweak and seed are read as any saved tweak is. Never throws.
 */
export function readCustomWorkflows(saved: unknown): CustomWorkflow[] {
  if (!Array.isArray(saved)) return []
  const out: CustomWorkflow[] = []
  const seen = new Set<string>()
  for (const entry of saved) {
    if (!isRecord(entry) || !isCustomWorkflowId(entry.id) || seen.has(entry.id)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, CUSTOM_NAME_MAX) : ''
    if (!name) continue
    seen.add(entry.id)
    const base = isWorkflowPreset(entry.base) ? entry.base : DEFAULT_WORKFLOW_PRESET
    const seed = readSaved(customSource({ id: entry.id, name, base }), entry.seed)!
    const tweak = readSaved(customSource({ id: entry.id, name, base, seed }), entry.tweak)!
    out.push({ id: entry.id, name, base, tweak, seed })
  }
  return out
}

/** JSON with the keys of every object sorted, so two tweaks with the same content read the same in any key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  )
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
  /** The Team agent that runs it; null for the ticket agent's own phases and for groups. */
  teamAgent: TeamAgentRef | null
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
  /**
   * The `/feature-review` runs one round makes, each with its `phases=` argument and, one name per token of
   * it in the same order, the Team agent that briefs the phase (`agents=`: the role's name where the Team has
   * no agent for it).
   */
  runs: (ReviewRunDef & { phasesArg: string; agentsArg: string })[]
  /** The kind of run each round needs and how many of each: what the hand-off checks. */
  perRound: { phase: ReviewPhaseKind; expected: number }[]
}

export interface ResolvedStep {
  id: WorkflowStepId
  label: string
  what: string
  agent: WorkflowAgent
  /** `you`, `spec`, `/feature-review`: how the graph and the served text name who runs it. */
  agentLabel: string
  /** What the step receives and passes on: the preset's wording, read-only. */
  handoff: string
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
  /**
   * The Team agent that runs it (`agent` stays its role: spans, run reports and the board's checks name the
   * role); null when the ticket agent runs the step itself.
   */
  teamAgent: TeamAgentRef | null
  /** The step's `start_span` phase, and whether it carries the review round. */
  span: { phase: string; round: boolean } | null
  /** What the human changed on it. */
  edited: { enabled: boolean; effort: boolean; agent: boolean; moved: boolean; any: boolean }
  /** Why a move is refused (words naming the pair), null when it is allowed. */
  moveBlocked: { up: string | null; down: string | null }
}

export interface ResolvedWorkflow {
  /** The workflow's id: a preset's, or a custom workflow's. */
  preset: string
  /** The built-in preset that supplies the review plan and the wording: the preset itself for a preset. */
  base: WorkflowPresetId
  /** A project's own workflow, not one of the four presets. */
  custom: boolean
  label: string
  description: string
  /** The ticket's complexity this was resolved for; null for the preset as such. */
  complexity: Complexity | null
  /** The saved tweak in force, as it is stored (normalized); null when the preset is as shipped. */
  tweak: PresetTweak | null
  tweaked: boolean
  /** The order in force, and the preset's own (a custom workflow's: the one it was created with). */
  order: WorkflowStepId[]
  defaultOrder: WorkflowStepId[]
  /** Every step in order, the skipped ones included (they carry `skipped` and no number). */
  steps: ResolvedStep[]
  /** How many steps run for this ticket. */
  numbered: number
  /** The review's rounds per complexity, and the preset's own. */
  rounds: Record<Complexity, number>
  defaultRounds: Record<Complexity, number>
  /** What runs for this ticket: the served text is built from it. */
  flow: FlowState
}

/** Which Team agent each node runs: the preset's picks against the names of the project's Team. */
type TeamOf = (nodeId: string, role: WorkflowAgent) => TeamAgentRef | null

function resolveSub(
  def: ReviewSubStepDef,
  parent: string | null,
  at: number,
  teamOf: TeamOf,
): ResolvedSubStep {
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
    teamAgent: def.children.length ? null : teamOf(def.id, def.agent),
    children: def.children.map((child, i) => resolveSub(child, number, i, teamOf)),
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
  intentRuns: boolean,
  teamOf: TeamOf,
): ResolvedReview {
  const at = number === null ? null : String(number)
  // The round-end intent check is a phase of the round only while the intent step runs for the ticket.
  const defs = preset.review.phases.filter((d) => intentRuns || d.id !== ROUND_INTENT_ID)
  const counts = phaseCounts(defs)
  const phases = defs.map((d, i) => resolveSub(d, at, i, teamOf))
  return {
    rounds: complexity ? rounds[complexity] : null,
    roundsByComplexity: rounds,
    defaultRounds: { ...preset.rounds },
    survival: preset.review.survival(
      intentRuns && preset.review.phases.some((d) => d.id === ROUND_INTENT_ID),
    ),
    phases,
    between: preset.review.between.map((d) => resolveSub(d, null, 0, teamOf)),
    runs: preset.review.runs.map((r) => {
      // A run's phases are the top-level ones, or the children of its own full review (Maximum's two).
      const own = r.agentSuffix === null ? phases : (phases.find((p) => p.id === r.id)?.children ?? [])
      const names = own.filter((p) => p.phase !== null).map((p) => p.teamAgent?.name ?? '')
      return { ...r, phasesArg: r.phases.join(','), agentsArg: names.join(',') }
    }),
    perRound: REVIEW_PHASE_KINDS.flatMap((phase) => {
      const expected = counts.get(phase)
      return expected ? [{ phase, expected }] : []
    }),
  }
}

/**
 * A preset and its saved tweaks as the graph a ticket of `complexity` goes through: every step in order
 * with its number (skipped ones with the reason and no number), agent, effort, hand-off text, lock,
 * what the human edited and where it can move; the review with its rounds, its phases per round, what
 * happens between rounds and the `/feature-review` runs a round makes. With no complexity nothing is
 * skipped for being low (steps that skip a low ticket say so in `skipsOnLow`) and the rounds are the table.
 *
 * `tweak` is the preset's own tweak as stored (`projectTweaks[preset]`); it is read leniently, never
 * thrown on: what the catalogue no longer has is ignored and a broken order falls back to the default.
 * `team` is the names of the project's Team agents, which only the caller knows (this module reads no
 * database): each node's `teamAgent` is the stored pick when the Team has that agent, else the Team agent
 * named like the node's role, else the built-in agent of that role. With no `team` nothing is in the Team.
 */
export function resolveWorkflow(
  ref: WorkflowRef,
  tweak?: unknown,
  complexity: Complexity | null = null,
  team: readonly string[] = [],
): ResolvedWorkflow {
  const source = sourceOf(ref)
  const preset = source.base
  const id = source.id
  const saved = readSaved(source, tweak)
  const order = saved?.order ? [...saved.order] : [...source.steps]
  const defaultOrder = [...source.steps]
  const rounds = { ...preset.rounds, ...saved?.rounds }
  const teamOf: TeamOf = (nodeId, role) =>
    role === 'you' ? null : teamAgentFor(role, saved?.agents?.[nodeId], team)
  const skipOf = (stepId: WorkflowStepId): ResolvedStep['skipped'] => {
    const def = WORKFLOW_STEPS[stepId]
    const own = saved?.steps?.[stepId]
    const enabled = def.lock === 'always' ? true : own?.enabled !== false
    const roundsHere = stepId === 'review' && complexity ? rounds[complexity] : null
    if (def.aboveLow && complexity === 'low') return { reason: 'low', note: 'skipped: low ticket' }
    if (!enabled && (def.lock !== 'above-low' || complexity === 'low'))
      return {
        reason: 'off',
        note:
          def.lock === 'above-low'
            ? 'skipped: turned off for low tickets on the Workflow page'
            : 'skipped: turned off on the Workflow page',
      }
    if (roundsHere === 0)
      return complexity === 'low'
        ? { reason: 'low', note: 'skipped: low ticket (no review rounds)' }
        : { reason: 'rounds', note: `skipped: no review rounds for a ${complexity} ticket` }
    return null
  }
  const runs = (stepId: WorkflowStepId) => order.includes(stepId) && !skipOf(stepId)
  const flow: FlowState = {
    spec: runs('spec') || runs('spec2'),
    firstSpec: runs('spec'),
    tests: runs('tests'),
    review: runs('review'),
    roundIntent:
      runs('review') && runs('intent') && preset.review.phases.some((d) => d.id === ROUND_INTENT_ID),
    preview: runs('preview'),
    intent: runs('intent'),
    ci: runs('ci'),
  }
  let counter = 0
  const steps: ResolvedStep[] = order.map((stepId, position) => {
    const def = WORKFLOW_STEPS[stepId]
    const own = saved?.steps?.[stepId]
    const enabled = def.lock === 'always' ? true : own?.enabled !== false
    const skipped = skipOf(stepId)
    const number = skipped ? null : ++counter
    const effortDefaultValue = defaultEffort(source, stepId)
    const effort = effortDefaultValue === null ? null : (own?.effort ?? effortDefaultValue)
    const flowOwn = flowText(stepId, flow)
    const handoff = flowOwn?.handoff ?? stepHandoff(source, stepId)
    // Moved: its place among the steps both orders have differs from the default's.
    const moved =
      defaultOrder.includes(stepId) &&
      order.filter((x) => defaultOrder.includes(x)).indexOf(stepId) !==
        defaultOrder.filter((x) => order.includes(x)).indexOf(stepId)
    const edited = {
      enabled: own?.enabled === false,
      effort: own?.effort !== undefined,
      agent: saved?.agents?.[stepId] !== undefined,
      moved,
      any: false,
    }
    edited.any = edited.enabled || edited.effort || edited.agent || edited.moved
    const up = moveStep(source, order, stepId, 'up')
    const down = moveStep(source, order, stepId, 'down')
    return {
      id: stepId,
      label: def.label,
      what: flowOwn?.what ?? stepWhat(source, stepId),
      agent: def.agent,
      agentLabel: AGENT_LABELS[def.agent],
      handoff,
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
      review:
        stepId === 'review' ? resolveReview(preset, number, rounds, complexity, flow.intent, teamOf) : null,
      teamAgent: stepNamesTeamAgent(stepId) ? teamOf(stepId, def.agent) : null,
      span: def.span,
      edited,
      moveBlocked: { up: up.ok ? null : up.reason, down: down.ok ? null : down.reason },
    }
  })
  const normalized = normalizeTweaks(source, saved)
  // A custom workflow always has its step list stored: it is tweaked when it differs from the one it was created with.
  const tweaked = source.custom
    ? stableJson(normalized) !== stableJson(normalizeTweaks(source, source.seed ?? { order: defaultOrder }))
    : normalized !== null
  return {
    preset: id,
    base: preset.id,
    custom: source.custom,
    label: source.label,
    description: source.description,
    complexity,
    tweak: normalized,
    tweaked,
    order,
    defaultOrder,
    steps,
    numbered: counter,
    rounds,
    defaultRounds: { ...preset.rounds },
    flow,
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
