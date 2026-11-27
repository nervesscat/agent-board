---
name: feature-review
description: "Reviews one feature or change for correctness, reliability and security with a protocol built to produce zero false positives. The phases it runs are a plan: the caller's phases= argument or, on a board ticket, the ticket's workflow (get_workflow); with neither, the six standard phases (spec, env, verify, hunt, refute, merge check). The code under review runs from its own worktree at the exact commit, on servers the review starts itself; every finding needs a concrete failure scenario and must survive an adversarial refutation pass; an empty result is valid and comes with proof of what was checked."
user-invocable: true
argument-hint: "[repo=<path>] [<PR number> | <branch> | diff | staged | <path>] [ticket=<id>] [phases=<list>] [deep] [light] [keep] [ports=<from>-<to>] [browser=yes|no] [scoped] [post] [slots=<dir>] [build=<path>] [repoId=<id>]"
---

# Feature Review

You are orchestrating a multi-agent review of **one change**. The output is a report the
author can trust: every finding in it is real, reproduced where possible, and comes with
the scenario that triggers it. Follow the phases exactly. Delegate all analysis to the
agents. Do NOT review the code yourself.

## The contract (you and every agent are bound by it)

**The prior.** A well-built change usually has zero real bugs. An empty findings list is a
valid, common, and expected result. A false positive costs more than a miss: it wastes
the author's time and makes every future report less trusted. Nobody is rewarded for
finding something.

**A finding is a claim that a specific input or state produces a specific wrong outcome.**
It must carry all of these or it is not a finding:

| Field | Requirement |
|---|---|
| Claim | One sentence stating what breaks. |
| Location | `path:line` in the diff or in code the diff relies on. |
| Scenario | Concrete: this input / this state produces this wrong output, crash, or exposure. "Could", "might", "if someone" without a concrete input is not a scenario. |
| Evidence | Test output, a repro command with its output, or a traced code path with line references. |
| Severity | `major`, `medium` or `minor`, from the fixed scale in the refute agent's file (`feature-review-refute.md`, **Severity scale**: each level with its definition and an example). The hunt proposes one; the refute agent's final severity is the one that counts. Nothing below `minor` is reported. |
| Confidence | `confirmed` (reproduced by execution) or `plausible` (traced, not executed, no refutation found). |

**Not findings, ever:** style, naming, structure preferences, "consider adding", missing
tests the spec did not ask for, hypotheticals that need an input the system cannot
receive, anything listed under *Out of scope* in the spec, and pre-existing issues in
code the change did not touch.

**Freshness.** Everything executed during the review runs from the review's own worktree
at the commit under review, against servers this review started on ports that were free
beforehand. A server that was already running is never used: it is running someone
else's code. If something cannot be provided, the affected criteria are `UNVERIFIED`
with the reason. Never a guess.

**Never touch the developer's checkout.** All agents work inside the worktree. Probe
files are created only under the agent's filename prefix and deleted before it finishes.
`git -C <worktree> status --porcelain` must be empty of an agent's files when it is done.

**Nothing leaves the machine.** Never `git push`. Never commit on any branch. Never
create, move, or delete a branch in the developer's checkout; fetching is the only
remote operation. Never `gh pr edit`, `merge`, `close`, `review`, or `ready`. The single
outward action is a PR comment, only when `post` was given and the review is fresh.

## In a session without the board's tools, agent types or the Agent tool

A cloud session, or any client that reaches the board only through a proxy, may lack what this skill
names. Go on as below, and say in the run's summary which of these applied:

