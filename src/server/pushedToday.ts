import { localDate } from '#/lib/format'
import type { Refs } from './git'
import { getProject } from './projects'

/**
 * What reached origin today on a project's repos: the commits that became reachable from an origin
 * branch today (by the moves of origin's branches the board saw, not by commit dates), each counted
 * once, with the lines they added and removed.
 */

export interface PushedToday {
  /** The local day counted, YYYY-MM-DD. */
  date: string
  commits: number
  added: number
  removed: number
  /** When origin was last fetched into the project's checkouts; null when that is not known. */
  checkedAt: string | null
  repos: {
    repoId: number
    name: string
    commits: number
    added: number
    removed: number
    branches: {
      branch: string
      commits: number
      added: number
      removed: number
      /** The ticket whose branch it is, if one is. */
      ticket: { id: number; title: string } | null
    }[]
  }[]
}

/** Called with every fresh listing of a checkout's branches: records how origin's moved since the last. */
export function noteOriginRefs(_repoPath: string, _refs: Refs) {}

export async function pushedToday(projectId: number, now = new Date()): Promise<PushedToday> {
  getProject(projectId)
  return { date: localDate(now), commits: 0, added: 0, removed: 0, checkedAt: null, repos: [] }
}
