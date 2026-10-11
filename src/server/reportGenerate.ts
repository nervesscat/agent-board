import { HttpError } from './http'

/**
 * A project's report for a period, written by claude from the project's prompt, its template and the
 * period's activity, checked against the template and stored as a new version by `claude`. One run per
 * project at a time; the state of the last one is kept for the Daily page.
 */

export interface GenerationState {
  /** The period being generated right now, or null. */
  period: string | null
  /** Why the last run for a period failed, until a later one succeeds. */
  error: { period: string; message: string; at: string } | null
}

/** Generates the report of `period` (any day of it; the current period by default). */
export async function generateReport(
  _projectId: number,
  _input: { period?: string } = {},
  _now = new Date(),
): Promise<never> {
  throw new HttpError(501, 'generating a report with claude is not available yet')
}

export function generationState(_projectId: number): GenerationState {
  return { period: null, error: null }
}
