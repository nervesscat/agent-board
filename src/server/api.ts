import { Readable } from 'node:stream'
import { z } from 'zod'

import {
  AGENT_CLIENTS,
  COMMENT_PARENTS,
  COMPLEXITIES,
  PREVIEW_LIMIT,
  SKILLS_TRACKING,
  STAGE_COLORS,
  STAGE_KINDS,
} from '#/lib/constants'
import { MAX_TAG_LENGTH, MAX_TAGS } from '#/lib/tags'
import * as agents from './agents'
import { addDefaultAgents } from './defaultAgents'
import { listActors } from './actors'
import { isAgent } from './auth'
import { cleanupReport } from './cleanup'
import { DELETE_KINDS, deleteLeftovers } from './cleanupActions'
import { authMode } from './config'
import { dailyReport, today } from './daily'
import * as features from './features'
import { listDirs } from './fs'
import { assertRepo, listBranches } from './git'
import { HttpError, intParam, readJson } from './http'
import {
  isActive,
  managedPreview,
  previewLog,
  restartPreview,
  startPreview,
  stopPreview,
  stopProjectPreviews,
} from './managedPreview'
import { handleMcp } from './mcp'
import * as needs from './needs'
import * as projectAgents from './projectAgents'
import * as prs from './prs'
import { projectPush, refreshProjectPush } from './push'
import { stopLinkPreview, stopProjectLinksAndPreviews } from './linkPreview'
import { projectPreviewsPage } from './projectPreviews'
import { pushedToday } from './pushedToday'
import * as projects from './projects'
import { reportsDue } from './reportDue'
import { generateReport } from './reportGenerate'
import * as reports from './reports'
import * as settingsHistory from './reportSettingsHistory'
import { reportsOverview } from './reportsOverview'
import * as repos from './repos'
import { withResume } from './resume'
import * as reviews from './reviews'
import { ApiRouter } from './router'
import * as stages from './stages'
import { fileStore, parseRange } from './storage'
import { getSummary } from './summary'
import { deleteUnattachedUploads } from './unattached'
import * as uploads from './uploads'

const json = (data: unknown, status = 200) => Response.json(data, { status })
const id = (p: Record<string, string>, k = 'id') => intParam(p[k]!, k)

const Instructions = z.string().max(50_000)
// A stage key, name or kind; the server resolves it against the project's stages.
const Status = z.string().min(1).max(60)
/** An agent opens the files it is handed from disk: with STORAGE=s3, have them there first. */
const forAgent = <T>(request: Request, value: T) =>
  isAgent(request) ? uploads.ensureLocalFiles(value) : Promise.resolve(value)
const AgentName = z.string().min(1).max(40)
// Checked for http(s) where it is stored; null or '' clears it.
const PreviewUrl = z.string().max(500).nullable()
const TaskText = z.string().min(1).max(500)
// A task blocked on the human, and what they must do (a reason only with blocked: true).
const TaskBlocked = {
  blocked: z.boolean().optional(),
  blockedReason: z.string().max(features.MAX_BLOCKED_REASON).optional(),
}
// A task, or a top-level task with the subtasks that go under it, either one maybe tagged blocked.
const NewTask = z.union([
  TaskText,
  z.object({ text: TaskText, subtasks: z.array(TaskText).optional(), ...TaskBlocked }),
])
// Speaking as one of the project's agents is how a connected agent delegates; the human speaks as themself.
const agentOnly = (request: Request) => {
  if (!isAgent(request)) throw new HttpError(403, 'only a connected agent posts as one of the project agents')
}
const TicketPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  status: Status.optional(),
  // Exactly low, mid or high; a lane created without one copies its parent's (features.ts createTicket).
  complexity: z.enum(COMPLEXITIES).optional(),
  assignee: z.string().max(80).optional(),
  branch: z.string().max(200).optional(),
  baseBranch: z.string().max(200).optional(),
  repoId: z.number().int().optional(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  // The tickets whose branches must be merged into this one's base before it can be done; replaces the list.
  needs: z.array(z.number().int()).max(50).optional(),
})

export const api = new ApiRouter()

