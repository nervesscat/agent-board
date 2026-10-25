---
name: feature-review
description: "Reviews one feature or change for correctness, reliability and security using a spec -> env -> verify -> hunt -> refute protocol built to produce zero false positives. The code under review runs from its own worktree at the exact commit, on servers the review starts itself; every finding needs a concrete failure scenario and must survive an adversarial refutation pass; an empty result is valid and comes with proof of what was checked."
user-invocable: true
argument-hint: "[repo=<path>] [<PR number> | <branch> | diff | staged | <path>] [ticket=<id>] [deep] [light] [keep] [ports=<from>-<to>] [browser=yes|no] [post]"
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
| Severity | `blocker` (crash, data loss, security exposure, wrong result on the main path) or `bug` (wrong behavior on a real but secondary path). Nothing lower is reported. |
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

## Arguments

Parse `$ARGUMENTS` as space-separated tokens:

| Token | Meaning | Default |
|---|---|---|
| `repo=<path>` | the repository's main checkout | current working directory |
| a number | a GitHub PR | |
| a branch name, `diff`, `staged`, or a path | the change to review | see Setup |
| `deep` | run two independent hunts and report finding stability | off |
| `light` | for a tiny change: a clean first hunt gets no second hunt (Phase 2); every other phase runs as usual. Ignored when `deep` is given | off |
| `keep` | keep the worktree and servers after the report, for debugging | off |
| `ports=<from>-<to>` | range to allocate from when a default port is busy | `8100-8199` |
| `browser=yes\|no` | whether browser automation may be used | `yes` |
| `frontend=<path>` | main checkout of the UI repo that talks to this backend; the env agent starts its dev server against the review backend and the verify agent drives it | none |
| `post` | post the report as a PR comment when the target is a PR | off |
| `effort=<low\|medium\|high>` | the thinking effort of every phase agent, passed as the Agent tool's `effort`; a board cycle sets it from the ticket's complexity (`low` for low, `medium` for mid and high) | the session's |
| `ticket=<id>` | the board ticket this change belongs to: turns on **On the board** below | found from the PR's `ticket` in `list_prs` when the board is connected |

## Setup

1. `MAIN` = the repo path. `SLUG` = `<repo-dir-name>-<target>` (e.g. `myapp-pr-123`,
   `webapp-diff`). `WORKDIR` = `~/.claude/feature-review/<SLUG>/` (resolve `~` with
   `echo ~`). `WORKTREE` = `WORKDIR/wt`.
   **Claim before you clean.** Another session may be reviewing the same target. A claim
   is live when `WORKDIR/CLAIM.md` exists, is less than 6 hours old, and
   `~/.claude/feature-review/ledger.jsonl` has no entry for this target written after
   the claim (a finished review that forgot to remove its claim is not live). When the
   claim is not live and `WORKDIR/LEFTOVER.md` exists, an earlier review of this target
   could not remove its worktree for a git lock (Teardown step 2): remove `WORKTREE` now as
   Teardown step 2 does, then delete `LEFTOVER.md`; still locked, stop with the error
   "git lock on MAIN: <path>". If the claim
   is live, or `git -C MAIN worktree list` already registers `WORKTREE`, stop with the
   error "review of <target> already in flight (see WORKDIR/CLAIM.md)" and do nothing else. Otherwise remove and recreate `WORKDIR`
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
   - `00-context.md`: PR title, body and URL, commit messages since the merge base, any
     ticket text the user pasted, and the full contents of the project's rule files if
     present in the worktree (`CLAUDE.md`, `.claude/rules/*`, `CONTRIBUTING.md`, `AGENTS.md`).
   - `00-focus.md`, one path per line with a few words on why: the changed files
     (`git -C WORKTREE diff --name-only <merge-base> <commit>`, the same range as
     `00-diff.patch`, plus the working patch's files and the untracked files copied in step 3;
     for a path target, the folder's files); the tests of those files (the changed test files,
     and files named after a changed module, e.g. `foo.test.ts`, `test_foo.py`, found with
     `git ls-files`); their direct callers (`git grep -l` for each changed module's import path,
     or for a text file its file name, run once per file, not recursively; cap it near 30 and
     say when capped).
