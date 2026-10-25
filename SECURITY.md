# Security policy

CrossBoard runs on your machine, holds a passkey account, agent tokens and your projects' data, and
starts `git`, `gh` and `claude`. A flaw in it can reach all of that, so please report one privately.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting:
**https://github.com/nervesscat/agent-board/security/advisories/new** (the repository's Security tab,
Report a vulnerability). Only the maintainers see the report.

- **Do not** open a public issue, discussion or pull request about it, and do not post details elsewhere
  until a fix is released.
- Say what is affected (version or commit, Windows/Linux app or a checkout), how to reproduce it, and
  what an attacker gains. A proof of concept helps; keep it to your own installation.
- Do not test against boards that are not yours, and do not read, change or delete other people's data.

## What to expect

- An acknowledgement within 7 days.
- An assessment (accepted or not, with the reason) within 14 days.
- For an accepted report: a fix in a new release, a GitHub security advisory crediting you (unless you
  prefer not to be named), and a note of what to upgrade or rotate.

## Supported versions

Only the latest release (https://github.com/nervesscat/agent-board/releases/latest) and the default
branch get security fixes. Upgrade to the latest release before reporting where you can.

## Scope

In scope: the board's server and pages, its sign-in (passkeys, sessions, agent tokens), its REST API and
MCP server, the desktop app and its installers, and the scripts in this repository.

Out of scope: a board deliberately run with its sign-in off (`AUTH=off`, `BOARD_ENV=test`, which only run
on loopback outside production), what a signed-in human or an agent with a valid token is allowed to do
by design, and flaws in `git`, `gh`, `claude` or other tools the board starts (report those to their
projects).