api.get('/api/health', () => json({ ok: true }))
// `authOff` (test, or development with AUTH=off) puts a badge in the top bar: this is not the live board.
api.get('/api/me', ({ request, actor }) =>
  json({ actor, agent: isAgent(request), boardEnv: authMode().boardEnv, authOff: authMode().off }),
)
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
// feature-review, review-queue, todo-review and their agents, as a tar to extract into ~/.claude.
api.get('/api/agent-setup/review-skills', ({ url }) => {
  if (url.searchParams.get('list') !== null) return json(agents.reviewBundlePaths())
  return new Response(new Uint8Array(agents.reviewBundle()), {
    headers: {
      'content-type': 'application/x-tar',
      'content-disposition': 'attachment; filename="review-skills.tar"',
      'cache-control': 'no-store',
    },
  })
})
// Whether ~/.claude and each repo's own .claude have that bundle as it is now: every repo, or ?projectId's.
api.get('/api/agent-setup/review-skills/status', async ({ url }) => {
  const pid = url.searchParams.get('projectId')
  const status = await agents.reviewSkillsStatus(pid === null ? undefined : intParam(pid, 'projectId'))
  return Response.json(status, { headers: { 'cache-control': 'no-store' } })
})
// One of those files as installed in ~/.claude, or in ?repoId's .claude, against as served: a git-style diff.
api.get('/api/agent-setup/review-skills/diff', async ({ url }) => {
  const file = url.searchParams.get('path')
  if (!file) throw new HttpError(400, 'path is required: one of the review skills files')
  const repo = url.searchParams.get('repoId')
  const diff = await agents.reviewSkillDiff(file, repo === null ? undefined : intParam(repo, 'repoId'))
  return Response.json(diff, { headers: { 'cache-control': 'no-store' } })
})
api.get('/api/settings', () => json(agents.getSettings()))
api.patch('/api/settings', async ({ request }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human changes the settings')
  const body = await readJson(
    request,
    z.object({
      defaultAgent: z.enum(AGENT_CLIENTS).optional(),
      previewLimit: z.number().int().min(PREVIEW_LIMIT.min).max(PREVIEW_LIMIT.max).optional(),
      skillsTracking: z.enum(SKILLS_TRACKING).optional(),
    }),
  )
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
// The phases every new ticket of the project starts with; null goes back to the built-in list.
const DefaultPhases = z.array(z.string().trim().min(1).max(500)).max(20).nullable()
api.patch('/api/projects/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      name: z.string().min(1).max(100).optional(),
      instructions: Instructions.optional(),
      defaultPhases: DefaultPhases.optional(),
    }),
  )
  // They shape every new ticket of the project: agents change the phases of a ticket instead.
  if (body.defaultPhases !== undefined && isAgent(request))
    throw new HttpError(403, "only the human sets the project's default phases")
  return json(projects.updateProject(id(params), body, actor))
})
api.delete('/api/projects/:id', ({ params, actor }) => {
  stopProjectPreviews(id(params), actor)
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
// ?moveTo=<key> is where its tickets go; required when it has any. Into a done stage, ?force=1 moves
// tickets whose needs are not merged yet.
api.delete('/api/projects/:id/stages/:stageId', async ({ request, params, url, actor }) => {
  humanOnly(request)
  await needs.removeStage(
    id(params),
    id(params, 'stageId'),
    { moveTo: url.searchParams.get('moveTo') ?? undefined, force: url.searchParams.get('force') === '1' },
    actor,
  )
  return json({ ok: true })
})

// --- the project's agents (personas a connected agent delegates to) ---
const AgentBody = z.object({
  name: AgentName,
  instructions: Instructions.optional(),
  // For the orchestrator: when to delegate to this agent, what to give it, what comes back.
  delegation: Instructions.optional(),
  // An upload from POST /api/uploads, shown as the agent's picture.
  avatarId: z.number().int().nullable().optional(),
})
const humanAgents = (request: Request) => {
  if (isAgent(request)) throw new HttpError(403, "only the human edits the project's agents")
}
api.get('/api/projects/:id/agents', ({ params }) => {
  projects.getProject(id(params))
  return json(projectAgents.listAgents(id(params)))
})
api.post('/api/projects/:id/agents', async ({ request, params, actor }) => {
  humanAgents(request)
  return json(projectAgents.createAgent(id(params), await readJson(request, AgentBody), actor), 201)
})
// The default agents (the build and review cycle); the ones the project already has are kept.
api.post('/api/projects/:id/agents/defaults', ({ request, params, actor }) => {
  humanAgents(request)
  projects.getProject(id(params))
  return json(addDefaultAgents(id(params), actor), 201)
})
api.patch('/api/agents/:id', async ({ request, params, actor }) => {
  humanAgents(request)
  return json(projectAgents.updateAgent(id(params), await readJson(request, AgentBody.partial()), actor))
})
// Its reserved tickets become shared and unassigned.
api.delete('/api/agents/:id', ({ request, params, actor }) => {
  humanAgents(request)
  projectAgents.deleteAgent(id(params), actor)
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
// unassigned), ?q= text found (any casing) in the ticket's #id, title, instructions or thread (its posts and the
// replies under them): those found by name (#id, title) first, then the rest, each row with `match` (where) and
// `snippet` (the words around a content hit). Archived tickets are left out; ?archived=include adds them,
// ?archived=only lists just those.
api.get('/api/projects/:id/tickets', async ({ params, url }) => {
  const q = url.searchParams
  const parent = q.get('parent')
  const parentId = parent === null ? undefined : parent === 'root' ? null : intParam(parent, 'parent')
  const status = q.get('status')
  const archived = q.get('archived')
  return json(
    await needs.ticketRows(id(params), {
      parentId,
      tag: q.get('tag') ?? undefined,
      status: status ? z.array(Status).parse(status.split(',')) : undefined,
      assignee: q.get('assignee') ?? undefined,
      q: q.get('q') ?? undefined,
      archived: archived ? z.enum(['include', 'only']).parse(archived) : undefined,
    }),
  )
})
api.post('/api/projects/:id/tickets', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    TicketPatch.extend({
      title: z.string().min(1).max(200),
      tasks: z.array(NewTask).optional(),
      parentId: z.number().int().optional(),
      attachmentIds: z.array(z.number().int()).optional(),
      // Start with the project's default phases: a top-level ticket does unless false, a lane only if true.
      defaultPhases: z.boolean().optional(),
    }),
  )
  return json(await needs.newTicket(id(params), body, actor, { agent: isAgent(request) }), 201)
})
// ?lanes=1 folds the lanes' updates into the feed. `resume` is the resume note with what happened since.
api.get('/api/tickets/:id', async ({ request, params, url }) =>
  json(
    await forAgent(
      request,
      await needs.ticketView(id(params), { laneUpdates: url.searchParams.get('lanes') === '1' }),
    ),
  ),
)
// An agent cannot reassign a ticket reserved for one of the project's agents; the human can. A move to a
// done stage is a 409 (code: needs) while what it needs is not merged; force: true is the human's way past.
api.patch('/api/tickets/:id', async ({ request, params, actor }) =>
  json(
    await needs.changeTicket(
      id(params),
      await readJson(request, TicketPatch.extend({ force: z.boolean().optional() })),
      actor,
      { agent: isAgent(request) },
    ),
  ),
)
// Files for the instructions: uploads (POST /api/uploads) bound to the ticket.
api.post('/api/tickets/:id/attachments', async ({ request, params, actor }) => {
  const body = await readJson(request, z.object({ attachmentIds: z.array(z.number().int()).min(1) }))
  return json(features.attachToTicket(id(params), body.attachmentIds, actor), 201)
})
api.delete('/api/tickets/:id/attachments/:attachmentId', ({ params, actor }) => {
  features.removeTicketFile(id(params), id(params, 'attachmentId'), actor)
  return json({ ok: true })
})
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
      // Approving a PR review moves it to done: past needs not merged yet, as with PATCH.
      force: z.boolean().optional(),
    }),
  )
  return json(
    await needs.judgeTicket(id(params), body.verdict, actor, { reopenTo: body.reopenTo, force: body.force }),
  )
})
// Assigns the ticket to the caller (or, with `as`, to the project agent the caller works it as) and starts
// it; 409 when it is reserved for another of the project's agents.
// The archive is the human's, like the board's layout: finished tickets come off the board, lanes with them.
const humanArchive = (request: Request) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human archives and restores tickets')
}
// Every top-level ticket in one done or cancelled stage (status: its key, name or kind).
api.post('/api/projects/:id/tickets/archive', async ({ request, params, actor }) => {
  humanArchive(request)
  const body = await readJson(request, z.object({ status: Status }))
  return json(features.archiveStage(id(params), body.status, actor))
})
// One top-level ticket in a done or cancelled stage; its page keeps working.
api.post('/api/tickets/:id/archive', ({ request, params, actor }) => {
  humanArchive(request)
  return json(features.archiveTicket(id(params), actor))
})
api.post('/api/tickets/:id/restore', ({ request, params, actor }) => {
  humanArchive(request)
  return json(features.restoreTicket(id(params), actor))
})
api.post('/api/tickets/:id/claim', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ branch: z.string().max(200).optional(), as: AgentName.optional() }),
  )
  return json(await withResume(features.claimTicket(id(params), actor, body)))
})
// The resume note ("Where we left off"): the human and agents both write it; `as` is agents only.
api.put('/api/tickets/:id/resume', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ note: z.string().min(1).max(50_000), as: AgentName.optional() }),
  )
  if (body.as) agentOnly(request)
  return json(await features.setResumeNote(id(params), body.note, actor, { as: body.as }))
})
api.get('/api/tickets/:id/git', async ({ params }) => json(await needs.ticketGitView(id(params))))
// Whether the branch of every ticket in work is on origin, one batch of git per repo; refresh fetches now.
api.get('/api/projects/:id/push', async ({ params }) => json(await projectPush(id(params))))
api.post('/api/projects/:id/push/refresh', async ({ params }) => json(await refreshProjectPush(id(params))))
// Closed tickets that still have workspaces, branches or worktrees; `reach=0` skips the merge checks.
api.get('/api/projects/:id/cleanup', async ({ params, url }) =>
  json(await cleanupReport(id(params), { reach: url.searchParams.get('reach') !== '0' })),
)
// The human deletes closed tickets' worked branches, here or on origin, or with their worktrees, once
// confirmed on the Cleanup page; each is checked again first. Never an agent: they get 403.
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'a full commit sha')
api.post('/api/projects/:id/cleanup/delete', async ({ request, params, actor }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human deletes branches and worktrees')
  const body = await readJson(
    request,
    z.object({
      items: z
        .array(
          z.object({
            ticketId: z.number().int(),
            branch: z.string().min(1).max(250),
            kind: z.enum(DELETE_KINDS),
            sha: Sha.nullable(),
            worktrees: z.array(z.string().min(1).max(1000)).max(50).optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  )
  return json(await deleteLeftovers(id(params), body.items, actor))
})

// Every preview of the project's tickets, running or not, running first, and the board-wide use of the
// preview limit; reads only.
api.get('/api/projects/:id/previews', async ({ params }) => json(await projectPreviewsPage(id(params))))
// Stop all: the previews the board runs for the project, and the links it may stop (linkPreview.ts).
api.post('/api/projects/:id/previews/stop', async ({ request, params, actor }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human stops all the previews of a project')
  return json(await stopProjectLinksAndPreviews(id(params), actor))
})

// parentTaskId adds them as subtasks of that top-level task.
api.post('/api/tickets/:id/tasks', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ tasks: z.array(NewTask).min(1), parentTaskId: z.number().int().positive().optional() }),
  )
  return json(features.addTasks(id(params), body.tasks, actor, { parentTaskId: body.parentTaskId }), 201)
})
// Agents and the human alike: a tick, new text, or the blocked tag (blocked, blockedReason). Ticking
// clears the tag, tagging a done task reopens it, and both at once is a 400.
api.patch('/api/tasks/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ done: z.boolean().optional(), text: TaskText.optional(), ...TaskBlocked }),
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
      previewUrl: PreviewUrl.optional(),
    }),
  )
  return json(features.addWorkspace(id(params), body, actor), 201)
})
// Set or clear (null, '') the link where the workspace's branch runs for the human to try.
api.patch('/api/workspaces/:id', async ({ request, params, actor }) => {
  const body = await readJson(request, z.object({ previewUrl: PreviewUrl }))
  return json(features.setWorkspacePreview(id(params), body.previewUrl, actor))
})
// Whether that preview answers right now: `{running, status?, checkedAt, url}`, localhost URLs only;
// `managed`, the preview the board runs from the workspace; `cannotStart`, why it would not start one.
api.get('/api/workspaces/:id/preview', async ({ params }) =>
  json(await features.workspacePreview(id(params))),
)
// The board builds and runs the workspace's worktree as a preview (in the background; poll the GET).
api.post('/api/workspaces/:id/preview/start', ({ params, actor }) =>
  json(startPreview(id(params), actor), 202),
)
api.post('/api/workspaces/:id/preview/stop', async ({ params, actor }) => {
  if (!isActive(managedPreview(id(params))))
    throw new HttpError(409, 'the board runs no preview of this workspace')
  return json(await stopPreview(id(params), `stopped by ${actor}`, actor))
})
// The server an agent started behind the workspace's link, when the board can tell it runs from the
// workspace's worktree (linkPreview.ts). The board did not start it: the human's call only.
api.post('/api/workspaces/:id/preview/stop-link', async ({ request, params, actor }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human stops a preview the board did not start')
  return json(await stopLinkPreview(id(params), actor))
})
api.post('/api/workspaces/:id/preview/restart', async ({ params, actor }) =>
  json(await restartPreview(id(params), actor), 202),
)
// ?name=build (install and build) or server.
api.get('/api/workspaces/:id/preview/log', ({ params, url }) => {
  const name = z.enum(['build', 'server']).catch('build').parse(url.searchParams.get('name'))
  return new Response(previewLog(id(params), name), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
})
api.delete('/api/workspaces/:id', ({ params, actor }) => {
  features.deleteWorkspace(id(params), actor)
  return json({ ok: true })
})

// A post on the ticket; `progress` (default true, as agents post) marks a step of the work.
api.post('/api/tickets/:id/updates', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      body: z.string().min(1).max(50_000),
      attachmentIds: z.array(z.number().int()).default([]),
      as: AgentName.optional(),
      progress: z.boolean().default(true),
    }),
  )
  if (body.as) agentOnly(request)
  return json(
    features.postUpdate(id(params), body.body, body.attachmentIds, actor, {
      as: body.as,
      progress: body.progress,
    }),
    201,
  )
})
// A decision for the human: the question (body) and 2 to 5 options; blocks the ticket unless block: false.
api.post('/api/tickets/:id/decisions', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      body: z.string().min(1).max(50_000),
      options: z
        .array(
          z.object({
            label: z.string().min(1).max(200),
            detail: z.string().max(2_000).optional(),
            recommended: z.boolean().optional(),
          }),
        )
        .min(2)
        .max(5),
      as: AgentName.optional(),
      block: z.boolean().default(true),
    }),
  )
  if (body.as) agentOnly(request)
  return json(features.askDecision(id(params), body, actor), 201)
})
// Only the human decides; agents read the answer.
api.put('/api/updates/:id/decision', async ({ request, params, actor }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human decides')
  const body = await readJson(
    request,
    z.object({ option: z.number().int().min(0), note: z.string().max(5_000).default('') }),
  )
  return json(features.decide(id(params), body.option, body.note, actor))
})
// The orchestrator's record of the human's answer given in the chat: only a connected agent, and never
// as one of the project's agents (features.relayDecision checks both, and that the card is open).
api.post('/api/updates/:id/decision/relay', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      option: z.number().int().min(0),
      words: z.string().trim().min(1).max(5_000),
      as: AgentName.optional(),
    }),
  )
  return json(features.relayDecision(id(params), body, actor, { agent: isAgent(request) }))
})
// Its author edits or deletes a post or reply; the human (passkey) any.
api.patch('/api/updates/:id', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({ body: z.string().min(1).max(50_000).optional(), progress: z.boolean().optional() }),
  )
  return json(features.editPost(id(params), body, actor, { human: !isAgent(request) }))
})
api.delete('/api/updates/:id', ({ request, params, actor }) => {
  features.deletePost(id(params), actor, { human: !isAgent(request) })
  return json({ ok: true })
})

