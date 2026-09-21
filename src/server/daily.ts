import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { addSummary, listActivity, listSummaries } from './activity'
import { config } from './config'
import { HttpError } from './http'
import { listProjects } from './projects'

const run = promisify(execFile)

// Summaries being generated right now, keyed by day + project, so the UI can show it after a navigation.
const generating = new Set<string>()
const genKey = (date: string, projectId: number | null) => `${date}:${projectId ?? 'all'}`

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dailyReport(date: string, projectId?: number) {
  const projects = listProjects()
  const rows = listActivity(date, projectId)
  return {
    date,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    activity: rows.map((a) => ({ ...a, project: projects.find((p) => p.id === a.projectId)?.name ?? null })),
    summaries: listSummaries(date, projectId),
    generating: generating.has(genKey(date, projectId ?? null)),
  }
}

/** Ask Claude for the highest-level version of the day and post it as a summary by "claude". */
export async function generateSummary(date: string, projectId: number | null) {
  const key = genKey(date, projectId)
  if (generating.has(key)) throw new HttpError(409, 'a summary is already being generated')
  const report = dailyReport(date, projectId ?? undefined)
  if (!report.activity.length) throw new HttpError(400, 'nothing happened that day')
  const lines = report.activity.map(
    (a) => `${a.createdAt.slice(11, 16)} ${a.actor} [${a.project ?? '-'}] ${a.text}`,
  )
  const prompt = [
    `Below is everything that happened on ${date} on a work board shared by a developer and their AI agents.`,
    'Write the daily work summary at the highest level, for someone who has ten seconds:',
    'at most three short bullets, plain words, what got done and what is still open. No preamble, no headings.',
    '',
    ...lines,
  ].join('\n')
  generating.add(key)
  try {
    const { stdout } = await run(config.claudeBin, ['-p', prompt, '--output-format', 'text'], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
    return addSummary({ projectId, date, author: 'claude', body: stdout.trim() })
  } finally {
    generating.delete(key)
  }
}
