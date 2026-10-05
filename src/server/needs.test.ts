import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), text)
  git('add', file)
  git('commit', '-q', '-m', msg)
}

/**
 * main ← feat/a (open work)
 *      ← feat/b: built on feat/a (stacked)
 *      ← feat/c: its own commit, then feat/a merged in (to get past a conflict)
 *      ← feat/d: on its own
 *      ← feat/landed: merged into main
 *      ← feat/gone: merged into main, then deleted
 */
beforeAll(() => {
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  commit('base.txt', 'base\n', 'base')
  git('checkout', '-q', '-b', 'feat/a')
  commit('a.txt', 'a\n', 'a')
  git('checkout', '-q', '-b', 'feat/b')
  commit('b.txt', 'b\n', 'b')
  git('checkout', '-q', '-b', 'feat/c', 'main')
  commit('c.txt', 'c\n', 'c')
  git('merge', '-q', '--no-ff', '-m', 'merge feat/a', 'feat/a')
  git('checkout', '-q', '-b', 'feat/d', 'main')
  commit('d.txt', 'd\n', 'd')
  git('checkout', '-q', '-b', 'feat/landed', 'main')
  commit('landed.txt', 'landed\n', 'landed')
  git('checkout', '-q', '-b', 'feat/gone', 'main')
  commit('gone.txt', 'gone\n', 'gone')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'merge feat/landed', 'feat/landed')
  git('merge', '-q', '--no-ff', '-m', 'merge feat/gone', 'feat/gone')
  git('branch', '-q', '-D', 'feat/gone')
})

let features: typeof import('./features')
let needs: typeof import('./needs')
let projectId: number
const human = { agent: false }
const agent = { agent: true }

beforeAll(async () => {
  features = await import('./features')
  needs = await import('./needs')
  const { db, schema } = await import('#/db')
  projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
  db.insert(schema.repos).values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' }).run()
})

const ticket = (title: string, branch: string, extra: Record<string, unknown> = {}) =>
  features.createTicket(projectId, { title, branch, ...extra }, 'claude')

describe('declaring needs', () => {
  it('stores them, checked: not itself, same project, no cycles', async () => {
    const a = ticket('a', 'feat/a')
    const b = ticket('b', 'feat/b')
    const c = ticket('c', 'feat/c')
    await needs.changeTicket(b.id, { needs: [a.id, a.id] }, 'claude', agent)
    expect(needs.needIds(b.id)).toEqual([a.id])

    await expect(needs.changeTicket(b.id, { needs: [b.id] }, 'claude', agent)).rejects.toThrow(/itself/)
    await expect(needs.changeTicket(b.id, { needs: [999_999] }, 'claude', agent)).rejects.toThrow(/no ticket/)
    const { db, schema } = await import('#/db')
    const other = db.insert(schema.projects).values({ name: 'q' }).returning().get().id
    db.insert(schema.repos).values({ projectId: other, name: 'x', repoPath: '/r/x' }).run()
    const elsewhere = features.createTicket(other, { title: 'elsewhere' }, 'me')
    await expect(needs.changeTicket(b.id, { needs: [elsewhere.id] }, 'claude', agent)).rejects.toThrow(
      /another project/,
    )
    // a ← b: a needing b closes the loop; so does it through c.
    await expect(needs.changeTicket(a.id, { needs: [b.id] }, 'claude', agent)).rejects.toThrow(
      `#${b.id} already needs #${a.id}: that would be a cycle`,
    )
    await needs.changeTicket(c.id, { needs: [b.id] }, 'claude', agent)
    await expect(needs.changeTicket(a.id, { needs: [c.id] }, 'claude', agent)).rejects.toThrow(
      /through others: that would be a cycle/,
    )
    // A refused list changes nothing.
    expect(needs.needIds(b.id)).toEqual([a.id])

    const created = await needs.newTicket(projectId, { title: 'e', needs: [a.id, c.id] }, 'claude', agent)
    expect(needs.needIds(created.id)).toEqual([a.id, c.id])
    await needs.changeTicket(created.id, { needs: [] }, 'claude', agent)
    expect(needs.needIds(created.id)).toEqual([])

    // Deleting a ticket takes its needs and what needs it with it.
    features.deleteTicket(c.id, 'me')
    expect(needs.needIds(b.id)).toEqual([a.id])
  })

  it('shows them on the ticket with whether each is merged, and who needs it', async () => {
    const a = ticket('a2', 'feat/a', { prNumber: 7 })
    const landed = ticket('landed', 'feat/landed')
    const b = ticket('b2', 'feat/b')
    await needs.changeTicket(b.id, { needs: [a.id, landed.id] }, 'claude', agent)
    const view = await needs.ticketView(b.id)
    expect(view.needs).toEqual([
      { id: a.id, title: 'a2', branch: 'feat/a', prNumber: 7, status: 'todo', merged: false, into: 'main' },
      {
        id: landed.id,
        title: 'landed',
        branch: 'feat/landed',
        prNumber: null,
        status: 'todo',
        merged: true,
        into: 'main',
      },
    ])
    expect((await needs.ticketView(a.id)).neededBy).toEqual([
      { id: b.id, title: 'b2', branch: 'feat/b', prNumber: null, status: 'todo' },
    ])
    const rows = await needs.ticketRows(projectId)
    expect(rows.find((t) => t.id === b.id)!.needs.map((n) => [n.id, n.merged])).toEqual([
      [a.id, false],
      [landed.id, true],
    ])
    expect(rows.find((t) => t.id === a.id)!.needs).toEqual([])
  })
})

