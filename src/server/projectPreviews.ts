import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { cannotStart, isActive, managedPreview, type ManagedPreview } from './managedPreview'
import { isLocalUrl, previewState, type PreviewState } from './preview'
import { getProject } from './projects'

/**
 * Every preview of a project on one page: each workspace of its tickets (lanes, done and cancelled
 * ones too; archived ones are put away) that has a preview link or a preview the board ran, running or
 * not. It only reads: the links answer from the shared liveness check, all at once.
 */

export interface ProjectPreview {
  workspace: schema.Workspace
  ticket: Pick<schema.Ticket, 'id' | 'title' | 'status' | 'parentId'>
  /** Where it answers: the workspace's previewUrl ('' once a preview the board ran stopped). */
  url: string
  /** Whether the link answers; null without a link, or for one off this machine (never checked). */
  check: PreviewState | null
  /** The preview the board runs or ran from the workspace, null when it never ran one. */
  managed: ManagedPreview | null
  /** Why the board would not start one, null when it would. */
  cannotStart: string | null
  /** Building, starting or running on the board, or its link answers. */
  running: boolean
}

/** When it last changed as far as the board knows, for the order: most recent first. */
const lastAt = (p: ProjectPreview) =>
  (p.managed && (isActive(p.managed) ? p.managed.runningAt : p.managed.stoppedAt)) ??
  p.managed?.startedAt ??
  p.workspace.createdAt

/** The project's previews: the running ones first, then the rest, each the most recent first. */
export async function projectPreviews(projectId: number): Promise<ProjectPreview[]> {
  getProject(projectId)
  const tickets = db
    .select({
      id: schema.tickets.id,
      title: schema.tickets.title,
      status: schema.tickets.status,
      parentId: schema.tickets.parentId,
    })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.projectId, projectId), isNull(schema.tickets.archivedAt)))
    .all()
  if (!tickets.length) return []
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const found = db
    .select()
    .from(schema.workspaces)
    .where(
      inArray(
        schema.workspaces.ticketId,
        tickets.map((t) => t.id),
      ),
    )
    .all()
    .map((workspace) => ({ workspace, managed: managedPreview(workspace.id) }))
    .filter(({ workspace, managed }) => workspace.previewUrl || managed)
  const checks = await Promise.all(
    found.map(({ workspace: w }) =>
      w.previewUrl && isLocalUrl(w.previewUrl) ? previewState(w.previewUrl) : null,
    ),
  )
  return found
    .map(({ workspace, managed }, i): ProjectPreview => {
      const check = checks[i] ?? null
      return {
        workspace,
        ticket: byId.get(workspace.ticketId)!,
        url: workspace.previewUrl,
        check,
        managed,
        cannotStart: cannotStart(workspace.id),
        running: isActive(managed) || !!check?.running,
      }
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || lastAt(b).localeCompare(lastAt(a)))
}