- **No `board` MCP tools**: start them with the `board-mcp` bridge (the board's README, "Cloud
  agents"), or call each tool's REST route instead: the board skill served with `?transport=rest`
  (`<board>/api/agent-setup/skill?transport=rest`) lists every tool with its route. The agent token
  comes from the environment, never from a prompt, and is never printed.
- **The agent types (`todo-review-ticket`, `feature-review-*`) are not offered**: their files are in
  `~/.claude/agents/`, but the session did not load them. Start a general-purpose agent whose prompt
  says to read `~/.claude/agents/<type>.md` (everything after its frontmatter) as its instructions,
  followed by the brief this skill gives it, at the same effort.
- **No Agent tool** (a subagent cannot start subagents): run each phase yourself, in order, following
  its agent file as your own instructions; phases this skill runs in parallel run one after the other.
- **No board-run preview of your worktree** (the board's machine cannot see it): push the branch, then
  `preview_branch` (`POST /api/tickets/:id/branch-preview`): the board fetches the branch into a
  worktree of its own and runs the repo's preview there.

## Arguments

Parse `$ARGUMENTS` as space-separated tokens:

| Token | Meaning | Default |
|---|---|---|
| `repo=<path>` | the repository's main checkout | current working directory |
| a number | a GitHub PR | |
| a branch name, `diff`, `staged`, or a path | the change to review | see Setup |
| `phases=<list>` | the plan: the phases this run executes, as comma-separated tokens (**The plan**, below): e.g. `spec,env,verify,hunt,hunt,refute,merge`, or `reviewer` alone. A board cycle's ticket agent passes what its workflow's review step gives | the ticket's workflow on a board ticket, else the six standard phases |
| `agents=<list>` | the Team agent that briefs each phase of `phases=`: one name per token, in the same order (a board cycle's ticket agent passes what its workflow's review step gives). The phase is briefed with that project agent's `instructions` (**On the board**, step 1) instead of the agent named like the phase; a name that is not one of the project's agents (a built-in role the Team has no agent for) briefs the phase from its agent file as before. It changes only who briefs the phase: spans, run reports and `agentName` still carry the phase's own name | on a board ticket with no `phases=`: the `agents=` the ticket's workflow gives with its plan (**The plan**, rule 2); else each phase's agent is the project's agent named like it |
| `delta` | this run is a **delta round** (**Rounds after the first**, below): only from round 2 on, and only when the caller's workflow rule gives one; the plan is the delta plan the workflow gives (`phases=verify,hunt,refute,merge` under Standard) and the run records the round as a delta round (**On the board**, step 6) | off |
| `deep` | the independent hunts also report each finding's stability (every hunt or one) | off |
| `light` | a depth name only: it has no effect on the phases, every phase the plan lists runs (every hunt included) | off |
| `keep` | keep the worktree and servers after the report, for debugging | off |
| `ports=<from>-<to>` | range to allocate from when a default port is busy | `8100-8199` |
| `browser=yes\|no` | whether browser automation may be used | `yes` |
| `frontend=<path>` | main checkout of the UI repo that talks to this backend; the env agent starts its dev server against the review backend and the verify agent drives it | none |
| `scoped` | run only the scoped checks even where no CI runs the full suite (`CI: none`): the caller runs the full suite once at the final head | off |
| `slots=<dir>` | the directory holding the repo's heavy-run test slots (`tests-<repo id>-1` … `-N`, and `tests-<repo id>-full`): a heavy run takes the first free one and releases it right after, a light run takes none | none: each heavy run starts without a slot |
| `build=<path>` | a build record the caller's gate wrote after its end-to-end build: the head SHA, the `.output-e2e` path and the time. The env phase reuses that artifact when the SHA is the commit under review, and builds once when it is not | none |
| `repoId=<id>` | the repo id the test slot folders are named with (`tests-<id>-1` … `-N`, `tests-<id>-full`), passed to every phase; the env phase writes the exact folders into `00-env.md` | none |
| `post` | post the report as a PR comment when the target is a PR | off |
| `effort=<low\|medium\|high>` | the thinking effort of every phase agent, passed as the Agent tool's `effort`; a board cycle's ticket agent passes the effort its workflow's review step names (`auto` means `low` for a low ticket, `medium` for mid and high, `high` for max) | the session's |
| `round=<n>` | the review round this run is: every phase span (`start_span` / `end_span` with `agent` = the phase's agent name, e.g. `spec`, `env`, `verify`, `hunt-1`, `hunt-2`, `hunt-3`, `hunt-security`, `reviewer`, `refute`, `merge`, and `round`; the board counts any `hunt-<name>` or `reviewer` as a hunt) and every phase's run report (`write_run_report` with `round`) carry it, because the board counts a phase only when its span or report carries the round | `1` when a board ticket is given and no round is |
| `ticket=<id>` | the board ticket this change belongs to: turns on **On the board** below | found from the PR's `ticket` in `list_prs` when the board is connected |
| `agent=<prefix>` | only when the caller runs this review more than once for the same round (a workflow's two reviews of a round): the name every phase agent's span and report of this run starts with, so the runs stay apart (`<prefix>/<phase agent name>`); the last segment still names the phase. The prefix's last segment (`AGENT_TAG`, e.g. `review-second` for `<name>/review-second`) also goes into this run's `SLUG` (Setup), so each run has its own `WORKDIR`, claim, worktree and ledger line | none |

## The plan: which phases run

The phases of a run are a **plan**, a list of tokens, and **every phase the plan lists runs**. None is
skipped because the findings look obvious, the change looks small or a finding was already
reproduced, and each phase posts its result, so a skipped phase is visible. Where the plan comes from,
first match:

1. **`phases=<list>`**: the caller's plan. A ticket agent passes the `phases=` its workflow's review
   step gives (`get_workflow` serves it, e.g. `phases=spec,env,verify,hunt,hunt,refute,merge`).
2. **On a board ticket without `phases=`**: the ticket's workflow. `get_workflow` with the project and
   the ticket (`ticket=<id>`), the `phases=` its review step gives for this run, and the `agents=` it
   prints with them for the same run (the human's Team picks for the review phases), both for this
   round's shape (round 1, a full round after the first, or a delta round with `delta`: **Rounds
   after the first**), so a queue
   review or a person's request briefs each phase with the Team agent the workflow names, as the
   ticket agent's own cycle does. An `agents=` given in the call still wins.
   When that workflow lists the ticket's review as skipped (a low ticket, no rounds for its level, or
   the review step turned off) it gives no `phases=`; if a review is asked for anyway (a queue review of
   its PR, a person's request), run the six standard phases and say so in the report: "workflow lists no
   review for this ticket: the six standard phases". A workflow whose review is Light gives
   `phases=reviewer`, and that is the plan.
3. **No board, no ticket, or a board that does not answer**: the six standard phases,
   `spec,env,verify,hunt,hunt,refute,merge` (spec, env, verify, two independent hunts, refute and the
   merge check), and the report says so: "no workflow: the six standard phases".

| Token | The phase |
|---|---|
| `spec` | Phase 1: Spec |
| `env` | Phase 1b: Environment |
| `verify` | Phase 2: Verify |
| `hunt` | one hunt (Phase 2), independent of every other hunt; the token repeats once per hunt, so two `hunt` tokens are two hunts that never share notes |
| `hunt-security` | one more independent hunt whose checklist sections are the Security one only |
| `refute` | Phase 3: Refute |
| `merge` | Phase 3b: Merge check |
| `reviewer` | the single-reviewer plan, alone (below) |

The order the phases run in is fixed by what each one reads, as written below (spec, then env, then
verify and every hunt at once, then refute, then the merge check), not by the order of the tokens.

**Rounds after the first.** The round's shape is decided by a written rule, never by an agent: the
spec is written once, in round 1, so no round after the first has a `spec` phase (the workflow's
`phases=` for a later round has no `spec` token). A full round after the first runs every other
phase. After round 1, a round whose confirmed findings refute rated all `minor` (the Severity column
of that round's `04-verdicts.md`) is followed by a **delta round** (`delta`), and only such a round:
it had at least one confirmed finding and no intent `does not match` sent it back. In a delta round
verify runs only the acceptance criteria of the findings the fix pass fixed (the ones the orchestrator
appended, Phase 1), one hunt runs on the fix commits' diff only, refute rates what those two raise, and
the merge check runs as in any round (Phase 3b). A delta round survives only when every acceptance
criterion is `PASS` by execution: the ones its verify ran plus the ones an earlier round's verify
recorded `PASS`. A criterion that no round has passed (it is on the **Not yet passed** list, Phase 1)
and that the delta round did not run makes the round not survive, and the next round is a full round,
which runs every criterion. Every other round that did not survive is followed by a
full round with every phase the workflow lists: one with any `medium` or `major` confirmed finding,
and one with no confirmed finding at all, whatever sent it back (a plausible finding, a criterion
that is not `PASS`, the works check or a merge-check failure). A round that follows an intent
`does not match` is always a full round, whatever the severity of that round's findings; round 1 is
always a full round. A criterion stands in a later round only when a round's verify actually
recorded it `PASS`. No agent widens a round
or narrows one beyond what this rule gives, and no phase the round's plan lists is skipped.

**The single-reviewer plan (`phases=reviewer`).** One reviewer, no spec, env, verify, refute or merge
phase. Setup and the context bundle are as always (`00-diff.patch`, `00-context.md`,
`00-focus.md`), and the ticket's instructions and acceptance criteria in `00-context.md` stand in for
a spec: there is no `01-spec.md`, `02-verification.md`, `04-verdicts.md` or `05-merge.md`, and the only
environment file is the small `00-env.md` the run writes (below).
There is no env phase, so **the run itself prepares the worktree** before it spawns the reviewer, as
Phase 1b does for a hunt: install or reuse the dependencies inside the worktree (a prepared
`node_modules` copied by hardlink with `cp -al` into a real directory, never a symlink or a junction, or
the project's own install), and write a small `00-env.md` with the test command that runs from the
worktree (the project's own, from its runbook or scripts), the repo's `Test slots:` folders when `slots=`
was given, and `Servers: none started`. Spawn one `feature-review-hunt` agent (the Team agent the hunt phase names in the
project's workflow, `agents=`: by default the project's agent named `hunt`, else the built-in role) with prefix `_frh_`, what every agent prompt includes (Setup: `projectId`, `ticketId`, the full
40-character head SHA, the round, the browser flag and the absolute path of its run-report template
among them), the context pack, the focus, the diff, the checklists and
`00-env.md`, and tell it the test slots' rule (a heavy run, such as an end-to-end spec, takes the first
free slot and releases it right after; a targeted unit test or probe takes none). It runs only targeted
tests and probes from the worktree. Starting a server is the reviewer's own call, only when reproducing
a finding needs one: it starts it itself on a free port, from the worktree, calls only that port, and
stops it by the PID it recorded before it returns (this replaces the hunt agent's rule that it never
starts a server, for this plan only). Its candidates (`03-candidates.md`) are the findings: `confirmed`
only when it reproduced one by execution, else `plausible`. The report is `review.md` in the same
shape with these differences: the Freshness block says `Hunts: one`, `Refutation: none (single
reviewer)` and names the plan; the verdict is `DO NOT SHIP` for a confirmed `major`, `SHIP AFTER
FIXES` for a confirmed `medium` or `minor` or a plausible `major`, else `SHIP` (never `COULD NOT VERIFY`); the
acceptance criteria table is left out (the caller's evidence covers them); and the summary's three
checks each read `not run: single-reviewer plan`.

## Setup

1. `MAIN` = the repo path. `SLUG` = `<repo-dir-name>-<target>` (e.g. `myapp-pr-123`,
   `webapp-diff`), and `<repo-dir-name>-<target>-<AGENT_TAG>` when `agent=<prefix>` was given
   (`AGENT_TAG` = the prefix's last segment, e.g. `myapp-feature-x-review-second`): two runs of one
   target under different prefixes never share a folder, a claim or a worktree, so they may run at once
   or one after the other and neither removes the other's files. `WORKDIR` = `~/.claude/feature-review/<SLUG>/` (resolve `~` with
   `echo ~`). `WORKTREE` = `WORKDIR/wt`.
   **Claim before you clean.** Another session may be reviewing the same target. A claim
   is live when `WORKDIR/CLAIM.md` exists, is less than 6 hours old, and
   `~/.claude/feature-review/ledger.jsonl` has no entry for this target (and this `agent`, when
   `agent=` was given) written after the claim (a finished review that forgot to remove its claim is not live). When the
   claim is not live and `WORKDIR/LEFTOVER.md` exists, an earlier review of this target
   could not remove its worktree for a git lock (Teardown step 2): remove `WORKTREE` now as
   Teardown step 2 does, then delete `LEFTOVER.md`; still locked, stop with the error
   "git lock on MAIN: <path>". If the claim
   is live, or `git -C MAIN worktree list` already registers `WORKTREE`, stop with the
   error "review of <target> already in flight (see WORKDIR/CLAIM.md)" and do nothing else. Otherwise remove and recreate `WORKDIR`
   (in a round after the first, copy `WORKDIR/01-spec.md` aside first and put it back into the new
   `WORKDIR`: round 1's spec, with the criteria appended since, is the spec of every later round;
   and first note from the old `WORKDIR/02-verification.md` every criterion whose result is not
   `PASS`, for the spec's **Not yet passed** list, Phase 1)
   and write `WORKDIR/CLAIM.md` with the target, the start time, and the session or
   runner identity. Teardown deletes the claim file last.
2. Resolve the **commit under review** and the **base**. Run every `git fetch` here and
   in the agents with `GIT_TERMINAL_PROMPT=0` and a timeout of about two minutes: an
   HTTPS remote can otherwise hang on a credential-manager prompt nobody will answer. If
   a fetch fails that way, retry with a one-off token helper on the command itself:
   `git -c credential.helper= -c "credential.helper=!f(){ echo username=x; echo password=$(gh auth token); }; f" fetch ...`
   (`gh auth setup-git` only helps when gh's own protocol is https).
   Other sessions may be running git on the same checkout (other reviews, a builder's worktree).
   A git command on `MAIN` here and in the agents (`fetch`, `worktree add`, `worktree remove`)
   that fails on another one's lock (`Unable to create '<path>.lock': File exists`, `cannot lock
   ref`, `Another git process seems to be running`) waits about 15 seconds and runs again, up to
   5 times. Never delete the `.lock` file: a git process that is still running holds it. A lock
   error is never a finding or a failed criterion. Still locked after 5 tries: in the merge
   check, its result is `UNVERIFIED (git lock on MAIN)`; in Teardown, see Teardown step 2; in
   Setup, first undo what this run made so that running it again is not "already in flight"
   (if `git -C MAIN worktree list` registers `WORKTREE`, remove it as Teardown step 2 does;
   then delete `WORKDIR/CLAIM.md`, last), then stop with the error "git lock on MAIN: <path>".
   - a PR number: `gh pr view N --json title,body,baseRefName,headRefName,headRefOid,isDraft,mergeable,url`
     run from `MAIN`. Then `git -C MAIN fetch origin pull/N/head` and confirm
     `git -C MAIN rev-parse FETCH_HEAD` equals `headRefOid`; if not, fetch again.
     Commit = `FETCH_HEAD`. Base = `origin/<baseRefName>` after `git -C MAIN fetch origin <baseRefName>`.
   - a branch name: `git -C MAIN fetch origin <branch>`; commit = `origin/<branch>` if it
     exists, else the local branch. Base = the default branch's remote ref.
   - `diff`, `staged`, or a path: commit = `HEAD` of `MAIN`, plus the working changes
     applied in step 3. Base = `HEAD`. (`staged` applies only the index.)
   - empty: if `MAIN` is on a non-default branch, treat it as that branch name; otherwise
     ask: "What should I review? A PR number, a branch, `diff`, `staged`, or a path."
3. Create the worktree: `git -C MAIN worktree add --detach WORKTREE <commit>`. For
   `diff`/`staged`/path targets, apply the working changes into it:
   `git -C MAIN diff HEAD > WORKDIR/00-working.patch` (or `--cached`), then
   `git -C WORKTREE apply WORKDIR/00-working.patch`, and copy untracked files listed by
   `git -C MAIN ls-files --others --exclude-standard`. Record the commit SHA.
4. Write the **context bundle** into `WORKDIR`:
   - `00-diff.patch`: `git -C WORKTREE diff <merge-base of base and commit> <commit>`
     (three-dot semantics, the same diff GitHub shows), plus the working patch if any.
     For a path target, the folder's file list and contents.
   - In a round after the first (`round=` above 1), `00-diff.patch` is instead the **fix diff**,
     `git -C WORKTREE diff <last reviewed sha> <commit>`, and the full diff above goes to
     `00-diff-full.patch` for reference. `<last reviewed sha>` is the commit the previous round
     reviewed: the `sha` of the newest line of `~/.claude/feature-review/ledger.jsonl` for this
     target (and this `agent=`, when given) with a round below this one. Round 1 has only the full
     diff, as `00-diff.patch`.
   - `00-context.md`: PR title, body and URL, commit messages since the merge base, any
     ticket text the user pasted, and the full contents of the project's rule files if
     present in the worktree (`CLAUDE.md`, `.claude/rules/*`, `CONTRIBUTING.md`, `AGENTS.md`).
     It is the review's **context pack**, the one context file every phase reads; the spec
     phase extends it with the changed files, their tests, their direct callers, the decisions
     and their answers, and the runbook.
   - When the review is on a board ticket (`ticket=<id>`): `get_ticket` and append its context
     above: its instructions, the human's posts and replies (each thread with `list_comments`),
     the decisions and their answers, and its attachments (their local `path`s). Every phase
     agent reads it there; one may also read the ticket itself.
   - `00-focus.md`, one path per line with a few words on why: the changed files
     (`git -C WORKTREE diff --name-only <merge-base> <commit>`, the same range as
     `00-diff.patch`, plus the working patch's files and the untracked files copied in step 3;
     for a path target, the folder's files); the tests of those files (the changed test files,
     and files named after a changed module, e.g. `foo.test.ts`, `test_foo.py`, found with
     `git ls-files`); their direct callers (`git grep -l` for each changed module's import path,
     or for a text file its file name, run once per file, not recursively; cap it near 30 and
     say when capped).
5. With `build=`, read the caller's **build record** and pass its path to the env agent: the
   caller built this change once at a head and wrote the SHA, the `.output-e2e` path and the
   ISO time. The env agent compares its SHA with the commit under review; at the same SHA it
   copies the artifact into the review worktree with `cp -al` and records `E2E_SKIP_BUILD=1`,
   so verify's end-to-end run reuses that one build. A different SHA is stale: the record is
   ignored and the env agent builds once at this commit. Nothing is reused across heads.
6. The skill's own files are in `${CLAUDE_SKILL_DIR}`. Agents receive absolute paths to
   `${CLAUDE_SKILL_DIR}/checklists.md` and `${CLAUDE_SKILL_DIR}/report-template.md`.
7. `NOTES` = `~/.claude/feature-review/notes/<repo-dir-name>.md`, the per-repo memory of
   environment facts earlier reviews learned on this machine (what is installed, which
   ports are taken, runbook corrections). Pass its path to the spec and env agents whether
   or not it exists yet; the env agent appends to it.

Every agent prompt from here on includes: `MAIN`, `WORKTREE`, `WORKDIR`, `SLUG`, `projectId`
and `ticketId` (on a board ticket), the full 40-character head SHA (`git -C WORKTREE rev-parse
HEAD`, never a short one), the review round (`ROUND`), the browser flag, the absolute path of the
phase's run-report template (`run-reports/<agent>.md` in the installed review bundle, e.g.
`~/.claude/run-reports/verify.md` resolved to a full path), `00-diff.patch` as the round's diff (the
fix diff in a round after the first, with the absolute path of `00-diff-full.patch` for reference),
the absolute paths of the files it reads and writes, `00-context.md` as the context pack (every
phase reads it: spec, env, verify, hunt, refute and merge), the `SLOTS` directory when `slots=`
was given (its record is the `Test slots:` line in `00-env.md`), the repo id (`repoId`) the slot
folders are named with, the ticket id (`TICKET`) when
the review is on a ticket — every phase that takes a test slot writes it in its `holder.txt` —
the review round (`ROUND`, from `round=`, 1 when not given), the full text of the contract,
and the path of
`00-focus.md` with this rule: start from it; read outside it only to follow a reference from it.
With `scoped`, it also includes the word `scoped`. Agents treat `WORKTREE` as the repo root.

## Phase 1: Spec (1 agent; token `spec`)

The spec is written once, in round 1. In a round after the first no spec agent is spawned (the
plan has no `spec` token); `01-spec.md` is round 1's, carried over (Setup step 1), and **you, the
orchestrator, extend it** before the round's phases start: append one acceptance criterion per
finding the fix pass fixed (its claim turned into the observable outcome that shows it is fixed,
source `finding C<n>, round <n-1>`, method the one that reproduced it), and apply every decision the
human answered on the ticket since (`get_ticket`: the decided option rewrites the criterion or the
open question it settles). Then write the spec's **Not yet passed** list anew: every earlier
criterion that no round's verify has recorded `PASS` (the ones on the list before, less those the
previous round's `02-verification.md` records `PASS`, plus those it ran and records anything but
plain `PASS` (`PASS (traced)`, `FAIL`, `FAIL (traced)`, `UNVERIFIED`), noted in Setup step 1; `none`
when every one was passed). A criterion leaves the list
only when a round's verify passes it, so a `FAIL` whose candidate refute refuted stays on it. No
agent edits the spec after round 1.

Spawn `feature-review-spec` with paths to `00-diff.patch`, `00-context.md`, `00-focus.md`, and
the output path `01-spec.md`. It writes what it establishes — the changed files, their tests,
their direct callers, the decisions and their answers, and the runbook — back into
`00-context.md`, so it is the pack the later phases read. Wait for it.

Read `01-spec.md`. If its **Open questions** section contains a question whose answer
changes what counts as *correct* (not merely nice to know), that question is decisive. In an
interactive session, ask the user that one question with AskUserQuestion, offering the
interpretations as options. An unattended run (the runner, a todo-review run, or any run with
no human to ask) never asks in the chat: it continues with the assumption the spec states, and
step 3 puts the question on the ticket's card for the human. If the question is not decisive,
or the user is not available, continue with the assumption the spec states. Do not ask about
anything else.

## Strategy by kind

The spec's classification picks the work. A change with several classes takes the union.

| Classification | Env starts at most | Verify methods | Hunt's checklist sections |
|---|---|---|---|
| `api-endpoint`, `auth` | data services, the app | tests, `run+http` | the class, Security, Reliability |
| `ui` | data services, the app, the frontend | tests, `browser` | `ui`, Security, Reliability |
| `data-model`, `background-job` | the data services it uses | tests, a migration or one job run | the class, Security, Reliability |
| `llm-prompt` | the app when a criterion calls it | tests, before/after outputs | `llm-prompt`, Security, Reliability |
| `config-infra`, `dependency`, `refactor`, `cli-script` | the install; the app only to prove it starts | tests, the build, the script | the class, Security, Reliability |
| `instructions` | the app only when it serves the text | the text read where its reader gets it, quoted | `instructions` (its check 5 is the safety check) |

Every hunt also applies Diff guard analysis and the Project overlay.

## Phase 1b: Environment (1 agent; token `env`)

Spawn `feature-review-env` with `01-spec.md`, `00-context.md`, `00-focus.md`, `NOTES`, the port
range, the browser flag, `FRONTEND` if given, the build record's path when `build=` was given,
the `slots=` directory when it was given, the repo id (`repoId`) the slot folders are named with,
the services the strategy table allows, and the output path
`00-env.md`, with this rule: start only what the criteria's methods need: no app server when no
criterion uses `run+http` or `browser`, no frontend when none uses `browser`. Wait for it. It
installs or reuses dependencies inside the worktree (a prepared `node_modules` copied by hardlink
with `cp -al` into a real directory, never a symlink or a junction), proves imports resolve to
the worktree,
allocates free ports, starts those services in the background (review-owned instances on remapped
ports when the developer's are in the way) and the seed, records PIDs and logs under `WORKDIR`,
and lists what is unavailable and why. When the build record's SHA is the commit under review it
copies that `.output-e2e` into the worktree and records `E2E_SKIP_BUILD=1`; a different SHA is
ignored and it builds once. It records the repo's test slot folders and N in `00-env.md` too, and
marks which of its scoped commands are heavy.

A delta round has no env phase: the run prepares the worktree itself and writes the small
`00-env.md` as the single-reviewer plan does (**The plan**), plus the **Scoped checks** section its
verify and its merge check run from, written as the env agent writes it: the typecheck, lint and
format, migration, related unit test and end-to-end commands on the changed files, which of them are
heavy, and the `CI:` line, taken from the runbook in the carried-over `01-spec.md` or else from the
project's own scripts. When `build=` was given and the build record's SHA is the commit under review,
the run copies that `.output-e2e` into the worktree and records `E2E_SKIP_BUILD=1` there, as the env
agent does. When a criterion verify must run
in it needs a server (`run+http`, `browser`), the run starts that server as the env agent would: from
the worktree, on a free port from the range, its PID and log recorded in `00-env.md` and stopped at
Teardown.

Read `00-env.md`. If nothing could be started, continue: the verify agent will record
runtime criteria as `UNVERIFIED` and the hunt still runs on the code. Where an env phase ran, do
not start anything yourself (the server of a delta round, above, is the one thing the run starts),
and never reuse anything that was already running.

## Phase 2: Verify and the hunts (in parallel; tokens `verify`, `hunt`, `hunt-security`)

Spawn in a single message one agent per token of the plan (the standard plan: three):

| Agent | Temp-file prefix | Output |
|---|---|---|
| `feature-review-verify` | `_frv_` | `02-verification.md` |
| `feature-review-hunt` | `_frh_` | `03-candidates.md`, `03-hunt-notes.md` |
| `feature-review-hunt` (second, independent instance) | `_frh2_` | `03-candidates-b.md`, `03-hunt-notes-b.md` |
| `feature-review-hunt` (a third instance, for each `hunt-security` token: checklist sections the Security one only) | `_frh3_` | `03-candidates-c.md`, `03-hunt-notes-c.md` |

Each prompt includes paths to `01-spec.md`, `00-env.md`, `00-diff.patch`, `00-context.md`,
`00-focus.md`, `checklists.md`, its output paths, the `SLOTS` directory when `slots=` was given,
the repo id (`repoId`) the slot folders are named with,
and the browser flag; the hunt's also names its
checklist sections from the strategy table. Agents use the test command, interpreter, and base
URLs from `00-env.md` and start no servers of their own. Verify runs the scoped checks from
`00-env.md`, once: the only run at head. They cover what the change affects: the whole
project's typecheck, lint and format on the changed files, the unit tests related to them, and the
end-to-end specs covering the changed pages or routes. The full suite runs in CI on the pull
request; where no CI runs it (`CI: none` in `00-env.md`), verify runs the full suite locally
instead, unless `scoped` was given (the caller then runs it once at the final head). The hunt runs only targeted tests (the focus file's tests, or a probe for
one candidate), never the full suite.
Only the heavy runs take a test slot, from the exact `Test slots:` folders in `00-env.md` (or
the `SLOTS` folder and repo id the prompt gives): verify takes the first
free one right before the end-to-end run and before the full suite, and releases it right after
each; a full suite takes the `-full` folder first and waits until every slot is free. Its
typecheck, lint, format, migration check and scoped unit run take none, and neither do the hunt's
and refute's targeted unit tests and probes; a targeted end-to-end spec is heavy like any
end-to-end run, so it takes a slot the same way, released right after it. With `E2E_SKIP_BUILD=1`
in `00-env.md`, verify's end-to-end command reuses the caller's build instead of building again.

**In a delta round** (`delta`) the plan has one verify and one hunt. Verify runs only the acceptance
criteria of the findings the fix pass fixed (the ones appended to `01-spec.md` for this round,
Phase 1) and the scoped checks; a criterion it does not run stands only because an earlier round's
verify recorded it `PASS`.
The one hunt reviews the fix diff (`00-diff.patch`, `<last reviewed sha>..HEAD`) only, with the
checklist sections the strategy table gives; code outside that diff is out of its scope.

Wait for all. Then build the refutation input, `03-all-candidates.md`:
- every candidate from `03-candidates.md` (and `03-candidates-b.md` and `03-candidates-c.md` when the
  plan ran those hunts, de-duplicated by location and claim; keep a private note of which hunt found which,
  the refute agent must not see it);
- every `FAIL` row from `02-verification.md`, rewritten as a candidate in the same format;
- **nothing from the hunt notes files.** The refute agent never sees hunt reasoning.

Renumber candidates C1..Cn.

**Every hunt the plan lists runs.** Each `hunt` token is its own hunt, in parallel with verify and
never sharing notes with another, whatever the depth: a clean hunt is no reason to run one hunt fewer,
and `light` does not drop one. A missed blocker costs far more than twenty minutes. Merge their
candidates as above. Every phase the round's plan lists runs (round 1 every phase, a later round every
phase but the spec, a delta round only what **Rounds after the first** gives); none is skipped because
the findings look obvious, the change looks small or a finding was already reproduced, no round is
widened or narrowed beyond what that rule gives, and each phase posts its result, so a skipped phase
is visible.

## Phase 3: Refute (1 agent; token `refute`)

When the plan lists it, refute always runs, also when `03-all-candidates.md` has no candidate at all: it then verifies that
nothing is left to refute and records that.

Spawn `feature-review-refute` with temp-file prefix `_frr_` and paths to `01-spec.md`,
`00-env.md`, `00-diff.patch`, `00-context.md`, `00-focus.md`, `02-verification.md`,
`03-all-candidates.md`, and
the output path `04-verdicts.md`. Like the hunt, it runs only targeted tests, never the full
suite, and those targeted unit tests and probes take no test slot; a targeted end-to-end spec is
heavy like any end-to-end run and takes one. Wait for it.

Its verdict table in `04-verdicts.md` is where you read each finding's severity: the Severity
column gives every `CONFIRMED` and `PLAUSIBLE` candidate one of `major`, `medium` or `minor`, from
the scale in the refute agent's file. Those levels, and its Root cause column, decide the next
round (**Rounds after the first**) and are what the caller reads from this run.

## Phase 3b: Merge check (1 agent; token `merge`)

Runs after every other agent has finished, because it temporarily changes the worktree.

**First, the base check, yourself.** The merge agent is spawned only when the base moved. Fetch the
base (`GIT_TERMINAL_PROMPT=0 git -C MAIN fetch origin <base>`, as in Setup), then run
`git -C WORKTREE merge-base --is-ancestor origin/<base> HEAD`, in any round, round 1 included:
- **It passes** (exit 0): the base is already in the head, so nothing can conflict and nothing new
  can fail. Spawn no merge agent. Write `05-merge.md` with `Result: NO ISSUE (base unchanged)`, the
  command, its exit code and `origin/<base>`'s SHA, and record the round's merge as skipped with the
  literal `base unchanged` (**On the board**, step 6).
- **It fails** (exit 1): the base moved. Spawn the merge agent as below.

Spawn `feature-review-merge` with `HEAD_SHA`, the base branch name, the `SLOTS` directory when
`slots=` was given, the repo id (`repoId`) the slot folders are named with, and paths to
`00-env.md`, `00-context.md`, `00-focus.md`, `02-verification.md`, and the output path
`05-merge.md`. It runs the
scoped checks once, on the merged tree, over the files both the branch and the base changed since
the merge base plus the branch's own: that scoped run is the merge check, and CI on the merged PR
covers the rest (the full suite instead, where no CI runs it and `scoped` was not given). Its
heavy part — the build, the end-to-end run, and the full suite where no CI runs it — takes the
repo's first free test slot from `slots=` (the `-full` folder first for a full suite); its
typecheck, lint
and scoped unit runs take none. Because it merged the base, it never reuses the caller's build
record, `E2E_SKIP_BUILD=1` or not: it builds once on the merged tree in a slot and runs the
end-to-end tests against that build, since the head's artifact never shows what the merge broke.
It builds the merged tree once: it runs the recorded end-to-end command with its inline
`E2E_SKIP_BUILD=1` removed, so the command's own build step builds the merged tree into
`.output-e2e`; when the recorded command has no build step, it builds once with
`BOARD_BUILD_DIR=.output-e2e pnpm build` (or the project's equivalent) and runs it with the flag.
Never with the flag on the merged tree, and never two builds. A scoped run that
finds the `-full` folder releases its slot and waits for the full suite, as the gate does.
Wait for
it. Read its `Result` line and its `Worktree restored` line; if the worktree was not restored,
run `git -C WORKTREE reset --hard <commit>` yourself before continuing. For `diff`,
`staged`, and path targets the base is `HEAD`, so the result is `NO ISSUE (up to date)`
without spawning the agent.

## Phase 4: Report

1. Re-query freshness. For a PR target, run `gh pr view N --json headRefOid` again. If
   it differs from the reviewed commit, the review is **STALE**: prefix the verdict line
   with `STALE (PR moved to <sha>)` and do not post.
2. Assemble `review.md` in `WORKDIR` following `report-template.md`:
   - The **Freshness** block: commit reviewed, PR head at start and at end, worktree
     path, environment summary from `00-env.md` (reused or fresh dependencies, the caller's
     build reused at this head with `E2E_SKIP_BUILD=1` or a build here, services
     up, services unavailable).
   - The Freshness block's `Hunts` line says how many hunts the plan ran (`two` for the standard plan, `three` with a security hunt, `one` for the single reviewer), and a `Plan` line says which phases ran and where the plan came from: the `phases=` argument, the ticket's workflow, or "no workflow: the six standard phases".
   - Findings are the candidates with verdict `CONFIRMED` or `PLAUSIBLE` in
     `04-verdicts.md`, using the refute agent's final severity (`major`, `medium` or `minor`). In deep mode add
     `Stability: both hunts` or `one hunt` to each (of the hunts that ran).
   - Verdict line: `DO NOT SHIP` if any confirmed `major`. `SHIP AFTER FIXES` if any
     confirmed `medium` or `minor`, or any plausible `major`. `COULD NOT VERIFY` if there are
     no findings and more than half the criteria are `UNVERIFIED`. Otherwise `SHIP` (a plausible
     `medium` or `minor` is reported and does not stop the ship). Every level these rules name is
     one the refute agent assigns.
   - *Checked and clean* comes from the checklist table in the hunt notes and the `PASS`
     rows of `02-verification.md`. Include the count of refuted candidates. It is the
     proof that the filter ran.
   - *Unverified* lists every criterion that could not be executed, with the reason
     from `00-env.md` or the verify agent.
   - *Open questions* comes from the spec plus every `DEPENDS ON INTENT` verdict.
   - *Base compatibility* is the `05-merge.md` content, verbatim; when no merge agent ran because
     the base was unchanged, it is the `NO ISSUE (base unchanged)` file Phase 3b wrote.
   - Optional notes from the hunt are **not** included. Mention their count and file
     path in the summary so the user can read them if they want.
3. Write `WORKDIR/summary.md` following `${CLAUDE_SKILL_DIR}/summary-template.md`. It is
   the one-page version a reader who will not open `review.md` sees, so it is short and
   plain. *What it does* comes from the spec's Intent. *How to test it* comes from the
   runbook and the commands the verify agent actually ran. *Findings* lists only
   confirmed and plausible findings, one bullet each, with why it matters. *Evidence*
   references the screenshots in `WORKDIR/shots/` if any. The three checks are decided by these rules, each with a
   one-line reason, conservative when something was not verified:
   | Check | YES when | otherwise NO, reason says |
   |---|---|---|
   | Is this reliable? | verdict is `SHIP` | the finding IDs, or "not verified: <reason>" |
   | Did you make sure this works and is running? | every acceptance criterion is `PASS` by execution, not traced (an `instructions` criterion read where its reader gets it and quoted is execution), and verify's test run (scoped, or full where no CI runs it) passed apart from pre-existing failures | which criteria are unverified or failed, and why |
   | Will this have any issue with the latest version of the base branch? | this one is inverted: **NO** when the merge check result is `NO ISSUE` (`NO ISSUE (up to date)` and `NO ISSUE (base unchanged)`, the merge skipped because the base was unchanged, included); **YES** for `CONFLICTS`, `TESTS FAIL AFTER MERGE`, or `UNVERIFIED` | the conflicting files, the new failures, or "not verified: <reason>" |
4. Append one line to `~/.claude/feature-review/ledger.jsonl`:
   `{"repo": "<origin url, or MAIN path if none>", "target": "<pr N | branch | diff>", "sha": "<commit>", "round": <ROUND>, "verdict": "<verdict>", "confirmed": n, "plausible": n, "refuted": n, "unverified": n, "merge": "<merge result>", "checks": {"reliable": "YES|NO", "works": "YES|NO", "base_issue": "YES|NO"}, "stale": bool, "path": "<WORKDIR>/review.md", "at": "<ISO timestamp>"}`, plus `"agent": "<the agent= prefix>"`
   when `agent=` was given: a line with an `agent` is that run's review only (its `path` is its own
   folder), never the review of the same target by a run with another prefix or none.
5. If `post` was given, the target is a PR, and the review is not stale:
   `gh pr comment N --body-file WORKDIR/review.md` from `MAIN`. Otherwise do not post.
   A single-review PDF can be built with
   `python ~/.claude/skills/review-queue/build_pdf.py --out WORKDIR/report.pdf WORKDIR/summary.md`.

## Teardown

Unless `keep` was given:
1. Run the teardown commands listed in `00-env.md` (kill the recorded PIDs, bring down
   the review's compose project, remove the frontend worktree if one was created). Never
   stop a process or container the review did not start.
2. `git -C MAIN worktree remove --force WORKTREE` (a lock error is retried as in Setup). On
   Windows this can report "Filename too long" on a `.venv` or `node_modules` and leave the
   directory behind after deregistering it; if `WORKTREE` still exists, clear it with
   `robocopy <empty dir> WORKTREE /MIR` followed by `rmdir`, or PowerShell
   `Remove-Item -Recurse -Force`. Do **not** run `git worktree prune`: other sessions may
   have worktrees registered on the same checkout. Still locked after the retries: write
   `WORKDIR/LEFTOVER.md` with `WORKTREE` and the lock file's path, say so in what you print,
   and go on with steps 3 and 4. The next review of this target removes it (Setup step 1);
   until then `git worktree list` shows it.
3. Confirm `git -C MAIN status --porcelain` is unchanged from before the review.
4. Delete `WORKDIR/CLAIM.md`.

Leave `WORKDIR` and its other files in place. Print to the user: the verdict line, the three
checks, the counts (confirmed / plausible / refuted / criteria passed / unverified), the
commit SHA, and the paths to `review.md` and `summary.md`.

## On the board

When the board's MCP tools are available (`get_project`, `post_update`, …) and the repo belongs to
a board project, the review also runs **on the board**. Find the ticket: `ticket=<id>` when given,
else, for a PR, the `ticket` that `list_prs` names for it (the feature ticket that names the PR, or
the PR's own ticket), else the ticket whose `branch` is the target branch. `get_ticket` it before
the phases: its instructions, the human's posts and replies, the decisions and their answers and
its attachments are the review's context (Setup step 4), not just what finds it. No ticket: run as
usual and skip this section.

Where posts go: a ticket's feed has two tabs. Agents is the agents' working record: every phase
post and the review's result post below go there (posted `as` an agent or as progress, the board
puts them there). Main is the human's and stays short and to the point: their posts, decision
cards, questions to them, and the ticket's summary on top. The review never writes the summary
and never posts a new hand-off: whoever hands the ticket off rewrites the summary
(`set_ticket_summary`) with the review's verdict in one line. When the human posted on the ticket
and the review answers them, it replies under their post, never with a new top-level post: the
plan first, then the result with its proofs.

1. **The project's agents brief the phases.** `get_project` → `agents`. For each phase, the agent is the
   one `agents=` names at the phase's place in `phases=` (an `agents=` given in the call, else the one the
   ticket's workflow gave with the plan, **The plan** rule 2); with neither, the project's agent named
   like the phase (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`, `intent`). When the project has
   that agent and it has instructions, spawn a general-purpose subagent whose prompt is that agent's `instructions`
   followed by everything this skill gives the phase (paths, the contract, its inputs). The human
   edits those on the board, so they win over the `feature-review-*` agent files; a phase with no
   such agent uses its agent file as before.
2. **Each phase reports on the ticket as its agent**: `post_update` with `as: <agent name>` (the Team
   agent that briefed the phase when it is one of the project's agents, else no `as`) and
   `progress: true`, a few lines (what it established, counts, anything unavailable) and its
   evidence in `files` (screenshots from `WORKDIR/shots/`, the phase's own file). Never paste
   hunt notes; the refute phase's verdict table is the findings' record. These posts go to the
   ticket's Agents tab, the agents' working record, out of the human's way: a phase never writes
   to Main (no summary, no new top-level post for the human), and the ticket's summary is the
   job of whoever hands the ticket off. Every phase agent also fills in its run report with
   `write_run_report` before it hands back: one report per run, from its own template,
   `run-reports/<agent>.md` in this skill's bundle. Put that in its brief. Each phase agent's span
   (`start_span`, with the phase's agent name and `round`) and its report carry `ROUND`: the board
   counts a phase only when its span or report carries the round and the last segment of its agent
   name names the phase. When a phase agent cannot reach the board tools, the orchestrator of the
   review records the span with the phase agent's name and the round.
3. **Decisive open questions** from the spec go to the human with `ask_decision` on the ticket (the
   interpretations as options, the spec's assumption marked recommended). If Phase 1 already asked
   the human this question in the chat, step 3 never asks it again, whatever the human did. If they
   answered with one of the options, this session records that answer on the card with
   `answer_decision`, with the option they picked and their words as they gave them. If they did not
   answer, or their answer matches none of the options, the card stays open for the human on the
   board. Only when Phase 1 did not ask the question, and the session is interactive, ask the human
   in the chat with AskUserQuestion, with the same options, and record their answer on the card the
   same way. The AskUserQuestion step applies only in an interactive session. An unattended run (the
   runner, a todo-review run, or any run with no human to ask) never asks in the chat and never
   relays a decision: it leaves the card open for the human. A phase never answers a decision
   (`answer_decision`), not even one you run inline. Finish the read-only phases with the
   assumption, marked unconfirmed in the report; the card stays open, and the caller (a ticket
   agent) blocks its ticket and ends its work on it rather than building on that guess.
4. **The result** goes to the board. For a PR: `post_review_result` (the verdict, `summary.md` as
   `summaryMd`, the commit SHA, the three checks and the counts, `repoId` when the project has
   several repos), which also posts the summary on the PR's ticket. For a branch with no PR yet: a `post_update` on the ticket with the verdict line
   and `summary.md` (it goes to Agents; the verdict's one line goes in the ticket's summary when
   the ticket is handed off). Never post it to GitHub unless `post` was given.

5. **The intent check** is the phase after the last review round and before the ticket is handed
   off; the review itself never runs it, the orchestrator that hands the ticket off does (the
   todo-review skill's ticket agent). It runs on every ticket, of any complexity (low included, which
   has no review rounds), and again after any human comment that sent the ticket back. It runs the
   Team agent the intent step names in the project's workflow (`get_workflow`; by default the project's agent named `intent`, else the built-in `feature-review-intent`) at the effort its workflow step gives (`low` by default in every preset), whatever the ticket's complexity,
   and gives it only the human's own words and attachments (the ticket's instructions, every post
   and reply by the human, newest last, and the human's own answer on a decision card, the latest comment that sent the ticket back weighing most)
   and the result (the preview, the screenshots or recordings, the diff). It never gets the
   builder's plan, the spec, the review's findings or the options an agent put on a card, so it cannot inherit their reading. It returns
   one line per thing the human asked (`done as asked`, `done differently (how)` or `not done`, with
   the evidence) and a verdict, `matches` or `does not match`. `matches` hands off. When the ticket's workflow lists the intent step as skipped (a low ticket with the check
   turned off on the Workflow page), no check runs and none is required. `does not match`
   goes back to the builder with the intent check's lines as the brief, then the gate, then ONE more
   review round of the ticket's workflow, always a full round, never a delta round (numbering continues from the last round; a ticket whose
   workflow lists no review has only the gate), then the intent check again. A `does not match` is
   outside the complexity's round budget. After the SECOND `does not match` on one ticket, the ticket
   agent asks the human with `ask_decision` (keep going, ship as is, drop), with the intent check's
   lines and the human's words on the card. Earlier than that the human is asked only when two
   readings of their words are both plausible and give visibly different results, with both readings
   on the card (`ask_decision`).

6. **The round's records**, which the board's check of the review phases (`missingReviewPhases`)
   reads, written with the calls you already make, as yourself: `agent` left out (or your own name,
   never a phase's name, so no phase is credited and no run report is owed: the board leaves these
   records out of the runs it expects a report for, whatever your own name is), each a span you end
   at once:
   - a **delta round** (`delta`), before its phases start: `start_span` with `phase: "review"`,
     `round: <ROUND>`, `note: "delta round"`, then `end_span` on the `spanId` it returns. The board
     then expects one `verify` and one `hunt` in this round (two of each when the workflow reviews a
     round twice); in round 1 the record counts for nothing, and a later round without it is checked
     as a full round.
   - a **merge skipped because the base was unchanged** (Phase 3b): `start_span` with
     `phase: "merge"`, `round: <ROUND>`, `note: "base unchanged"`, then `end_span` on the `spanId`
     it returns. The board counts it as the round's merge check.

## Delegation

- Every phase brief carries the line "Never answer a decision (`answer_decision`): a question for
  the human goes into your result, or onto the card with `ask_decision`." The session that talks to
  the human answers the card, never a phase.
- Prefer delegation as written above. Phase agents run at one level below you, which
  is within the harness's nesting limit even when you are yourself a delegated agent.
- If the Agent tool is not available to you, run each phase yourself in order, following
  the corresponding agent definition in `~/.claude/agents/feature-review-*.md` verbatim
  and writing the same files. Before the refute phase, re-read only `01-spec.md`,
  `00-env.md`, and `03-all-candidates.md`, and state in the report's Freshness block that
  the refutation ran inline without blinding.
- With `effort=` given, pass it as `effort` on every phase agent's Agent call.
- The run follows its plan (**The plan**): spawn only the phases it lists, and all of them.
- Agents inherit the session model. Review quality depends on it, so do not downgrade
  the hunt or refute agents.
- If an agent fails, report the failure and produce the report from what succeeded.
  Record the missing phase under *Unverified*. Always run Teardown.