describe('merged', () => {
  it('reads the need from git: in the base, done and landed, done and deleted, stacked', async () => {
    const met = async (need: number, on: { baseBranch?: string } = {}) => {
      const t = ticket('t', 'feat/x', on)
      await needs.changeTicket(t.id, { needs: [need] }, 'claude', agent)
      return (await needs.ticketView(t.id)).needs[0]!.merged
    }
    // In the base, whatever its stage.
    expect(await met(ticket('landed', 'feat/landed').id)).toBe(true)
    // Open work, not in the base.
    expect(await met(ticket('a', 'feat/a').id)).toBe(false)
    // Done, but its branch still holds work its base lacks.
    expect(await met(ticket('d', 'feat/d', { status: 'done' }).id)).toBe(false)
    // Done and its branch deleted: branches go once they land.
    expect(await met(ticket('gone', 'feat/gone', { status: 'done' }).id)).toBe(true)
    // Not done and no branch to look at.
    expect(await met(ticket('gone', 'feat/gone').id)).toBe(false)
    expect(await met(ticket('plain', '').id)).toBe(false)
    expect(await met(ticket('plain', '', { status: 'done' }).id)).toBe(true)
    // Built on the needed branch: it counts once that branch is in its own base.
    expect(await met(ticket('a', 'feat/a').id, { baseBranch: 'feat/a' })).toBe(false)
    expect(await met(ticket('landed', 'feat/landed').id, { baseBranch: 'feat/landed' })).toBe(true)
  })
})

