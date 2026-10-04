import fs from 'node:fs'
import { z } from 'zod'

import { AGENT_CLIENTS, COMMENT_PARENTS, STAGE_COLORS, STAGE_KINDS } from '#/lib/constants'
import { addSummary } from './activity'
import * as agents from './agents'
import { listActors } from './actors'
import { isAgent } from './auth'
import { cleanupReport } from './cleanup'
import { dailyReport, generateSummary, today } from './daily'
import * as features from './features'
import { listDirs } from './fs'
import { assertRepo, listBranches } from './git'
import { HttpError, intParam, readJson } from './http'
import { handleMcp } from './mcp'
import * as prs from './prs'
import * as projects from './projects'
import * as repos from './repos'
import * as reviews from './reviews'
import { ApiRouter } from './router'
import * as stages from './stages'
import * as uploads from './uploads'

const json = (data: unknown, status = 200) => Response.json(data, { status })
const id = (p: Record<string, string>, k = 'id') => intParam(p[k]!, k)

const Instructions = z.string().max(50_000)
// A stage key, name or kind; the server resolves it against the project's stages.
const Status = z.string().min(1).max(60)
const TicketPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  status: Status.optional(),
  assignee: z.string().max(80).optional(),
  branch: z.string().max(200).optional(),
  baseBranch: z.string().max(200).optional(),
  repoId: z.number().int().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  prNumber: z.number().int().positive().nullable().optional(),
})

export const api = new ApiRouter()

api.get('/api/health', () => json({ ok: true }))
api.get('/api/me', ({ actor }) => json({ actor }))
// Every name the board has seen sign in, with whether it is an agent or a human.
api.get('/api/actors', () => json(listActors()))

// --- connecting agents: board settings, and the skill each CLI installs ---
api.get('/api/agent-setup', () => json(agents.agentSetup()))
// The board skill as a SKILL.md, with today's projects and repos; the install commands curl this.
api.get('/api/agent-setup/skill', ({ url }) => {
  const client = z.enum(AGENT_CLIENTS).catch('claude').parse(url.searchParams.get('client'))
  return new Response(agents.renderSkill(client), {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
  })
})
api.get('/api/settings', () => json(agents.getSettings()))
api.patch('/api/settings', async ({ request }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human changes the settings')
  const body = await readJson(request, z.object({ defaultAgent: z.enum(AGENT_CLIENTS).optional() }))
  return json(agents.updateSettings(body))
})

// --- projects ---
api.get('/api/projects', () => json(projects.listProjects()))
api.post('/api/projects', async ({ request, actor }) => {
  const body = await readJson(
    request,
    z.object({ name: z.string().min(1).max(100), instructions: Instructions.optional() }),
  )
  return json(projects.createProject(body, actor), 201)
})
api.get('/api/projects/:id', ({ params }) => json(projects.getProjectFull(id(params))))
api.patch('/api/projects/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ name: z.string().min(1).max(100).optional(), instructions: Instructions.optional() }),
  )
  return json(projects.updateProject(id(params), body, actor))
})
api.delete('/api/projects/:id', ({ params, actor }) => {
  projects.deleteProject(id(params), actor)
  return json({ ok: true })
})