5. The skill's own files are in `${CLAUDE_SKILL_DIR}`. Agents receive absolute paths to
   `${CLAUDE_SKILL_DIR}/checklists.md` and `${CLAUDE_SKILL_DIR}/report-template.md`.
6. `NOTES` = `~/.claude/feature-review/notes/<repo-dir-name>.md`, the per-repo memory of
   environment facts earlier reviews learned on this machine (what is installed, which
   ports are taken, runbook corrections). Pass its path to the spec and env agents whether
   or not it exists yet; the env agent appends to it.

Every agent prompt from here on includes: `MAIN`, `WORKTREE`, `WORKDIR`, `SLUG`, the
absolute paths of the files it reads and writes, the full text of the contract, and the path of
`00-focus.md` with this rule: start from it; read outside it only to follow a reference from it.
Agents treat `WORKTREE` as the repo root.

## Phase 1: Spec (1 agent)

Spawn `feature-review-spec` with paths to `00-diff.patch`, `00-context.md`, `00-focus.md`, and
the output path `01-spec.md`. Wait for it.

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

## Phase 1b: Environment (1 agent)

Spawn `feature-review-env` with `01-spec.md`, `00-focus.md`, `NOTES`, the port range, the
browser flag, `FRONTEND` if given, the services the strategy table allows, and the output path
`00-env.md`, with this rule: start only what the criteria's methods need: no app server when no
criterion uses `run+http` or `browser`, no frontend when none uses `browser`. Wait for it. It
installs or reuses dependencies inside the worktree, proves imports resolve to the worktree,
allocates free ports, starts those services in the background (review-owned instances on remapped
ports when the developer's are in the way) and the seed, records PIDs and logs under `WORKDIR`,
and lists what is unavailable and why.

Read `00-env.md`. If nothing could be started, continue: the verify agent will record
runtime criteria as `UNVERIFIED` and the hunt still runs on the code. Do not start
anything yourself, and do not reuse anything that was already running.

## Phase 2: Verify and hunt (2 agents in parallel; 3 in deep mode)

Spawn in a single message:

| Agent | Temp-file prefix | Output |
|---|---|---|
| `feature-review-verify` | `_frv_` | `02-verification.md` |
| `feature-review-hunt` | `_frh_` | `03-candidates.md`, `03-hunt-notes.md` |
| `feature-review-hunt` (deep mode only, second instance) | `_frh2_` | `03-candidates-b.md`, `03-hunt-notes-b.md` |

Each prompt includes paths to `01-spec.md`, `00-env.md`, `00-diff.patch`, `00-context.md`,
`00-focus.md`, `checklists.md`, its output paths, and the browser flag; the hunt's also names its
checklist sections from the strategy table. Agents use the test command, interpreter, and base
URLs from `00-env.md` and start no servers of their own. Verify runs the full test suite, once:
the only run at head. The hunt runs only targeted tests (the focus file's tests, or a probe for
one candidate), never the full suite.

Wait for all. Then build the refutation input, `03-all-candidates.md`:
- every candidate from `03-candidates.md` (and `03-candidates-b.md` in deep mode,
  de-duplicated by location and claim; keep a private note of which hunt found which,
  the refute agent must not see it);
- every `FAIL` row from `02-verification.md`, rewritten as a candidate in the same format;
- **nothing from the hunt notes files.** The refute agent never sees hunt reasoning.

Renumber candidates C1..Cn.

**A clean first hunt is not trusted on its own.** If `03-candidates.md` says `None.` and
deep mode is off (and `light` was not given), spawn a second `feature-review-hunt` (prefix
`_frh2_`, outputs `03-candidates-b.md` and `03-hunt-notes-b.md`) with the same inputs plus this
sentence: "A first hunt found no candidates. Start from the guard analysis and the author's tests'
blind spots, not from the checklists." Merge as in deep mode. A missed blocker costs far
more than twenty minutes, and the second hunt is the only adversarial pass a clean
result gets. If both hunts are clean, skip Phase 3 and say in the report that two
independent hunts ran.

**Light mode** (`light` without `deep`) is for a change too small to need that second pass: the
second hunt is not spawned. Nothing else is dropped: the spec, the env, verify of every
acceptance criterion, refute of every hunt candidate and every verify `FAIL`, and the merge check
all run. Skip Phase 3 only when `03-all-candidates.md` has no candidate at all. The report never
says that two hunts ran: it says one hunt ran, in light mode (Phase 4).

## Phase 3: Refute (1 agent)

Spawn `feature-review-refute` with temp-file prefix `_frr_` and paths to `01-spec.md`,
`00-env.md`, `00-diff.patch`, `00-focus.md`, `02-verification.md`, `03-all-candidates.md`, and
the output path `04-verdicts.md`. Like the hunt, it runs only targeted tests, never the full
suite. Wait for it.

## Phase 3b: Merge check (1 agent)

Runs after every other agent has finished, because it temporarily changes the worktree.
Spawn `feature-review-merge` with `HEAD_SHA`, the base branch name, and paths to
`00-env.md`, `00-focus.md`, `02-verification.md`, and the output path `05-merge.md`. It runs the
full suite once, on the merged tree. Wait for it. Read
its `Result` line and its `Worktree restored` line; if the worktree was not restored,
run `git -C WORKTREE reset --hard <commit>` yourself before continuing. For `diff`,
`staged`, and path targets the base is `HEAD`, so the result is `NO ISSUE (up to date)`
without spawning the agent.

## Phase 4: Report

1. Re-query freshness. For a PR target, run `gh pr view N --json headRefOid` again. If
   it differs from the reviewed commit, the review is **STALE**: prefix the verdict line
   with `STALE (PR moved to <sha>)` and do not post.
2. Assemble `review.md` in `WORKDIR` following `report-template.md`:
   - The **Freshness** block: commit reviewed, PR head at start and at end, worktree
     path, environment summary from `00-env.md` (reused or fresh dependencies, services
     up, services unavailable).
   - In light mode the Freshness block's `Hunts` line says `one (light mode: no second hunt)`.
   - Findings are the candidates with verdict `CONFIRMED` or `PLAUSIBLE` in
     `04-verdicts.md`, using the refute agent's final severity. In deep mode add
     `Stability: both hunts` or `one hunt` to each.
   - Verdict line: `DO NOT SHIP` if any confirmed blocker. `SHIP AFTER FIXES` if any
     confirmed bug or any plausible blocker. `COULD NOT VERIFY` if there are no findings
     and more than half the criteria are `UNVERIFIED`. Otherwise `SHIP`.
   - *Checked and clean* comes from the checklist table in the hunt notes and the `PASS`
     rows of `02-verification.md`. Include the count of refuted candidates. It is the
     proof that the filter ran.
   - *Unverified* lists every criterion that could not be executed, with the reason
     from `00-env.md` or the verify agent.
   - *Open questions* comes from the spec plus every `DEPENDS ON INTENT` verdict.
   - *Base compatibility* is the `05-merge.md` content, verbatim.
   - Optional notes from the hunt are **not** included. Mention their count and file
     path in the summary so the user can read them if they want.
3. Write `WORKDIR/summary.md` following `${CLAUDE_SKILL_DIR}/summary-template.md`. It is
   the one-page version a reader who will not open `review.md` sees, so it is short and
   plain. *What it does* comes from the spec's Intent. *How to test it* comes from the
   runbook and the commands the verify agent actually ran. *Findings* lists only
   confirmed and plausible findings, one bullet each, with why it matters. *Evidence*
   references the screenshots in `WORKDIR/shots/` if any. In light mode *Findings* ends with
   "One hunt ran (light mode)." The three checks are decided by these rules, each with a
   one-line reason, conservative when something was not verified:
   | Check | YES when | otherwise NO, reason says |
   |---|---|---|
   | Is this reliable? | verdict is `SHIP` | the finding IDs, or "not verified: <reason>" |
   | Did you make sure this works and is running? | every acceptance criterion is `PASS` by execution, not traced (an `instructions` criterion read where its reader gets it and quoted is execution), and the test suite ran and passed apart from pre-existing failures | which criteria are unverified or failed, and why |
   | Will this have any issue with the latest version of the base branch? | this one is inverted: **NO** when the merge check result is `NO ISSUE`; **YES** for `CONFLICTS`, `TESTS FAIL AFTER MERGE`, or `UNVERIFIED` | the conflicting files, the new failures, or "not verified: <reason>" |
4. Append one line to `~/.claude/feature-review/ledger.jsonl`:
   `{"repo": "<origin url, or MAIN path if none>", "target": "<pr N | branch | diff>", "sha": "<commit>", "verdict": "<verdict>", "confirmed": n, "plausible": n, "refuted": n, "unverified": n, "merge": "<merge result>", "checks": {"reliable": "YES|NO", "works": "YES|NO", "base_issue": "YES|NO"}, "stale": bool, "path": "<WORKDIR>/review.md", "at": "<ISO timestamp>"}`
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
the PR's own ticket), else the ticket whose `branch` is the target branch. No ticket: run as usual
and skip this section.

Where posts go: a ticket's feed has two tabs. Agents is the agents' working record: every phase
post and the review's result post below go there (posted `as` an agent or as progress, the board
puts them there). Main is the human's and stays short and to the point: their posts, decision
cards, questions to them, and the ticket's summary on top. The review never writes the summary
and never posts a new hand-off: whoever hands the ticket off rewrites the summary
(`set_ticket_summary`) with the review's verdict in one line. When the human posted on the ticket
and the review answers them, it replies under their post, never with a new top-level post: the
plan first, then the result with its proofs.

