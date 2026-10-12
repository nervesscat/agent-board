import { listActivity } from './activity'
import { listProjects } from './projects'

/** The local calendar day of `d` (now by default), as the Daily module names days. */
export const today = (d = new Date()) => {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A day's activity, every write in order, each with its project's name; one project's with `projectId`. */
export function dailyReport(date: string, projectId?: number) {
  const projects = listProjects()
  const rows = listActivity(date, projectId)
  return {
    date,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    activity: rows.map((a) => ({ ...a, project: projects.find((p) => p.id === a.projectId)?.name ?? null })),
  }
}
