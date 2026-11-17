import fs from 'node:fs'
import path from 'node:path'

import { config } from './config'

/**
 * The plain folder of a project with no software kind: work in progress that is not code (audio,
 * images, documents) lives here, with no git. One folder per project under the board's data folder;
 * agents read the path from get_project (`workFolder`) and attach what they finish to the ticket.
 */
export function projectWorkFolder(projectId: number, dataDir: string = config.dataDir): string {
  return path.join(dataDir, 'projects', String(projectId))
}

/** The project's folder, created when it is not there yet. */
export function ensureProjectWorkFolder(projectId: number, dataDir: string = config.dataDir): string {
  const dir = projectWorkFolder(projectId, dataDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