// --- stages (the board's columns); laid out by the human, read by everyone via the project ---
const StageBody = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(STAGE_KINDS),
  color: z.enum(STAGE_COLORS).optional(),
})
const humanOnly = (request: Request) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human lays out the stages')
}
api.get('/api/projects/:id/stages', ({ params }) => {
  const pid = id(params)
  projects.getProject(pid)
  const counts = stages.stageCounts(pid)
  return json(stages.listStages(pid).map((s) => ({ ...s, tickets: counts[s.key] ?? 0 })))
})
api.post('/api/projects/:id/stages', async ({ request, params, actor }) => {
  humanOnly(request)
  projects.getProject(id(params))
  return json(stages.createStage(id(params), await readJson(request, StageBody), actor), 201)
})
// Body: every stage id of the project, in the new order.
api.put('/api/projects/:id/stages/order', async ({ request, params, actor }) => {
  humanOnly(request)
  const body = await readJson(request, z.object({ ids: z.array(z.number().int()) }))
  return json(stages.reorderStages(id(params), body.ids, actor))
})
api.patch('/api/projects/:id/stages/:stageId', async ({ request, params, actor }) => {
  humanOnly(request)
  const body = await readJson(request, StageBody.partial())
  return json(stages.updateStage(id(params), id(params, 'stageId'), body, actor))
})
// ?moveTo=<key> is where its tickets go; required when it has any.
api.delete('/api/projects/:id/stages/:stageId', ({ request, params, url, actor }) => {
  humanOnly(request)
  stages.deleteStage(
    id(params),
    id(params, 'stageId'),
    { moveTo: url.searchParams.get('moveTo') ?? undefined },
    actor,
  )
  return json({ ok: true })
})

// --- repos ---
api.get('/api/repos', () => json(repos.listRepos()))
api.post('/api/repos', async ({ request, actor }) => {
  const body = await readJson(
    request,
    z.object({
      projectId: z.number().int().optional(),
      projectName: z.string().min(1).max(100).optional(),
      name: z.string().max(100).optional(),
      repoPath: z.string().min(1),
      baseBranch: z.string().max(200).optional(),
    }),
  )
  return json(await repos.createRepo(body, actor), 201)
})
api.patch('/api/repos/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      projectId: z.number().int().optional(),
      name: z.string().min(1).max(100).optional(),
      repoPath: z.string().min(1).optional(),
      baseBranch: z.string().max(200).optional(),
    }),
  )
  return json(await repos.updateRepo(id(params), body, actor))
})
api.delete('/api/repos/:id', ({ params, actor }) => {
  repos.deleteRepo(id(params), actor)
  return json({ ok: true })
})
// Local branches of any checkout, so the new-repo dialog can offer them before the repo is registered.
api.get('/api/branches', async ({ url }) => {
  const repoPath = url.searchParams.get('path') ?? ''
  assertRepo(repoPath)
  return json(await listBranches(repoPath))
})
api.get('/api/repos/:id/branches', async ({ params }) =>
  json(await listBranches(repos.getRepo(id(params)).repoPath)),
)
// Subfolders of a folder on the board's machine (default: home), for the repo path picker.
api.get('/api/fs/dirs', ({ url }) => json(listDirs(url.searchParams.get('path') ?? undefined)))

// --- PR queue ---
api.get('/api/projects/:id/prs', async ({ params, url }) =>
  json(await prs.listPrs(id(params), { refresh: url.searchParams.get('refresh') === '1' })),
)
api.patch('/api/prs/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ hold: z.boolean(), holdNote: z.string().max(2000).default('') }),
  )
  return json(prs.setPrHold(id(params), body.hold, body.holdNote, actor))
})