// --- comments ---
api.get('/api/comments', async ({ request, url }) => {
  const parentType = query(z.enum(COMMENT_PARENTS), url.searchParams.get('parentType'), 'parentType')
  const parentId = intParam(url.searchParams.get('parentId') ?? '', 'parentId')
  return json(await forAgent(request, features.listComments(parentType, parentId)))
})
// Threads in a project where someone spoke after the caller, on things the caller owns or spoke in;
// ?since=<cursor> keeps only the ones with something new. /inbox is the same without bodies.
api.get('/api/projects/:id/threads', ({ params, url, actor }) =>
  json(features.myThreads(id(params), actor, url.searchParams.get('since'))),
)
api.get('/api/projects/:id/inbox', ({ params, url, actor }) =>
  json(features.checkInbox(id(params), actor, url.searchParams.get('since'))),
)
api.post('/api/comments', async ({ request, actor }) => {
  const body = await readJson(
    request,
    z.object({
      parentType: z.enum(COMMENT_PARENTS),
      parentId: z.number().int(),
      replyTo: z.number().int().nullable().optional(),
      body: z.string().min(1).max(20_000),
      attachmentIds: z.array(z.number().int()).optional(),
      as: AgentName.optional(),
    }),
  )
  if (body.as) agentOnly(request)
  return json(features.addComment(body, actor), 201)
})
api.patch('/api/comments/:id', async ({ request, params, actor }) => {
  const body = await readJson(request, z.object({ body: z.string().min(1).max(20_000) }))
  return json(features.editComment(id(params), body.body, actor, { human: !isAgent(request) }))
})
api.delete('/api/comments/:id', ({ request, params, actor }) => {
  features.deleteComment(id(params), actor, { human: !isAgent(request) })
  return json({ ok: true })
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
      ? await uploads.saveFromPath(body.path, actor)
      : await uploads.saveBase64(body.name, body.base64, actor, body.mime)
  return json({ ...a, url: uploads.attachmentUrl(a) }, 201)
})
// Uploads nothing points at, older than a day (the board also does this hourly); the human's call.
api.delete('/api/uploads/unattached', async ({ request }) => {
  if (isAgent(request)) throw new HttpError(403, 'only the human deletes unattached uploads')
  return json(await deleteUnattachedUploads())
})
// For agents: the file's local path is there to open (fetched into the cache first with STORAGE=s3).
api.get('/api/uploads/:id/info', async ({ params }) =>
  json(await uploads.ensureLocalFiles(uploads.attachmentView(uploads.getAttachment(id(params))))),
)
// The bytes, whole or the one range asked for (videos seek with Range).
api.get('/api/uploads/:id', async ({ request, params }) => {
  const a = uploads.getAttachment(id(params))
  const range = parseRange(request.headers.get('range'), a.size)
  const stream = await fileStore.read(a.storedAs, range ?? undefined)
  const headers: Record<string, string> = {
    'content-type': a.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition': `inline; filename="${encodeURIComponent(a.name)}"`,
  }
  const body = Readable.toWeb(stream) as ReadableStream
  if (!range) return new Response(body, { headers: { ...headers, 'content-length': String(a.size) } })
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${a.size}`,
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

// --- summary: what waits on the human, in progress, done today, next, carrying over ---
// ?projectId= for one project; every project otherwise, one block each.
api.get('/api/summary', ({ url }) => {
  const project = url.searchParams.get('projectId')
  return json(getSummary(project ? intParam(project, 'projectId') : undefined, { refreshPrs: true }))
})

// --- daily ---
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
/** A query parameter that must match `schema`: a 400 naming it otherwise. */
const query = <T extends z.ZodType>(schema: T, value: unknown, name: string): z.infer<T> => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpError(400, `${name}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}
api.get('/api/daily', ({ url }) => {
  const date = Day.parse(url.searchParams.get('date') ?? today())
  const project = url.searchParams.get('projectId')
  return json(dailyReport(date, project ? intParam(project, 'projectId') : undefined))
})

// --- reports: how a project's reports are made and when they are due, and the reports per period ---
api.get('/api/projects/:id/report-settings', ({ params }) => json(reports.getReportSettings(id(params))))
// Agents may change them too; a change of the prompt or template by an agent waits on the human.
api.patch('/api/projects/:id/report-settings', async ({ request, params, actor }) =>
  json(
    reports.setReportSettings(id(params), await readJson(request, reports.ReportSettingsPatch), actor, {
      agent: isAgent(request),
    }),
  ),
)
// Every change of the prompt or the template, newest first; ?field=prompt|template keeps one.
api.get('/api/projects/:id/report-settings/changes', async ({ params, url }) => {
  const field = url.searchParams.get('field')
  return json(
    await settingsHistory.listChanges(id(params), {
      field: field ? query(z.enum(['prompt', 'template']), field, 'field') : undefined,
    }),
  )
})
api.get('/api/report-settings/changes/:id', async ({ params }) =>
  json(await settingsHistory.getChange(id(params))),
)
// Only the human settles an agent's change: keep it, or put the field back as it was before it.
const humanSettles = (request: Request) => {
  if (isAgent(request))
    throw new HttpError(403, "only the human accepts or reverts a change of the report's prompt or template")
}
api.post('/api/report-settings/changes/:id/accept', async ({ request, params, actor }) => {
  humanSettles(request)
  return json(await settingsHistory.acceptChange(id(params), actor))
})
api.post('/api/report-settings/changes/:id/revert', async ({ request, params, actor }) => {
  humanSettles(request)
  return json(await settingsHistory.revertChange(id(params), actor))
})
// ?from=&to= (YYYY-MM-DD): the periods in between, newest first, each with its status and latest report.
api.get('/api/projects/:id/reports', async ({ request, params, url }) =>
  json(
    await forAgent(
      request,
      reports.listReports(id(params), {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      }),
    ),
  ),
)
// period defaults to the current one; attachmentIds are uploads (POST /api/uploads) to attach.
api.post('/api/projects/:id/reports', async ({ request, params, actor }) => {
  const body = await readJson(
    request,
    z.object({
      period: Day.optional(),
      body: z.string().max(100_000).optional(),
      attachmentIds: z.array(z.number().int()).default([]),
    }),
  )
  return json(await reports.postReport(id(params), body, actor), 201)
})
// claude writes the period's report (the current one without period) from the prompt, the template and
// the period's activity, stored as a new version; 409 while one is being written for the project.
api.post('/api/projects/:id/reports/generate', async ({ request, params }) => {
  const GenerateBody = z.object({ period: Day.optional() })
  const body = (await request.clone().text()).trim() ? await readJson(request, GenerateBody) : {}
  return json(await generateReport(id(params), body), 201)
})
// Every version posted for a period, newest first.
api.get('/api/projects/:id/reports/:period', async ({ request, params }) =>
  json(await forAgent(request, reports.reportVersions(id(params), params.period!))),
)
// Every project's report for the period holding ?date= (today by default), for the all-projects Daily page.
api.get('/api/reports/overview', async ({ request, url }) =>
  json(
    await forAgent(
      request,
      await reportsOverview(query(Day, url.searchParams.get('date') ?? today(), 'date')),
    ),
  ),
)
// The projects whose report the board is reminding about right now (due soon, or missing).
api.get('/api/report-due', async () => json({ items: await reportsDue() }))
// What reached origin today on the project's repos: commits and lines, by repo and branch.
api.get('/api/projects/:id/pushed-today', async ({ params }) => json(await pushedToday(id(params))))

// --- MCP ---
api.on('POST', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
api.on('GET', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
api.on('DELETE', '/api/mcp', ({ request, actor }) => handleMcp(request, actor))