1. **The project's agents brief the phases.** `get_project` → `agents`. For each phase, when the
   project has an agent with that name (`spec`, `env`, `verify`, `hunt`, `refute`, `merge`)
   and instructions, spawn a general-purpose subagent whose prompt is that agent's `instructions`
   followed by everything this skill gives the phase (paths, the contract, its inputs). The human
   edits those on the board, so they win over the `feature-review-*` agent files; a phase with no
   such agent uses its agent file as before.
2. **Each phase reports on the ticket as its agent**: `post_update` with `as: <agent name>` and
   `progress: true`, a few lines (what it established, counts, anything unavailable) and its
   evidence in `files` (screenshots from `WORKDIR/shots/`, the phase's own file). Never paste
   hunt notes; the refute phase's verdict table is the findings' record. These posts go to the
   ticket's Agents tab, the agents' working record, out of the human's way: a phase never writes
   to Main (no summary, no new top-level post for the human), and the ticket's summary is the
   job of whoever hands the ticket off.
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
   (`answer_decision`), not even one you run inline. Continue with the assumption until the human
   answers, and say so in the report.
4. **The result** goes to the board. For a PR: `post_review_result` (the verdict, `summary.md` as
   `summaryMd`, the commit SHA, the three checks and the counts, `repoId` when the project has
   several repos), which also posts the summary on the PR's ticket. For a branch with no PR yet: a `post_update` on the ticket with the verdict line
   and `summary.md` (it goes to Agents; the verdict's one line goes in the ticket's summary when
   the ticket is handed off). Never post it to GitHub unless `post` was given.

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
- Agents inherit the session model. Review quality depends on it, so do not downgrade
  the hunt or refute agents.
- If an agent fails, report the failure and produce the report from what succeeded.
  Record the missing phase under *Unverified*. Always run Teardown.