// --- ongoing features ---
// ?parent=root for the top level, ?parent=<ticketId> for one ticket's lanes; all tickets otherwise.
// ?tag= keeps the ones carrying that tag, ?status=todo,blocked those stages, ?assignee= one name (empty for
// unassigned), ?q= a text match in the title or instructions.
api.get('/api/projects/:id/tickets', ({ params, url }) => {
  const q = url.searchParams
  const parent = q.get('parent')
  const parentId = parent === null ? undefined : parent === 'root' ? null : intParam(parent, 'parent')
  const status = q.get('status')
  return json(
    features.listTickets(id(params), {
      parentId,
      tag: q.get('tag') ?? undefined,
      status: status ? z.array(Status).parse(status.split(',')) : undefined,
      assignee: q.get('assignee') ?? undefined,
      q: q.get('q') ?? undefined,
    }),
  )
})
api.post('/api/projects/:id/tickets', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    TicketPatch.extend({
      title: z.string().min(1).max(200),
      tasks: z.array(z.string().min(1).max(500)).optional(),
      parentId: z.number().int().optional(),
    }),
  )
  return json(features.createTicket(id(params), body, actor), 201)
})
// ?lanes=1 folds the lanes' updates into the feed.
api.get('/api/tickets/:id', ({ params, url }) =>
  json(features.getTicketFull(id(params), { laneUpdates: url.searchParams.get('lanes') === '1' })),
)
api.patch('/api/tickets/:id', async ({ request, params, actor }) =>
  json(features.updateTicket(id(params), await readJson(request, TicketPatch), actor)),
)
// ?keepLanes=1 moves the lanes up a level instead of deleting them.
api.delete('/api/tickets/:id', ({ params, url, actor }) => {
  features.deleteTicket(id(params), actor, { keepLanes: url.searchParams.get('keepLanes') === '1' })
  return json({ ok: true })
})
// Approval is the human's: agents read approvedAt/approvedBy on the ticket but cannot set them.
api.put('/api/tickets/:id/approval', async ({ request, params, actor }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human approves')
  // approved, disapproved (which cancels the ticket), or null to take the call back; reopenTo is the
  // stage a taken-back disapproval returns to (an undo passes the one it had), the stage new tickets start in otherwise.
  const body = await readJson(
    request,
    z.object({
      verdict: z.enum(['approved', 'disapproved']).nullable(),
      reopenTo: Status.optional(),
    }),
  )
  return json(features.setVerdict(id(params), body.verdict, actor, { reopenTo: body.reopenTo }))
})
// Assigns the ticket to the caller unless someone else holds it (409), and starts it.
api.post('/api/tickets/:id/claim', async ({ request, params, actor }) => {
  const body = await readJson(request, z.object({ branch: z.string().max(200).optional() }))
  return json(features.claimTicket(id(params), actor, body))
})
api.get('/api/tickets/:id/git', async ({ params }) => json(await features.ticketGit(id(params))))
// Closed tickets that still have workspaces, branches or worktrees; `reach=0` skips the merge checks.
api.get('/api/projects/:id/cleanup', async ({ params, url }) =>
  json(await cleanupReport(id(params), { reach: url.searchParams.get('reach') !== '0' })),
)

api.post('/api/tickets/:id/tasks', async ({ request, params, actor }) => {
  const body = await readJson(request, z.object({ tasks: z.array(z.string().min(1).max(500)).min(1) }))
  return json(features.addTasks(id(params), body.tasks, actor), 201)
})
api.patch('/api/tasks/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ done: z.boolean().optional(), text: z.string().min(1).max(500).optional() }),
  )
  return json(features.updateTask(id(params), body, actor))
})
api.delete('/api/tasks/:id', ({ params, actor }) => {
  features.deleteTask(id(params), actor)
  return json({ ok: true })
})

api.post('/api/tickets/:id/workspaces', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      name: z.string().min(1).max(100),
      branch: z.string().max(200).optional(),
      path: z.string().max(500).optional(),
      agent: z.string().max(80).optional(),
    }),
  )
  return json(features.addWorkspace(id(params), body, actor), 201)
})
api.delete('/api/workspaces/:id', ({ params, actor }) => {
  features.deleteWorkspace(id(params), actor)
  return json({ ok: true })
})

api.post('/api/tickets/:id/updates', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ body: z.string().min(1).max(50_000), attachmentIds: z.array(z.number().int()).default([]) }),
  )
  return json(features.postUpdate(id(params), body.body, body.attachmentIds, actor), 201)
})

// --- comments ---
api.get('/api/comments', ({ url }) => {
  const parentType = z.enum(COMMENT_PARENTS).parse(url.searchParams.get('parentType'))
  return json(features.listComments(parentType, intParam(url.searchParams.get('parentId') ?? '', 'parentId')))
})
// Threads in a project where someone spoke after the caller, on things the caller owns or spoke in.
api.get('/api/projects/:id/threads', ({ params, actor }) => json(features.listOpenThreads(id(params), actor)))
api.post('/api/comments', async ({ request, actor }) => {
  const body = await readJson(
    request,
    z.object({
      parentType: z.enum(COMMENT_PARENTS),
      parentId: z.number().int(),
      replyTo: z.number().int().nullable().optional(),
      body: z.string().min(1).max(20_000),
      attachmentIds: z.array(z.number().int()).optional(),
    }),
  )
  return json(features.addComment(body, actor), 201)
})

