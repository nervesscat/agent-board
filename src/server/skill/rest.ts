/**
 * Each MCP tool of the board as the REST call that does the same, for agents whose session has no
 * `board` MCP tools (`/api/agent-setup/skill?transport=rest`). Every tool `tools/list` returns has a row,
 * and every row names a tool: `agents.test.ts` holds both to the MCP server.
 */
export const TOOL_ROUTES: Record<string, string> = {
  whoami: 'GET /api/me',
  list_projects: 'GET /api/projects',
  find_project:
    'GET /api/projects, then match your origin (`githubRepo` owner/name), checkout path or folder against `repos[]` yourself',
  get_project: 'GET /api/projects/:id',
  set_project_instructions: 'PUT /api/projects/:id/instructions `{instructions}`',
  set_tag_suggestions: 'PATCH /api/projects/:id `{tagSuggestions}`',
  get_summary: 'GET /api/summary?projectId=',
  list_notifications: 'GET /api/projects/:id/agent-cards',
  start_tracked_request: 'POST /api/projects/:id/agent-cards `{title, request, total?, href?}`',
  tracked_request_progress: 'POST /api/projects/:id/agent-cards/:cardId/progress `{done?, step?}`',
  finish_tracked_request: 'POST /api/projects/:id/agent-cards/:cardId/finish `{state, result?, reason?}`',
  post_notice: 'POST /api/projects/:id/agent-cards/notices `{title, body, reason, href?}`',
  dismiss_notification: 'DELETE /api/projects/:id/agent-cards/:cardId',
  list_prs: 'GET /api/projects/:id/prs?refresh=1',
  set_pr_hold: 'PATCH /api/prs/:id `{hold, holdNote}`',
  post_review_result: 'POST /api/projects/:id/reviews/results',
  list_review_results: 'GET /api/projects/:id/reviews/results?pr=&sha=&repoId=',
  get_review_result: 'GET /api/reviews/results/:id',
  list_tickets: 'GET /api/projects/:id/tickets?status=&assignee=&q=&tag=&parent=',
  get_ticket: 'GET /api/tickets/:id',
  create_ticket: 'POST /api/projects/:id/tickets',
  update_ticket: 'PATCH /api/tickets/:id',
  claim_ticket: 'POST /api/tickets/:id/claim `{branch?, as?}`',
  add_tasks: 'POST /api/tickets/:id/tasks `{tasks[], parentTaskId?}`',
  set_task_done: 'PATCH /api/tasks/:id `{done}`',
  update_task: 'PATCH /api/tasks/:id `{text?, blocked?, blockedReason?}`',
  remove_task: 'DELETE /api/tasks/:id',
  add_workspace: 'POST /api/tickets/:id/workspaces `{name, branch?, path?, agent?, previewUrl?, repoId?}`',
  set_preview: 'PATCH /api/workspaces/:id `{previewUrl}`',
  start_preview: 'POST /api/workspaces/:id/preview/start (`/preview/restart` for restart: true)',
  preview_branch: 'POST /api/tickets/:id/branch-preview `{branch?, repoId?}`',
  preview_link:
    'POST /api/workspaces/:id/preview/link (the link `url` of a running preview: good for five minutes for anyone who holds it)',
  stop_preview: 'POST /api/workspaces/:id/preview/stop',
  list_runs: 'GET /api/tickets/:id/runs',
  start_run:
    'POST /api/workspaces/:id/runs/:runId/start (`/restart` to restart); all: POST /api/tickets/:id/runs/start `{repoId?}`',
  stop_run: 'POST /api/workspaces/:id/runs/:runId/stop; all: POST /api/tickets/:id/runs/stop `{repoId?}`',
  add_run: 'POST /api/repos/:id/runs',
  update_run: 'PATCH /api/runs/:id',
  delete_run: 'DELETE /api/runs/:id',
  remove_workspace: 'DELETE /api/workspaces/:id',
  start_span: 'POST /api/projects/:id/tickets/:ticketId/events `{kind: "span_start", phase, round?}`',
  end_span: 'POST /api/projects/:id/tickets/:ticketId/events `{kind: "span_end", spanId?, phase?}`',
  handoff: 'POST /api/projects/:id/tickets/:ticketId/events `{kind: "handoff", from?, to?}`',
  start_wait:
    'POST /api/projects/:id/tickets/:ticketId/events `{kind: "wait_start", reason, on?}` (`on`: the agent a waiting ticket\'s work was handed to, a delegated wait that counts as working; 1 to 60 characters)',
  end_wait: 'POST /api/projects/:id/tickets/:ticketId/events `{kind: "wait_end", waitId?, reason?}`',
  heartbeat: 'POST /api/projects/:id/tickets/:ticketId/events `{kind: "heartbeat"}`',
  post_update: 'POST /api/tickets/:id/updates `{body, attachmentIds[], as?, progress?, tab?}`',
  set_ticket_summary: 'PUT /api/tickets/:id/summary `{body, change?, attachmentIds[], as?}`',
  get_ticket_summary: 'GET /api/tickets/:id/summary',
  ask_decision: 'POST /api/tickets/:id/decisions `{body, options[], as?, block?}`',
  request_archive: 'POST /api/projects/:id/tickets/archive-request `{ticketIds[], as?}`',
  add_repo: 'POST /api/tickets/:id/repo-request `{name, repoPath, githubRepo, baseBranch?, as?}`',
  set_ticket_repo: 'PUT /api/tickets/:id/repo `{repoId, baseBranch?}`',
  answer_decision: 'POST /api/updates/:id/decision/relay `{option, words, as?}`',
  edit_post: 'PATCH /api/updates/:id `{body?, progress?, tab?}` · a reply: PATCH /api/comments/:id `{body}`',
  delete_post: 'DELETE /api/updates/:id · a reply: DELETE /api/comments/:id',
  get_ticket_git: 'GET /api/tickets/:id/git',
  cleanup_report: 'GET /api/projects/:id/cleanup',
  cleanup_delete: 'POST /api/projects/:id/cleanup/delete `{items[]}`',
  list_my_threads: 'GET /api/projects/:id/threads?since=',
  check_inbox: 'GET /api/projects/:id/inbox?since=',
  list_comments: 'GET /api/comments?parentType=&parentId=',
  comment: 'POST /api/comments `{parentType, parentId, body, replyTo?, tab?, as?}`',
  get_attachment: 'GET /api/uploads/:id/info (the bytes: GET /api/uploads/:id)',
  list_gallery: 'GET /api/projects/:id/gallery?type=&from=&to=&sort=&cursor=&limit=',
  list_actors: 'GET /api/actors',
  daily_report: 'GET /api/daily?date=YYYY-MM-DD&projectId=',
  post_daily_summary: 'POST /api/projects/:id/reports `{body}`',
  get_report_settings: 'GET /api/projects/:id/report-settings',
  set_report_settings: 'PATCH /api/projects/:id/report-settings',
  post_report: 'POST /api/projects/:id/reports `{period?, body?, attachmentIds[]}`',
  list_reports: 'GET /api/projects/:id/reports?from=&to=',
}

