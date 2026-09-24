import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { COMMENT_PARENTS, TICKET_STATUSES } from '#/lib/constants'
import { addSummary } from './activity'
import { dailyReport, today } from './daily'
import * as features from './features'
import { HttpError } from './http'
import * as prs from './prs'
import * as projects from './projects'
import * as reviews from './reviews'
import * as uploads from './uploads'

/**
 * The same board, as MCP tools. Stateless streamable HTTP: one server per request, closed over the
 * actor the gate identified, so every write is attributed to the agent's token name.
 */

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})
const fail = (err: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: err instanceof HttpError ? err.message : 'internal error, see the board log',
    },
  ],
})

/** Sent to every client on connect, so agents in any repo know the rhythm without reading AGENTS.md. */
const INSTRUCTIONS = `The board is where the human and every agent coordinate work. You read work from it and report back to it. Git and GitHub are read-only through the board: never push, merge, approve or comment on GitHub on its behalf.

Work only in the project of the repo you are in, and never read or write another project's tickets, PRs, reviews or daily log. If a board skill or the repo's own instructions name your projectId, use it directly. Only otherwise, call list_projects once and pick the project whose repos include yours (match the GitHub slug from git remote get-url origin, then the folder name; the board may list Linux paths while you are on Windows); if none does, do not use the board for this repo.

The rhythm:
1. get_project before touching it; its instructions override your defaults.
2. Pick up work from list_tickets (todo, unassigned or assigned to you); read it with get_ticket; then update_ticket with assignee = your name (whoami), status in_progress, and the branch.
3. add_tasks with the concrete steps if the ticket has none; set_task_done as you finish each.
4. Split parallel work into lanes: when a ticket needs several pieces worked at once (subagents, worktrees, other agents), create_ticket with parentId = the ticket for each piece, with its own branch and assignee. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its own. add_workspace registers where code runs (a worktree, a sub-branch, a sandbox); remove_workspace when it is gone.
5. post_update after each meaningful step: short markdown, what changed and what is next, with screenshots or logs as absolute file paths in files.
6. Ask and answer in threads with comment; check list_comments on your ticket when you resume.
7. Hand off: final post_update with the PR link, then update_ticket to review. done is the human's call. A ticket with lanes goes to review once its lanes are in review or done.
8. End of session: post_daily_summary, at most three short lines.

When a project has several repos, pass repoId to create_ticket and post_review_result. Plain words, titles under 80 characters; the human reads dozens of these a day.

Keep the board out of the repo. The board, trazic, habits and any other personal tracking tool are private to the human: never mention them, their tool names, their URLs (localhost:47100, 47110) or a board ticket, task or project ("#12", "ticket 12", "per the board") in code comments, docs, READMEs, changelogs, config, commit messages, branch names, PR titles or descriptions, or issues, and never link or screenshot the board there. Describe the change and its reason in the repo's own terms; if the PR needs something from the ticket, restate it instead of pointing at it. Board updates and comments may talk about the repo, branches and PRs freely.`