// --- uploads ---
api.post('/api/uploads', async ({ request, actor }) => {
  const type = request.headers.get('content-type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new HttpError(400, 'multipart field "file" is required')
    const a = await uploads.saveUpload(file, actor)
    return json({ ...a, url: uploads.attachmentUrl(a) }, 201)
  }
  const body = await readJson(
    request,
    z.union([
      z.object({ path: z.string().min(1) }),
      z.object({ name: z.string().min(1), base64: z.string().min(1), mime: z.string().optional() }),
    ]),
  )
  const a =
    'path' in body
      ? uploads.saveFromPath(body.path, actor)
      : uploads.saveBase64(body.name, body.base64, actor, body.mime)
  return json({ ...a, url: uploads.attachmentUrl(a) }, 201)
})
api.get('/api/uploads/:id/info', ({ params }) =>
  json(uploads.attachmentView(uploads.getAttachment(id(params)))),
)
api.get('/api/uploads/:id', ({ params }) => {
  const a = uploads.getAttachment(id(params))
  const file = uploads.attachmentPath(a)
  if (!fs.existsSync(file)) throw new HttpError(404, 'file is gone')
  const stream = fs.createReadStream(file)
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'content-type': a.mime,
      'content-length': String(a.size),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `inline; filename="${encodeURIComponent(a.name)}"`,
    },
  })
})

// --- reviews ---
// ?pr=&sha=&repoId= narrow the results; the summaries are left out (GET /api/reviews/results/:id has one).
api.get('/api/projects/:id/reviews/results', ({ params, url }) => {
  const q = url.searchParams
  const num = (k: string) => (q.get(k) ? intParam(q.get(k)!, k) : undefined)
  const rows = reviews.listResults(id(params), num('limit') ?? 20, {
    prNumber: num('pr'),
    sha: q.get('sha') || undefined,
    repoId: num('repoId'),
  })
  return json(rows.map(({ summaryMd: _summary, ...r }) => r))
})
api.get('/api/projects/:id/reviews', ({ params }) => json({ results: reviews.listResults(id(params)) }))
api.post('/api/projects/:id/reviews/results', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      prNumber: z.number().int().positive(),
      sha: z.string().min(7).max(64),
      verdict: z.string().min(1).max(100),
      summaryMd: z.string().max(100_000),
      checks: z.record(z.string(), z.string()).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      repoId: z.number().int().optional(),
    }),
  )
  return json(reviews.postResult(id(params), body, actor), 201)
})
api.get('/api/reviews/results/:id', ({ params }) => json(reviews.getResult(id(params))))

// --- daily ---
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
api.get('/api/daily', ({ url }) => {
  const date = Day.parse(url.searchParams.get('date') ?? today())
  const project = url.searchParams.get('projectId')
  return json(dailyReport(date, project ? intParam(project, 'projectId') : undefined))
})
api.post('/api/daily/summaries', async ({ request, actor }) => {
  const body = await readJson(
    request,
    z.object({
      date: Day.default(today()),
      projectId: z.number().int().nullable().default(null),
      body: z.string().min(1).max(5000),
    }),
  )
  return json(addSummary({ ...body, author: actor }), 201)
})
api.post('/api/daily/summaries/generate', async ({ request }) => {
  const body = await readJson(
    request,
    z.object({ date: Day.default(today()), projectId: z.number().int().nullable().default(null) }),
  )
  return json(await generateSummary(body.date, body.projectId), 201)
})

// --- MCP ---
api.on('POST', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
api.on('GET', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
api.on('DELETE', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