/** The part of the board skill a REST-only session reads: how to call, then every tool's route. */
export function restSection(boardUrl: string): string {
  const rows = Object.entries(TOOL_ROUTES)
    .map(([tool, route]) => `| \`${tool}\` | ${route.replaceAll('|', '\\|')} |`)
    .join('\n')
  return `## Without the board's MCP tools: REST

This copy of the skill is for a session where the \`board\` MCP tools are missing (a cloud session that
reaches the board after its MCP servers connected, or a client without MCP). Everywhere this skill
names a tool, call its REST route below instead. Same board, same rules, same names: a write is
attributed to your agent token's name, \`as\` works the same, and every tool's arguments are the JSON
body (writes) or the query (reads), \`projectId\` and \`ticketId\` going into the path where it has
\`:id\`.

\`\`\`
curl -s -H "Authorization: Bearer $BOARD_TOKEN" -H 'Content-Type: application/json' \\
  ${boardUrl}/api/tickets/12
curl -s -X POST -H "Authorization: Bearer $BOARD_TOKEN" -H 'Content-Type: application/json' \\
  ${boardUrl}/api/tickets/12/updates --data '{"body":"Built the parser.","tab":"agents"}'
\`\`\`

- The token comes from the environment (\`BOARD_TOKEN\`), never from a prompt, a file in a repo or a
  post. Never print it.
- Through a proxy (a tailnet's userspace proxy, for one), add \`-x <proxy>\` to every call. A call that
  cannot connect: bring the network up again (your session's start command), then retry.
- Errors come back as \`{error}\` with the HTTP status: 400 a bad body, 403 not yours, 404 gone, 409
  the state does not allow it.
- Uploads: \`POST /api/uploads\` with \`{name, base64}\` (a \`{path}\` would be read on the board's machine),
  then pass the \`id\` in \`attachmentIds\`.
- Previews: the board cannot see your worktree. Push the branch, then \`preview_branch\`: the board
  fetches it into a worktree of its own and runs the repo's preview there.

| MCP tool | REST |
|---|---|
${rows}
`
}
