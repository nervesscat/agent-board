# Feature Review Checklists

Each check is a yes/no question phrased so that **yes is the good answer**. Answer every
applicable check with `yes`, `no`, or `n/a` and a `path:line` citation. A check without a
citation is unanswered. A `no` is not a finding by itself: it becomes a candidate only
when you can write the concrete input or state that produces the wrong outcome.

Apply **Diff guard analysis** to every change, **Security** and **Reliability** to every change
that touches code (a change that is only `instructions` skips them), the sections matching the
spec's classification, and the **Project overlay** whenever the repo has rule files.

## Diff guard analysis (always, first)

1. Every conditional, early return, or validation the diff adds has been checked against every value its field can hold in this codebase, and each value's outcome is stated.
2. Every guard the diff removes or narrows is listed with the inputs it used to stop, and each is shown to be safe now, with a citation.
3. Behavior the author's new tests encode has been checked against the states those tests do not cover, not taken as the definition of correct.

## Security (every code change)

1. New entry points require the same authentication as comparable existing ones.
2. Object-level authorization is enforced: a caller can only reach resources they own or are granted, checked per request, not assumed from the route.
3. Input is validated and typed at the boundary (request, file, webhook, queue message) before use. Internal callers are trusted rather than re-validated.
4. No user-controlled data reaches a shell, a query, a file path, an outbound URL, a template, a deserializer, or an LLM prompt without escaping, allowlisting, or delimiting.
5. Errors returned to callers contain no stack traces, internal exception text, infrastructure names, or third-party API messages.
6. No secrets in code, logs, fixtures, or responses. New configuration is read from the environment or a secret store.
7. Outbound requests have timeouts and do not follow a user-supplied host or redirect.
8. Anything that does work per request (uploads, batch operations, LLM calls, emails) has a size or rate bound.
9. Sensitive actions (privilege changes, deletions, exports, payments) are logged with actor and target.

## Reliability (every code change)

1. Each external call has a defined outcome on failure: retry, fallback, or a clear error to the caller. Never a crash, never silent success.
2. Retryable operations are idempotent or guarded against duplicate execution.
3. Multi-step writes leave data consistent on partial failure, or roll back.
4. Long or blocking work does not run inside a request handler without a timeout.
5. Resources (files, connections, browser sessions, temp files) are released on error paths.
6. Shared state touched by concurrent handlers is protected. No async call is left un-awaited.
7. Behavior on empty, absent, duplicate, and oversized input is defined and matches the spec.
8. A failure in production would be diagnosable from the logs: what failed, for which resource, with what input class.

## api-endpoint

1. Method, path, and status codes follow the project's conventions and the spec.
2. Requests are validated with the project's schema mechanism. Wrong types and missing required fields are rejected with a 4xx.
3. Response shape matches what the consumer expects. Existing responses are not changed in a breaking way (grep the frontend or other callers).
4. List endpoints are paginated or bounded.
5. The auth middleware actually covers the new path. Verified with no token and with a wrong user, not assumed.
6. Sibling endpoints that share changed behavior still pass their tests.

## data-model

1. Existing stored records without the new field do not crash readers.
2. Defaults and nullability are handled on both read and write.
3. Migrations are idempotent and reversible, or explicitly one-way with a stated reason.
4. New query patterns have the indexes they need.
5. Newly stored personal data has a stated reason and a retention path.
6. Serialization round-trips: what is written can be read back by the same and the previous code.

## ui

1. The happy path renders and works in a real browser, not only in unit tests.
2. Loading, empty, and error states exist and are reachable.
3. Forms show validation messages, disable submit while pending, and prevent double submission.
4. New interactive elements are keyboard reachable and labeled.
5. Screens that already used a changed component still render.
6. State that should survive refresh or navigation does.
7. The UI handles a slow or failed backend response without a blank screen.

## background-job

1. Safe to run twice (idempotent) and safe to run concurrently, or locked.
2. Failure is visible (log, alert, status record), never swallowed. Partial progress is resumable.
3. The schedule or trigger configuration matches what the code assumes (timezone, frequency, payload).
4. Runtime is bounded. Large inputs are batched.
5. The job cannot be triggered by an unauthenticated caller.

## llm-prompt

1. A prompt or model change comes with an evaluation, or at least before and after outputs on the same inputs.
2. Model output is parsed defensively: schema-validated, and malformed output has a defined handling path.
3. User content inside the prompt is delimited or escaped, and injection through it has been considered.
4. Input is truncated or budgeted for tokens. Retries are bounded. Cost per call has a ceiling.
5. Model and parameters are pinned the way the project's conventions require.
6. Prompt text and raw model output do not leak to callers in error messages.

## instructions

Text agents or people follow: skills, agent files, `AGENTS.md`, `CLAUDE.md`, README, docs.

1. Every tool, parameter, flag, command, file, and section the text names exists (grep the code, the tool list, the file tree).
2. Nothing contradicts the sibling instruction files or what the code does.
3. Every step can be followed unattended and has a stop condition.
4. Copies of the same rule in other files (e.g. a skill and `AGENTS.md`) say the same.

## auth

1. Every role that should be denied is tested as denied, not only allowed roles tested as allowed.
2. Unknown roles or states default to deny.
3. Tokens and sessions are verified at the layer the project designates, once, not re-verified in handlers.
4. Privilege changes are audited.
5. Password, token, and OTP handling follows the project's existing mechanism rather than a new one.

## config-infra

1. New environment variables are documented and present in every environment's config template.
2. Defaults are safe for production (no debug mode, no permissive CORS, no verbose errors).
3. CI still runs the tests that cover the change.
4. Nothing secret is committed.
5. Health checks and readiness still reflect the real state of the service.

## dependency

1. The version is pinned according to the project's policy.
2. The changelog was checked for breaking changes in the APIs the project uses.
3. The license is compatible.
4. The lockfile is updated and consistent.
5. The dependency does not duplicate one the project already has.

## refactor

1. Behavior is unchanged: existing tests pass without modification. If tests were changed, each change is justified by the spec.
2. Public signatures and contracts are unchanged, or every caller is updated (grep).
3. No dead code is left behind. No new abstraction has only one caller.
4. Error handling and logging are preserved, not dropped in the move.

## cli-script

1. Non-zero exit on failure. A usage message on bad arguments.
2. Destructive operations require an explicit flag or a dry-run exists.
3. The script works from a clean environment (documented prerequisites).
4. Output is parseable if other tooling consumes it.

## Project overlay

If the repo has `CLAUDE.md`, `.claude/rules/*`, `CONTRIBUTING.md`, or `AGENTS.md`, treat
each concrete rule in them as an additional check with the same citation requirement.
Project rules override these checklists when they conflict.