describe('done', () => {
  it('is refused while a need is not merged, on every path that changes the status', async () => {
    const { db, schema } = await import('#/db')
    const a = ticket('a', 'feat/a')
    const b = ticket('b', 'feat/b', { tags: ['PR'] })
    await needs.changeTicket(b.id, { needs: [a.id] }, 'claude', agent)
    const reason = `#${b.id} needs #${a.id} (branch feat/a) merged into main first`

    // update_ticket and the board (drag, status select): agent or human.
    await expect(needs.changeTicket(b.id, { status: 'done' }, 'claude', agent)).rejects.toThrow(reason)
    await expect(needs.changeTicket(b.id, { status: 'Done' }, 'me', human)).rejects.toMatchObject({
      status: 409,
      code: 'needs',
    })
    // Any other stage is fine.
    expect((await needs.changeTicket(b.id, { status: 'review' }, 'claude', agent)).status).toBe('review')
    // An agent can never force it.
    await expect(
      needs.changeTicket(b.id, { status: 'done', force: true }, 'claude', agent),
    ).rejects.toMatchObject({ status: 403 })
    // Setting the needs and the status at once is checked against the new needs.
    await expect(
      needs.changeTicket(b.id, { status: 'done', needs: [] }, 'claude', agent),
    ).resolves.toMatchObject({
      status: 'done',
    })
    await needs.changeTicket(b.id, { status: 'review', needs: [a.id] }, 'claude', agent)

    // Approving a PR review moves it to done.
    await expect(needs.judgeTicket(b.id, 'approved', 'me')).rejects.toThrow(reason)
    expect(features.getTicket(b.id).approvedAt).toBeNull()

    // Created straight into done.
    await expect(
      needs.newTicket(
        projectId,
        { title: 'n', branch: 'feat/b', status: 'done', needs: [a.id] },
        'me',
        human,
      ),
    ).rejects.toThrow(/needs #\d+ \(branch feat\/a\) merged into main first/)

    // Deleting a stage whose tickets move to done.
    const { createStage } = await import('./stages')
    const parked = createStage(projectId, { name: 'Parked', kind: 'open' }, 'me')
    await needs.changeTicket(b.id, { status: parked.key }, 'me', human)
    await expect(needs.removeStage(projectId, parked.id, { moveTo: 'done' }, 'me')).rejects.toThrow(reason)
    expect(features.getTicket(b.id).status).toBe(parked.key)
    await needs.removeStage(projectId, parked.id, { moveTo: 'done', force: true }, 'me')
    expect(features.getTicket(b.id).status).toBe('done')

    // The human's override, from the board and from approving, is logged.
    await needs.changeTicket(b.id, { status: 'review' }, 'me', human)
    expect((await needs.changeTicket(b.id, { status: 'done', force: true }, 'me', human)).status).toBe('done')
    await needs.changeTicket(b.id, { status: 'review' }, 'me', human)
    expect((await needs.judgeTicket(b.id, 'approved', 'me', { force: true })).status).toBe('done')
    const log = db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.refId, b.id))
      .all()
      .filter((r) => r.text.includes('done anyway'))
    expect(log.map((r) => r.text)).toEqual([
      `marked #${b.id} b done anyway, without #${a.id} (branch feat/a) merged into main`,
      `marked #${b.id} b done anyway, without #${a.id} (branch feat/a) merged into main`,
      `marked #${b.id} b done anyway, without #${a.id} (branch feat/a) merged into main`,
    ])

    // Once the need is merged, done goes through.
    const c = ticket('c', 'feat/c')
    const landed = ticket('landed', 'feat/landed')
    await needs.changeTicket(c.id, { needs: [landed.id] }, 'claude', agent)
    expect((await needs.changeTicket(c.id, { status: 'done' }, 'claude', agent)).status).toBe('done')
  })
})

describe('includes', () => {
  it('lists the open tickets whose unmerged work the branch holds', async () => {
    const { db, schema } = await import('#/db')
    const p = db.insert(schema.projects).values({ name: 'inc' }).returning().get().id
    db.insert(schema.repos).values({ projectId: p, name: 'repo', repoPath: repo, baseBranch: 'main' }).run()
    const make = (title: string, branch: string, extra: Record<string, unknown> = {}) =>
      features.createTicket(p, { title, branch, ...extra }, 'claude')
    const a = make('a', 'feat/a')
    const b = make('b', 'feat/b')
    const c = make('c', 'feat/c')
    const d = make('d', 'feat/d')
    make('landed', 'feat/landed')
    const includes = async (id: number) => (await needs.ticketGitView(id)).includes
    // Stacked on feat/a, and feat/a merged in.
    expect(await includes(b.id)).toEqual([a.id])
    expect(await includes(c.id)).toEqual([a.id])
    // feat/a is in both, not the other way round; feat/d took nothing in.
    expect(await includes(a.id)).toEqual([])
    expect(await includes(d.id)).toEqual([])
    // Built on feat/a by its base: still a's unmerged work.
    const stacked = make('stacked', 'feat/b', { baseBranch: 'feat/a' })
    expect(await includes(stacked.id)).toContain(a.id)
    // A finished ticket's work is not asked for.
    await needs.changeTicket(a.id, { status: 'cancelled' }, 'me', human)
    expect(await includes(b.id)).toEqual([])
    // A lane's parent is family, not a need.
    const parent = make('parent', 'feat/a')
    const lane = features.createTicket(p, { title: 'lane', branch: 'feat/b', parentId: parent.id }, 'claude')
    expect(await includes(lane.id)).not.toContain(parent.id)
  })
})
