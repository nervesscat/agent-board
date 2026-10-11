/** JSON client for /api. The gate cookie does the auth; a 401 on a page means the session is gone. */

import type {
  Attachment,
  Comment,
  DailySummary,
  Repo,
  ReportSettings,
  ReviewResult,
  Task,
  Ticket,
  Update,
  Workspace,
  Activity,
} from '#/db/schema'
import type { ReportList, ReportPeriod, ReportView } from '#/server/reports'
import type { Need, NeededBy, TicketListRow as TicketRow, TicketView as TicketFull } from '#/server/needs'
import type { WorkspacePreview } from '#/server/features'
import type { CleanupReport } from '#/server/cleanup'
import type { BranchInfo, Reach, Worktree } from '#/server/git'
import type { DirListing } from '#/server/fs'
import type { Handoff } from '#/server/handoff'
import type { ManagedPreview } from '#/server/managedPreview'
import type { PreviewState } from '#/server/preview'
import type { ProjectPreview } from '#/server/projectPreviews'
import type { ProjectFull, listProjects } from '#/server/projects'
import type { PrRow } from '#/server/prs'
import type { ProjectPush, Push } from '#/server/push'
import type { ProjectAgent } from '#/server/projectAgents'
import type { CarryOver, ProjectSummary, Summary } from '#/server/summary'

/** A project as the API returns it: always with its repos. */
export type Project = ProjectFull
/** A row of `/api/projects`: the project, its repos, and how many tickets and open PRs it holds. */
export type ProjectRow = ReturnType<typeof listProjects>[number]

export type {
  CarryOver,
  DirListing,
  Handoff,
  ManagedPreview,
  PreviewState,
  ProjectAgent,
  ProjectPreview,
  ProjectSummary,
  Summary,
  WorkspacePreview,
}
export type { ReportList, ReportPeriod, ReportSettings, ReportView }

export type {
  Attachment,
  Comment,
  DailySummary,
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

/** `/api/me`: who you are, and whether this board runs without the passkey gate (never the live one). */
export interface Me {
  actor: string
  agent: boolean
  boardEnv: 'production' | 'development' | 'test'
  authOff: boolean
}

export type CommentRow = Comment & { attachments: (Attachment & { url: string })[] }
export type UpdateRow = TicketFull['updates'][number]
export type LaneRow = TicketFull['lanes'][number]

export interface TicketGit {
  repo: { id: number; name: string } | null
  branch: string
  baseBranch: string
  info: BranchInfo & { reach: Reach | null; push: Push }
  workspaces: (Workspace & {
    info: BranchInfo & { reach: Reach | null; push: Push }
    worktree: Worktree | null
    lane: { id: number; title: string } | null
  })[]
  /** Open tickets whose unmerged work the ticket's branch holds. */
  includes: number[]
}

export interface DailyPayload {
  date: string
  projects: { id: number; name: string }[]
  activity: (Activity & { project: string | null })[]
  summaries: DailySummary[]
  generating: boolean
}
