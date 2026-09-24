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

describe('gist', () => {
  it('skips markdown markers and bare labels', () => {
    expect(features.gist('**Evidence:**\n- webhook retries now back off\n- more')).toBe(
      'webhook retries now back off',
    )
    expect(features.gist('## Done\n\nShipped the `api` lane.')).toBe('Done')
    expect(features.gist('Notes:')).toBe('Notes:')
  })
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
    expect(top[0]!.lanes).toEqual({ total: 2, approved: 0, disapproved: 0, in_progress: 1, todo: 1 })

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

  it("show their workspaces in the parent's git panel, tagged with the lane", async () => {
    const parent = features.createTicket(projectId, { title: 'panel', repoId: otherRepo }, 'me')
    const lane = features.createTicket(projectId, { title: 'lane', parentId: parent.id }, 'me')
    const sub = features.createTicket(projectId, { title: 'sub', parentId: lane.id }, 'me')
    features.addWorkspace(parent.id, { name: 'main-wt' }, 'me')
    features.addWorkspace(sub.id, { name: 'sub-wt', branch: 'feat/sub' }, 'codex')
    const git = await features.ticketGit(parent.id)
    expect(git.workspaces.map((w) => [w.name, w.lane?.id ?? null])).toEqual([
      ['main-wt', null],
      ['sub-wt', sub.id],
    ])
    expect((await features.ticketGit(sub.id)).workspaces.map((w) => w.lane)).toEqual([null])
  })

  it("carry the human's verdict; disapproving cancels, taking it back reopens", () => {
    const parent = features.createTicket(projectId, { title: 'verdicts', repoId: otherRepo }, 'me')
    const a = features.createTicket(projectId, { title: 'a', parentId: parent.id, tasks: ['x'] }, 'claude')
    const b = features.createTicket(projectId, { title: 'b', parentId: parent.id, tasks: ['y'] }, 'claude')
    const row = () => features.listTickets(projectId).find((t) => t.id === parent.id)!

    const approved = features.setVerdict(a.id, 'approved', 'enrique')
    expect(approved).toMatchObject({ approvedBy: 'enrique', disapprovedAt: null })
    expect(features.getTicketFull(parent.id).lanes.find((l) => l.id === a.id)!.approvedBy).toBe('enrique')

    const rejected = features.setVerdict(b.id, 'disapproved', 'enrique')
    expect(rejected).toMatchObject({ status: 'cancelled', disapprovedBy: 'enrique', approvedAt: null })
    expect(row().lanes).toMatchObject({ approved: 1, disapproved: 1, cancelled: 1 })
    // The cancelled lane's task is no longer part of the work.
    expect(row().rollup).toEqual({ done: 0, total: 1 })

    // Switching straight to approved clears the disapproval and reopens it.
    expect(features.setVerdict(b.id, 'approved', 'enrique')).toMatchObject({
      status: 'todo',
      disapprovedAt: null,
      approvedBy: 'enrique',
    })
    // An undo puts back the stage and the call the lane had before.
    features.updateTicket(b.id, { status: 'review' }, 'claude')
    features.setVerdict(b.id, 'disapproved', 'enrique')
    expect(features.setVerdict(b.id, 'approved', 'enrique', { reopenTo: 'review' })).toMatchObject({
      status: 'review',
      approvedBy: 'enrique',
    })
    features.setVerdict(a.id, null, 'enrique')
    expect(features.getTicket(a.id)).toMatchObject({ approvedAt: null, approvedBy: '', status: 'todo' })
    expect(row().lanes).toMatchObject({ approved: 1, disapproved: 0 })
  })

  it('carry tags: cleaned up, filterable in any casing', () => {
    expect(features.cleanTags(['  High ', 'high', '', 'Forms  UI', 'x'.repeat(50)])).toEqual([
      'High',
      'Forms UI',
      'x'.repeat(40),
    ])
    const parent = features.createTicket(projectId, { title: 'audit', repoId: otherRepo }, 'me')
    const a = features.createTicket(projectId, { title: 'a', parentId: parent.id, tags: ['High'] }, 'claude')
    const b = features.createTicket(projectId, { title: 'b', parentId: parent.id, tags: ['Low'] }, 'claude')
    features.updateTicket(b.id, { tags: ['Cosmetic', 'cosmetic', 'Forms'] }, 'claude')
    expect(features.getTicket(b.id).tags).toEqual(['Cosmetic', 'Forms'])
    const tagged = (tag: string) =>
      features.listTickets(projectId, { parentId: parent.id, tag }).map((t) => t.id)
    expect(tagged('high')).toEqual([a.id])
    expect(tagged('FORMS')).toEqual([b.id])
    expect(tagged('Low')).toEqual([])
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
