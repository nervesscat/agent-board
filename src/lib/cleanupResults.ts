import type { DeleteItem, DeleteResult } from '#/lib/api'

/**
 * What a Cleanup delete's job carries, read the same by the page that started it and by the top bar's
 * card: the job's kind, the items it answered, and the counts and retry its result comes to.
 */

/** The job registry's kind for a Cleanup delete: the page and the top-bar card read it by name. */
export const CLEANUP_DELETE_JOB = 'cleanup-delete'

const KINDS = ['local', 'remote', 'worktrees']
const OUTCOMES = ['deleted', 'gone', 'refused', 'failed']

/** Whether `value` is one item's outcome as a delete answers it (`DeleteResult`), checked as it comes. */
export function isDeleteResult(value: unknown): value is DeleteResult {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<DeleteResult>
  return (
    typeof r.ticketId === 'number' &&
    typeof r.branch === 'string' &&
    typeof r.ok === 'boolean' &&
    KINDS.includes(r.kind as string) &&
    OUTCOMES.includes(r.outcome as string)
  )
}

/** A job's result as the items a delete answered, or null when it carries something else. */
export function deleteResults(value: unknown): DeleteResult[] | null {
  return Array.isArray(value) && value.every(isDeleteResult) ? value : null
}

export interface DeleteCounts {
  deleted: number
  /** Refused and failed: the items a retry may ask for again. */
  kept: number
  gone: number
  /** How it reads in a toast or a card: `3 deleted, 1 kept`, `2 deleted, 1 already gone`. */
  text: string
}

/**
 * What a run did in counts: `deleted` counts what it deleted, `kept` what was refused or failed (a
 * retry's items), and one already gone is neither.
 */
export function countsOf(results: DeleteResult[]): DeleteCounts {
  const deleted = results.filter((r) => r.outcome === 'deleted').length
  const kept = results.filter((r) => !r.ok).length
  const gone = results.filter((r) => r.outcome === 'gone').length
  const parts = [`${deleted} deleted`]
  if (kept) parts.push(`${kept} kept`)
  if (gone) parts.push(`${gone} already gone`)
  return { deleted, kept, gone, text: parts.join(', ') }
}

/** The items a retry asks for again: the refused and failed ones, exactly as they were asked. */
export function keptItems(results: DeleteResult[]): DeleteItem[] {
  return results
    .filter((r) => !r.ok)
    .map(({ ticketId, branch, kind, sha, worktrees }) => ({
      ticketId,
      branch,
      kind,
      sha,
      ...(worktrees ? { worktrees } : {}),
    }))
}