function buildServer(actor: string) {
  const server = new McpServer({ name: 'agent-board', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown,
  ) => {
    const cb = (async (args: unknown) => {
      try {
        return text(await run(args as z.infer<z.ZodObject<S>>))
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`mcp ${name} failed:`, err)
        return fail(err)
      }
    }) as ToolCallback<S>
    server.registerTool(name, { description, inputSchema: shape }, cb)
  }

  tool('whoami', 'The name the board knows you by (your gate token name).', {}, () => ({ actor }))

  // projects
  tool(
    'list_projects',
    'All projects on the board, each with its repos (id, name, checkout path, GitHub slug, base branch).',
    {},
    () => projects.listProjects(),
  )
  tool(
    'get_project',
    'One project with its repos and the instructions agents must follow when working on it. Read this before touching a project.',
    { projectId: z.number().int() },
    ({ projectId }) => projects.getProjectFull(projectId),
  )

  // PR queue
  tool(
    'list_prs',
    'Open PRs assigned to the human for review across all repos of the project, with status pending | reviewed | on_hold, the repo, and the latest review verdict.',
    {
      projectId: z.number().int(),
      refresh: z.boolean().default(false).describe('re-query GitHub before answering'),
    },
    ({ projectId, refresh }) => prs.listPrs(projectId, { refresh }),
  )
  tool(
    'set_pr_hold',
    'Put a PR on hold with a note (or release it). Board-side only; GitHub is never written.',
    { prId: z.number().int(), hold: z.boolean(), note: z.string().default('') },
    ({ prId, hold, note }) => prs.setPrHold(prId, hold, note, actor),
  )
  tool(
    'post_review_result',
    'Record the outcome of a PR review you performed: verdict plus a markdown summary (findings, how to test, checks).',
    {
      projectId: z.number().int(),
      prNumber: z.number().int(),
      sha: z.string().describe('head SHA that was reviewed'),
      verdict: z.string().describe('e.g. SHIP, FIX FIRST, COULD NOT VERIFY'),
      summaryMd: z.string(),
      checks: z.record(z.string(), z.string()).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      repoId: z.number().int().optional().describe('required when the project has more than one repo'),
    },
    ({ projectId, ...rest }) => reviews.postResult(projectId, rest, actor),
  )

  // ongoing features
  tool(
    'list_tickets',
    'Tickets of a project (all its repos) with status, assignee, repoId, branch, parentId, task progress (own and rolled up over lanes) and lane counts by status.',
    {
      projectId: z.number().int(),
      parentId: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("a ticket's id for its lanes, null for top-level tickets only; omit for all"),
    },
    ({ projectId, parentId }) => features.listTickets(projectId, { parentId }),
  )
  tool(
    'get_ticket',
    'A ticket in full: instructions, tasks, workspaces, its parent chain, its lanes with their last update, and the update feed with attachments.',
    {
      ticketId: z.number().int(),
      laneUpdates: z.boolean().default(false).describe("include the lanes' updates in the feed"),
    },
    ({ ticketId, laneUpdates }) => features.getTicketFull(ticketId, { laneUpdates }),
  )
  tool(
    'create_ticket',
    'Create a ticket (a feature or piece of work) with optional initial tasks. With parentId it is a lane of that ticket: a parallel piece of it with its own assignee, branch, tasks and updates.',
    {
      projectId: z.number().int(),
      title: z.string(),
      body: z.string().default('').describe('markdown instructions'),
      status: z.enum(TICKET_STATUSES).default('todo'),
      assignee: z.string().default(''),
      branch: z.string().default(''),
      baseBranch: z.string().optional().describe("defaults to the repo's base branch"),
      repoId: z
        .number()
        .int()
        .optional()
        .describe('the repo the branch lives in; required when the project has more than one repo'),
      parentId: z
        .number()
        .int()
        .optional()
        .describe(
          "make this a lane of that ticket; repo and base branch default to the parent's repo and branch",
        ),
      tasks: z.array(z.string()).default([]),
    },
    ({ projectId, ...rest }) => features.createTicket(projectId, rest, actor),
  )
  tool(
    'update_ticket',
    'Change status, assignee, branch, title or instructions. Set assignee to yourself and status to in_progress when you pick a ticket up.',
    {
      ticketId: z.number().int(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(TICKET_STATUSES).optional(),
      assignee: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoId: z.number().int().optional(),
    },
    ({ ticketId, ...patch }) => features.updateTicket(ticketId, patch, actor),
  )
  tool(
    'add_tasks',
    'Append todo items to a ticket.',
    { ticketId: z.number().int(), tasks: z.array(z.string()).min(1) },
    ({ ticketId, tasks }) => features.addTasks(ticketId, tasks, actor),
  )
  tool(
    'set_task_done',
    'Tick or untick a task.',
    { taskId: z.number().int(), done: z.boolean().default(true) },
    ({ taskId, done }) => features.updateTask(taskId, { done }, actor),
  )
  tool(
    'add_workspace',
    'Register a worktree / sub-branch / subagent sandbox you opened for a ticket, so the board can show it.',
    {
      ticketId: z.number().int(),
      name: z.string(),
      branch: z.string().default(''),
      path: z.string().default(''),
      agent: z.string().optional(),
    },
    ({ ticketId, ...rest }) => features.addWorkspace(ticketId, rest, actor),
  )
  tool(
    'remove_workspace',
    'Remove a workspace you closed.',
    { workspaceId: z.number().int() },
    ({ workspaceId }) => {
      features.deleteWorkspace(workspaceId, actor)
      return { ok: true }
    },
  )
  tool(
    'post_update',
    'Post progress on a ticket: markdown plus optional files (screenshots, recordings) given as absolute paths on this machine.',
    {
      ticketId: z.number().int(),
      body: z.string(),
      files: z.array(z.string()).default([]).describe('absolute paths to attach'),
    },
    ({ ticketId, body, files }) => {
      const ids = files.map((f) => uploads.saveFromPath(f, actor).id)
      return features.postUpdate(ticketId, body, ids, actor)
    },
  )
  tool(
    'get_ticket_git',
    "Read-only git state of the ticket branch and its workspaces, its lanes' included and tagged with the lane (ahead/behind, last commit, worktrees).",
    { ticketId: z.number().int() },
    ({ ticketId }) => features.ticketGit(ticketId),
  )

  // threads
  tool(
    'list_comments',
    'The thread under a ticket, an update, a PR (board id, not number) or a review result.',
    { parentType: z.enum(COMMENT_PARENTS), parentId: z.number().int() },
    ({ parentType, parentId }) => features.listComments(parentType, parentId),
  )
  tool(
    'comment',
    'Leave a comment in a thread; replyTo nests it under another comment.',
    {
      parentType: z.enum(COMMENT_PARENTS),
      parentId: z.number().int(),
      body: z.string(),
      replyTo: z.number().int().optional(),
      files: z.array(z.string()).default([]),
    },
    ({ files, ...rest }) =>
      features.addComment(
        { ...rest, attachmentIds: files.map((f) => uploads.saveFromPath(f, actor).id) },
        actor,
      ),
  )

  // daily
  tool(
    'daily_report',
    "A day's activity (every write anyone made, in order) and the summaries posted for it.",
    {
      date: z.string().default(today()).describe('YYYY-MM-DD, local'),
      projectId: z.number().int().optional(),
    },
    ({ date, projectId }) => dailyReport(date, projectId),
  )
  tool(
    'post_daily_summary',
    'Post the highest-level summary of a day: at most three short lines, what got done and what is open.',
    {
      date: z.string().default(today()),
      projectId: z.number().int().nullable().default(null),
      body: z.string(),
    },
    ({ date, projectId, body }) => addSummary({ date, projectId, body, author: actor }),
  )

  return server
}

export async function handleMcp(request: Request, actor: string): Promise<Response> {
  // Stateless and JSON-only: each POST is fully answered before the response is returned, nothing outlives the request.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await buildServer(actor).connect(transport)
  return transport.handleRequest(request)
}
