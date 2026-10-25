import type { APIRequestContext } from '@playwright/test'

import type { Project, RunConfig } from '#/lib/api'
import { DEFAULT_RUN, type RunConfigInput } from '#/lib/runs'
import { ok } from './fixtures'

/**
 * The board's own preview as a run of the project's repo, as a checkout of the board is given it: the
 * run's repo is a plain git repo (no package.json), so nothing seeds it there. Once per repo.
 */
export async function boardPreview(human: APIRequestContext, project: Project) {
  const repoId = project.repos[0]!.id
  const runs = await ok<RunConfig[]>(human.get(`/api/repos/${repoId}/runs`))
  const had = runs.find((r) => r.name === DEFAULT_RUN.name)
  return had ?? ok<RunConfig>(human.post(`/api/repos/${repoId}/runs`, { data: DEFAULT_RUN }))
}

/** A run of the repo, as the human saves it in the project's settings. */
export const addRun = (
  human: APIRequestContext,
  repoId: number,
  run: Partial<RunConfigInput> & { name: string },
) =>
  ok<RunConfig>(
    human.post(`/api/repos/${repoId}/runs`, { data: { type: 'preview', start: 'node server.js', ...run } }),
  )
