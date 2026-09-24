import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let features: typeof import('./features')
let projectId: number
let otherRepo: number
beforeAll(async () => {
  features = await import('./features')
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'api', repoPath: '/r/api', baseBranch: 'main' }).run()
  otherRepo = db
    .insert(schema.repos)
    .values({ projectId, name: 'web', repoPath: '/r/web', baseBranch: 'develop' })
    .returning()
    .get().id
})

describe('lanes', () => {
  it('branch off the parent, roll progress up and count by status', () => {
    expect(features.listTickets(projectId)).toEqual([])
    const parent = features.createTicket(
      projectId,
      { title: 'checkout', branch: 'feat/checkout', repoId: otherRepo - 1, tasks: ['plan'] },
      'me',
    )
    const api = features.createTicket(
      projectId,
      { title: 'api', parentId: parent.id, tasks: ['a', 'b'], status: 'in_progress' },
      'claude',
    )
    const web = features.createTicket(
      projectId,
      { title: 'web', parentId: parent.id, repoId: otherRepo },
      'codex',
    )
    const hooks = features.createTicket(
      projectId,
      { title: 'webhooks', parentId: api.id, tasks: ['c'] },
      'claude',
    )

    // Same repo: off the parent's branch. Other repo: that repo's base. Nested: off the lane's base.
    expect(api.baseBranch).toBe('feat/checkout')
    expect(api.repoId).toBe(parent.repoId)
    expect(web.baseBranch).toBe('develop')
    expect(hooks.baseBranch).toBe('feat/checkout')

    const [task] = features.getTicketFull(hooks.id).tasks
    features.updateTask(task!.id, { done: true }, 'claude')

    const top = features.listTickets(projectId, { parentId: null })
    expect(top.map((t) => t.id)).toEqual([parent.id])
    expect(top[0]!.progress).toEqual({ done: 0, total: 1 })
    expect(top[0]!.rollup).toEqual({ done: 1, total: 4 })
    expect(top[0]!.lanes).toEqual({ total: 2, in_progress: 1, todo: 1 })

    features.postUpdate(hooks.id, 'signature check in', [], 'claude')
    const full = features.getTicketFull(hooks.id)
    expect(full.ancestors.map((a) => a.id)).toEqual([parent.id, api.id])

    const p = features.getTicketFull(parent.id)
    expect(p.lanes.map((l) => l.id).sort()).toEqual([api.id, web.id].sort())
    expect(p.updates).toEqual([])
    expect(features.getTicketFull(parent.id, { laneUpdates: true }).updates[0]!.lane).toEqual({
      id: hooks.id,
      title: 'webhooks',
    })
    // A sub-lane's update is the newest news of the lane above it.
    expect(p.lanes.find((l) => l.id === api.id)!.lastUpdate).toMatchObject({ text: 'signature check in' })
  })

  it('refuse a parent from another project', async () => {
    const { db, schema } = await import('#/db')
    const other = db.insert(schema.projects).values({ name: 'q' }).returning().get().id
    db.insert(schema.repos).values({ projectId: other, name: 'x', repoPath: '/r/x' }).run()
    const t = features.createTicket(other, { title: 'elsewhere' }, 'me')
    expect(() =>
      features.createTicket(projectId, { title: 'x', parentId: t.id, repoId: otherRepo }, 'me'),
    ).toThrow(/not in project/)
  })

  it('go with the ticket, or move up a level with keepLanes', () => {
    const a = features.createTicket(projectId, { title: 'a', repoId: otherRepo }, 'me')
    const b = features.createTicket(projectId, { title: 'b', parentId: a.id }, 'me')
    const c = features.createTicket(projectId, { title: 'c', parentId: b.id }, 'me')
    features.deleteTicket(b.id, 'me', { keepLanes: true })
    expect(features.getTicket(c.id).parentId).toBe(a.id)
    features.deleteTicket(a.id, 'me')
    expect(() => features.getTicket(c.id)).toThrow()
  })
})
