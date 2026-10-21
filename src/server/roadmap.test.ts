import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-roadmap-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let roadmapModule: typeof import('./roadmap')
let projectId: number
beforeAll(async () => {
  features = await import('./features')
  roadmapModule = await import('./roadmap')
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
})

const ticket = (title: string, status: string, more: { parentId?: number } = {}) =>
  features.createTicket(
    projectId,
    { title, status, tasks: [{ text: 'Implementation', subtasks: ['A', 'B'] }, 'Pushed'], ...more },
    'claude',
  )

describe('roadmap', () => {
  it('lists the tickets being worked, blocked or in review, with their tasks and lanes', () => {
    const worked = ticket('worked', 'in_progress')
    const lane = ticket('lane', 'in_progress', { parentId: worked.id })
    const sub = ticket('sub-lane', 'blocked', { parentId: lane.id })
    ticket('dropped lane', 'cancelled', { parentId: worked.id })
    const waiting = ticket('waiting', 'blocked')
    const reviewed = ticket('reviewed', 'review')
    ticket('todo', 'todo')
    ticket('done', 'done')

    const view = roadmapModule.roadmap(projectId)
    expect(view.map((t) => t.id).sort()).toEqual([worked.id, waiting.id, reviewed.id].sort())
    const row = view.find((t) => t.id === worked.id)!
    expect(row.tasks.map((t) => t.text)).toEqual(['Implementation', 'A', 'B', 'Pushed'])
    expect(row.tasks[1]!.parentId).toBe(row.tasks[0]!.id)
    expect(row.lanes.map((l) => [l.id, l.depth])).toEqual([
      [lane.id, 0],
      [sub.id, 1],
    ])
  })

  it('answers on the API', async () => {
    const { api } = await import('./api')
    const res = await api.handle(new Request(`http://localhost/api/projects/${projectId}/roadmap`), 'enrique')
    expect(res?.status).toBe(200)
    expect(Array.isArray(await res!.json())).toBe(true)
  })
})
