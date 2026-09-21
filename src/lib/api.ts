/** JSON client for /api. The gate cookie does the auth; a 401 on a page means the session is gone. */

import type {
  Attachment,
  Comment,
  DailySummary,
  Project,
  ReviewResult,
  ReviewRun,
  ReviewSchedule,
  Task,
  Ticket,
  Update,
  Workspace,
  Activity,
} from '#/db/schema'
import type { TicketFull } from '#/server/features'
import type { BranchInfo, Worktree } from '#/server/git'
import type { PrRow } from '#/server/prs'

export type {
  Attachment,
  Comment,
  DailySummary,
  Project,
  ReviewResult,
  ReviewRun,
  ReviewSchedule,
  Task,
  Ticket,
  Update,
  Workspace,
  Activity,
  TicketFull,
  PrRow,
  BranchInfo,
  Worktree,
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
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
    throw new ApiError(message, res.status)
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

export type TicketRow = Ticket & { progress: { done: number; total: number } }
export type CommentRow = Comment & { attachments: (Attachment & { url: string })[] }
export type UpdateRow = TicketFull['updates'][number]

export interface TicketGit {
  branch: string
  baseBranch: string
  info: BranchInfo
  workspaces: (Workspace & { info: BranchInfo; worktree: Worktree | null })[]
}

export type RunRow = Omit<ReviewRun, 'log'>

export interface ReviewsPayload {
  running: boolean
  runs: RunRow[]
  results: ReviewResult[]
  schedules: ReviewSchedule[]
}

export interface DailyPayload {
  date: string
  projects: { id: number; name: string }[]
  activity: (Activity & { project: string | null })[]
  summaries: DailySummary[]
}
