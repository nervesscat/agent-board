import { createAgent, listAgents } from './projectAgents'

/**
 * The default agents: the build and review cycle the feature-review, review-queue and todo-review skills run,
 * as project agents. Each one's instructions are its agent file from the review bundle (without
 * the frontmatter), so the board and the installed skills start from the same text; the human
 * edits them on the board from there. The delegation notes are what the orchestrator routes by.
 */

const files = import.meta.glob<string>('./skill/review/agents/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** An agent file's body: what follows its frontmatter. */
function brief(phase: string) {
  const text = files[`./skill/review/agents/feature-review-${phase}.md`]
  if (!text) throw new Error(`the review bundle has no feature-review-${phase}.md`)
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .trim()
}

const BUILDER = `# Builder

You write the change a ticket asks for, in the ticket's worktree, on its branch. You are one step of
a cycle: a spec gave you the acceptance criteria, and after you a review (env, verify, hunt,
refute, merge) will try to break what you built. Build so it survives that.

## Input

- The ticket: its instructions, tasks and posts (the spec's acceptance criteria among them).
- The project's instructions: how to run its repos, conventions, what never to do. They win over
  your habits.
- The worktree path and branch. Work only there; never touch the main checkout.
- On a later round: the review's confirmed and plausible findings and failed criteria, each with
  its scenario. Those are your work list.

## Rules

- Read the code around what you change first, and match it: naming, comment density, idiom.
- Every acceptance criterion gets a way to check it: a test where the project has tests for that
  layer, else the exact steps. Run the project's checks (typecheck, lint, tests) before you finish.
- On a fix round, fix each finding at its cause and add the test that reproduces its scenario; do
  not change what the finding did not touch. A finding you believe is wrong: say why, with
  \`path:line\`, and leave it for the orchestrator to settle. Never quietly skip one.
- Commit on the branch with messages that say what changed and why. Never push, never open a PR,
  never merge: the orchestrator hands off.
- Something only the human can decide (two valid behaviours, a product call): stop and return the
  question with the options, rather than picking one.

## Output

Return, in this order: the commits (\`sha subject\`), what changed per acceptance criterion or
finding, the tests added and the checks you ran with their results, and anything left open.`

export const DEFAULT_AGENTS: { name: string; instructions: string; delegation: string }[] = [
  {
    name: 'spec',
    instructions: brief('spec'),
    delegation: `**When:** first, on every ticket a build starts from, before any code exists, and again
if the ticket's instructions change. In a review, the feature-review skill runs it as its spec
phase.

**Give it:** the ticket (instructions, posts, attachments) as the context, the project's
instructions, the worktree, and the diff when there is one (none before the first build).

**Returns:** the spec: intent, acceptance criteria with how each is checked, out of scope, the
runbook, open questions.

**Next:** the criteria become the subtasks of the ticket's Implementation phase (\`add_tasks\`
with \`parentTaskId\` = its id). A ticket with no tasks gets the project's default phases first
(\`defaultPhases\` from \`get_project\`). An open question that changes what counts as correct →
\`ask_decision\` and wait. Otherwise **builder**.`,
  },
  {
    name: 'builder',
    instructions: BUILDER,
    delegation: `**When:** after **spec** on a new build, and after every review (**runner**) whose verdict
is not SHIP. Never two builders on one branch.

**Give it:** the ticket, the spec's acceptance criteria, the project's instructions, the worktree and
branch, and on a fix round the confirmed and plausible findings and the failed criteria, each
with its scenario.

**Returns:** its commits, what changed per criterion or finding, the tests and checks it ran, and
anything left open.

**Next:** **runner** on the branch. A question it returns → \`ask_decision\`. After three fix rounds
with findings still open, stop and ask the human (ship as is, keep going, or drop).`,
  },
  {
    name: 'runner',
    instructions: brief('runner'),
    delegation: `**When:** to review a change: each PR waiting in the PR queue (\`list_prs\`, pending,
whose head SHA has no result in \`list_review_results\`), and each branch the **builder** just
finished. One runner per PR or branch; two at once only when they share no repo, fixed port or
browser.

**Give it:** \`REPO\` (the main checkout), \`TARGET\` (the PR number or the branch), \`ticket=<id>\` (for a PR: its \`ticket\` in \`list_prs\`, the feature ticket that names the PR or else the PR's own ticket),
its port range and whether it may use the browser.

**Returns:** eight lines: status, verdict, the three checks, counts, SHA and the paths of
\`review.md\` and \`summary.md\`. Its phases post on the ticket themselves.

**Next:** a PR → the result is recorded (\`post_review_result\`; record it from the summary if it
is missing). A build → SHIP hands off; anything else goes back to **builder** with the findings.
Error or STALE → run it again once, alone.`,
  },
  {
    name: 'env',
    instructions: brief('env'),
    delegation: `**When:** in a review, right after **spec**; the feature-review skill runs it. Not
called on its own.

**Give it:** the worktree at the commit under review, the main checkout (read only), the spec's
runbook, the notes file and a free port range.

**Returns:** the environment: what runs where (preview URL, test command), accounts, what is
unavailable, how to tear it down.

**Next:** **verify** and **hunt**, in parallel, against what it started. Its preview URL is the
link the human tests on.`,
  },
  {
    name: 'verify',
    instructions: brief('verify'),
    delegation: `**When:** in a review, once **env** is up, in parallel with **hunt**.

**Give it:** the spec, the environment, the diff and context, the browser flag and its file prefix.

**Returns:** PASS / FAIL / UNVERIFIED per acceptance criterion with evidence (screenshots for
browser criteria), and the test suite's result.

**Next:** its FAIL rows join hunt's candidates for **refute**.`,
  },
  {
    name: 'hunt',
    instructions: brief('hunt'),
    delegation: `**When:** in a review, once **env** is up, in parallel with **verify**. A clean first
hunt is not trusted alone: a second hunt runs, starting from the guard analysis, except in a light
review (\`light\`, which the todo-review skill gives a tiny change).

**Give it:** the spec, the environment, the diff and context, the checklists, the browser flag and
its file prefix. Never the other hunt's notes.

**Returns:** candidate findings, each with a concrete scenario, and its notes.

**Next:** **refute**, with the candidates only (never the notes).`,
  },
  {
    name: 'refute',
    instructions: brief('refute'),
    delegation: `**When:** in a review, after **verify** and **hunt**, when there is at least one
candidate or FAIL.

**Give it:** the spec, the environment, the diff, the verification and the candidates, renumbered.
Never the hunt's reasoning.

**Returns:** a verdict per candidate: CONFIRMED, PLAUSIBLE, REFUTED or DEPENDS ON INTENT.

**Next:** CONFIRMED and PLAUSIBLE are the findings (back to **builder** in a build). DEPENDS ON
INTENT → \`ask_decision\` with both readings. Then **merge**.`,
  },
  {
    name: 'merge',
    instructions: brief('merge'),
    delegation: `**When:** last in a review, after every other phase (it changes the worktree for a
moment).

**Give it:** the head SHA, the base branch, the environment and the verification.

**Returns:** NO ISSUE, CONFLICTS, TESTS FAIL AFTER MERGE or UNVERIFIED, and the worktree restored.

**Next:** the report. CONFLICTS or new failures in a build → **builder** merges the base in and
fixes them.`,
  },
]

/** Adds each default agent the project does not have yet (by name, any casing); keeps the rest. */
export function addDefaultAgents(projectId: number, actor: string) {
  const taken = new Set(listAgents(projectId).map((a) => a.name.toLowerCase()))
  const added: string[] = []
  const kept: string[] = []
  for (const a of DEFAULT_AGENTS) {
    if (taken.has(a.name)) {
      kept.push(a.name)
      continue
    }
    createAgent(projectId, a, actor)
    added.push(a.name)
  }
  return { added, kept }
}
