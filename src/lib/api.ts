/**
 * JSON client for /api. The board's session cookie does the auth; a 401 on a page means the session is
 * gone, and the reload lands on /login.
 */

import type {
  Attachment,
  Comment,
  Repo,
  RunConfig,
  ReportSettingsChange,
  ReviewResult,
  Task,
  Ticket,
  Update,
  Workspace,
  Activity,
} from '#/db/schema'
import type { ReportStatus } from '#/lib/reports'
import type { PushedToday } from '#/server/pushedToday'
import type { ReportDue } from '#/server/reportDue'
import type { ReportList, ReportPeriod, ReportSettingsView, ReportView } from '#/server/reports'
import type { ReportsOverview } from '#/server/reportsOverview'
import type { Need, NeededBy, TicketListRow as TicketRow, TicketView as TicketFull } from '#/server/needs'
import type { WorkspacePreview, summaryHistory } from '#/server/features'
import type { RoadmapTicket } from '#/server/roadmap'
import type { CleanupReport } from '#/server/cleanup'
import type { DeleteItem, DeleteKind, DeleteResult } from '#/server/cleanupActions'
import type { BranchInfo, Reach, Worktree } from '#/server/git'
import type { DirListing } from '#/server/fs'
import type { Gallery, GalleryFile } from '#/server/gallery'
import type { Handoff } from '#/server/handoff'
import type { HostTool, HostTools } from '#/server/hostTools'
import type { ManagedPreview } from '#/server/managedPreview'
import type { RunState } from '#/server/runs'
import type {
  AlsoRunning,
  OrphanedRun,
  RunOutcome,
  TicketRun,
  TicketRuns,
  TicketRunsRepo,
} from '#/server/ticketRuns'
import type { PreviewState } from '#/server/preview'
import type { LinkStopped, StopAll } from '#/server/linkPreview'
import type { ProjectPreview, ProjectPreviews } from '#/server/projectPreviews'
import type { ProjectFull, listProjects } from '#/server/projects'
import type { PrRow } from '#/server/prs'
import type { ProjectPush, Push } from '#/server/push'
import type { ProjectAgent } from '#/server/projectAgents'
import type { CarryOver, ProjectSummary, Summary } from '#/server/summary'
import type { ProjectWork, TicketEvent } from '#/server/workTimeline'
import type { WorkTimeline } from './workTimeline'

/** A project as the API returns it: always with its repos. */
export type Project = ProjectFull
/** A row of `/api/projects`: the project, its repos, and how many tickets and open PRs it holds. */
export type ProjectRow = ReturnType<typeof listProjects>[number]

export type {
  RoadmapTicket,
  ProjectWork,
  TicketEvent,
  WorkTimeline,
  CarryOver,
  DirListing,
  Gallery,
  GalleryFile,
  Handoff,
  HostTool,
  HostTools,
  ManagedPreview,
  PreviewState,
  ProjectAgent,
  RunConfig,
  RunOutcome,
  RunState,
  OrphanedRun,
  AlsoRunning,
  TicketRun,
  TicketRuns,
  TicketRunsRepo,
  LinkStopped,
  ProjectPreview,
  ProjectPreviews,
  ProjectSummary,
  StopAll,
  Summary,
  WorkspacePreview,
}
export type {
  PushedToday,
  ReportDue,
  ReportList,
  ReportPeriod,
  ReportSettingsChange,
  ReportSettingsView,
  ReportStatus,
  ReportsOverview,
  ReportView,
}

export type {
  Attachment,
  Comment,
  Repo,
  ReviewResult,
  Task,
  Ticket,
  Update,
  Workspace,
  Activity,
  TicketFull,
  TicketRow,
  Need,
  NeededBy,
  PrRow,
  BranchInfo,
  Worktree,
  Reach,
  CleanupReport,
  DeleteItem,
  DeleteKind,
  DeleteResult,
  Push,
  ProjectPush,
}

export class ApiError extends Error {
  status: number
  /** Which refusal it is, when the server names it (`needs`: a need is not merged yet). */
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    if (res.status === 401) window.location.reload()
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `${res.status} ${res.statusText}`
    const code =
      data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
        ? data.code
        : undefined
    // The board has no account yet (its data was replaced under the page): the reload lands on /setup.
    if (res.status === 409 && code === 'setup') window.location.reload()
    throw new ApiError(message, res.status, code)
  }
  return data as T
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    Accept: 'application/json',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const get = <T>(url: string) => request<T>(url, jsonInit('GET'))
export const post = <T>(url: string, body?: unknown) => request<T>(url, jsonInit('POST', body))
export const patch = <T>(url: string, body?: unknown) => request<T>(url, jsonInit('PATCH', body))
export const put = <T>(url: string, body?: unknown) => request<T>(url, jsonInit('PUT', body))
export const del = <T>(url: string) => request<T>(url, jsonInit('DELETE'))

export function upload(file: File): Promise<Attachment & { url: string }> {
  const form = new FormData()
  form.append('file', file)
  return request('/api/uploads', { method: 'POST', body: form })
}

export function errorMessage(err: unknown, fallback = 'something went wrong'): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// --- payload shapes the server composes ---

/** `/api/me`: who you are, and whether this board runs with sign-in off (never the live one). */
export interface Me {
  actor: string
  agent: boolean
  boardEnv: 'production' | 'development' | 'test'
  authOff: boolean
}

export type CommentRow = Comment & { attachments: (Attachment & { url: string })[] }
export type UpdateRow = TicketFull['updates'][number]
export type LaneRow = TicketFull['lanes'][number]
/** GET /api/tickets/:id/summary: the summary as the ticket shows it, and every version, newest first. */
export interface SummaryHistory {
  summary: TicketFull['summary']
  versions: ReturnType<typeof summaryHistory>
}

export type GitInfo = BranchInfo & { reach: Reach | null; push: Push }

/** GET /api/tickets/:id/events: every event of the ticket, newest first, and its work timeline. */
export interface TicketEvents {
  events: TicketEvent[]
  timeline: WorkTimeline
}

export interface TicketGit {
  /** The primary repo, its branch and base, and that branch's state. */
  repo: { id: number; name: string } | null
  branch: string
  baseBranch: string
  info: GitInfo
  /** Every repo the ticket spans, the primary first, each with its branch, its state and its PR. */
  repos: {
    repo: { id: number; name: string }
    primary: boolean
    branch: string
    baseBranch: string
    info: GitInfo
    pr: TicketFull['pr']
  }[]
  workspaces: (Workspace & {
    /** The repo it is a worktree of. */
    repo: { id: number; name: string } | null
    info: BranchInfo & { reach: Reach | null; push: Push }
    worktree: Worktree | null
    lane: { id: number; title: string } | null
  })[]
  /** Open tickets whose unmerged work the ticket's branch holds. */
  includes: number[]
}

/** `/api/daily`: a day's activity, every write in order, with its project's name. */
export interface DailyPayload {
  date: string
  projects: { id: number; name: string }[]
  activity: (Activity & { project: string | null })[]
}

/** `/api/report-due`: the projects whose report the board is reminding about right now. */
export interface ReportDueList {
  items: ReportDue[]
}

/** `POST /api/report-settings/changes/:id/revert`: the change, now reverted, and the settings after it. */
export interface RevertedChange {
  change: ReportSettingsChange
  settings: ReportSettingsView
}
