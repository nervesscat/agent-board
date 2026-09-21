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

function buildServer(actor: string) {
  const server = new McpServer({ name: 'agent-board', version: '0.1.0' })
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
  tool('list_projects', 'All projects on the board with their repo paths.', {}, () => projects.listProjects())
  tool(
    'get_project',
    'One project, including the instructions agents must follow when working on it. Read this before touching a project.',
    { projectId: z.number().int() },
    ({ projectId }) => projects.getProject(projectId),
  )

  // PR queue
  tool(
    'list_prs',
    'Open PRs assigned to the human for review, with status pending | reviewed | on_hold and the latest review verdict.',
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
    },
    ({ projectId, ...rest }) => reviews.postResult(projectId, rest, actor),
  )

  // ongoing features
  tool(
    'list_tickets',
    'Tickets of a project with status, assignee, branch and task progress.',
    { projectId: z.number().int() },
    ({ projectId }) => features.listTickets(projectId),
  )
  tool(
    'get_ticket',
    'A ticket in full: instructions, tasks, workspaces, and the update feed with attachments.',
    { ticketId: z.number().int() },
    ({ ticketId }) => features.getTicketFull(ticketId),
  )
  tool(
    'create_ticket',
    'Create a ticket (a feature or piece of work) with optional initial tasks.',
    {
      projectId: z.number().int(),
      title: z.string(),
      body: z.string().default('').describe('markdown instructions'),
      status: z.enum(TICKET_STATUSES).default('todo'),
      assignee: z.string().default(''),
      branch: z.string().default(''),
      baseBranch: z.string().optional(),
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
    'Read-only git state of the ticket branch and its workspaces (ahead/behind, last commit, worktrees).',
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
