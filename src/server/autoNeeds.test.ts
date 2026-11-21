import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let n = 0
const commit = (msg: string) => {
  const file = `f${++n}.txt`
  fs.writeFileSync(path.join(repo, file), `${msg}\n`)
  git('add', file)
  git('commit', '-q', '-m', msg)
}
/** A branch from `from` with one commit of its own, left checked out. */
const branch = (name: string, from: string) => {
  git('checkout', '-q', '-b', name, from)
  commit(name)
}
/** A commit on an existing branch. */
const more = (name: string, msg = `${name} more`) => {
  git('checkout', '-q', name)
  commit(msg)
}
const sha = (ref: string) => git('rev-parse', ref)

let features: typeof import('./features')
let needs: typeof import('./needs')
let push: typeof import('./push')
let dbm: typeof import('#/db')
const human = { agent: false }
const agent = { agent: true }

beforeAll(async () => {
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  commit('base')
  features = await import('./features')
  needs = await import('./needs')
  push = await import('./push')
  dbm = await import('#/db')
})

/** A project with the repo, and the tickets made in it. */
function project() {
  const { db, schema } = dbm
  const id = db
    .insert(schema.projects)
    .values({ name: `p${++n}` })
    .returning()
    .get().id
  db.insert(schema.repos).values({ projectId: id, name: 'repo', repoPath: repo, baseBranch: 'main' }).run()
  const ticket = (title: string, branch: string, extra: Record<string, unknown> = {}) =>
    features.createTicket(id, { title, branch, ...extra }, 'claude')
  /** The board looks at the branches as they are now, and every ticket. */
  const sweep = async () => {
    push.dropListings(repo)
    await needs.syncAutoNeeds(id)
  }
  return { id, ticket, sweep }
}

const rows = (ticketId: number) =>
  dbm.db.select().from(dbm.schema.ticketNeeds).where(eq(dbm.schema.ticketNeeds.ticketId, ticketId)).all()
const needIds = (ticketId: number) => needs.needIds(ticketId)
const lines = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.activity)
    .where(and(eq(dbm.schema.activity.refId, ticketId), eq(dbm.schema.activity.actor, 'board')))
    .all()
    .map((r) => r.text)
const includes = async (id: number) => (await needs.ticketGitView(id)).includes

describe('adding needs', () => {
  it('adds the need for a branch stacked on another, once, and logs it', async () => {
    const p = project()
    branch('s1/a', 'main')
    branch('s1/b', 's1/a')
    const a = p.ticket('a', 's1/a')
    const b = p.ticket('b', 's1/b')
    await p.sweep()
    expect(rows(b.id)).toMatchObject([{ needsId: a.id, auto: true, held: sha('s1/a') }])
    expect(needIds(a.id)).toEqual([])
    expect(lines(b.id)).toEqual([`#${b.id} now needs #${a.id}: its branch holds #${a.id}'s unmerged commits`])
    // Again, with something else changed so the sweep runs: nothing more is logged.
    p.ticket('other', 's1/none')
    await p.sweep()
    expect(lines(b.id)).toHaveLength(1)
    // The ticket shows it as an automatic need.
    expect((await needs.ticketView(b.id)).needs).toMatchObject([{ id: a.id, auto: true, merged: false }])
  })

  it('adds the need for a branch that merged another in', async () => {
    const p = project()
    branch('m2/a', 'main')
    branch('m2/c', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge a', 'm2/a')
    const a = p.ticket('a', 'm2/a')
    const c = p.ticket('c', 'm2/c')
    await p.sweep()
    expect(rows(c.id)).toMatchObject([{ needsId: a.id, auto: true, held: sha('m2/a') }])
    expect(needIds(a.id)).toEqual([])
  })

  it('follows a rebase: kept and brought up to date onto the newer tip, dropped when rebased away, kept when the other moved', async () => {
    const p = project()
    // (a) b rebased onto a's newer tip.
    branch('r3/a', 'main')
    branch('r3/b', 'r3/a')
    const a = p.ticket('a', 'r3/a')
    const b = p.ticket('b', 'r3/b')
    await p.sweep()
    const first = sha('r3/a')
    expect(rows(b.id)).toMatchObject([{ needsId: a.id, held: first }])
    more('r3/a')
    git('checkout', '-q', 'r3/b')
    git('rebase', '-q', 'r3/a')
    await p.sweep()
    expect(rows(b.id)).toMatchObject([{ needsId: a.id, auto: true, held: sha('r3/a') }])
    expect(sha('r3/a')).not.toBe(first)
    expect(lines(b.id)).toHaveLength(1)

    // (b) b rebased onto main, away from a: the need goes, and it says so.
    git('rebase', '-q', '--onto', 'main', 'r3/a')
    await p.sweep()
    expect(needIds(b.id)).toEqual([])
    expect(lines(b.id)).toEqual([
      `#${b.id} now needs #${a.id}: its branch holds #${a.id}'s unmerged commits`,
      `#${b.id} no longer needs #${a.id}: its branch no longer holds #${a.id}'s commits`,
    ])
    // Nothing of a is in b: not hinted at either.
    expect(await includes(b.id)).toEqual([])

    // (c) a is rebased (new commits) while b still holds the old ones: the need stays.
    branch('r3/c', 'main')
    branch('r3/d', 'r3/c')
    const c = p.ticket('c', 'r3/c')
    const d = p.ticket('d', 'r3/d')
    await p.sweep()
    expect(rows(d.id)).toMatchObject([{ needsId: c.id, held: sha('r3/c') }])
    const old = sha('r3/c')
    git('checkout', '-q', 'main')
    commit('main moves')
    git('checkout', '-q', '-B', 'r3/c', 'main')
    git('cherry-pick', old)
    expect(sha('r3/c')).not.toBe(old)
    await p.sweep()
    expect(rows(d.id)).toMatchObject([{ needsId: c.id, auto: true, held: old }])
    expect(needIds(c.id)).toEqual([])
    expect(await includes(d.id)).toEqual([])
    expect(lines(d.id)).toHaveLength(1)
  })
})

describe('what is not added', () => {
  it('adds nothing for two branches off the same base, nor on a shared integration branch', async () => {
    const p = project()
    branch('same/a', 'main')
    branch('same/d', 'main')
    const a = p.ticket('a', 'same/a')
    const d = p.ticket('d', 'same/d')
    // Both built on an integration branch that is only a branch.
    branch('same/int', 'main')
    branch('same/x', 'same/int')
    branch('same/y', 'same/int')
    const x = p.ticket('x', 'same/x')
    const y = p.ticket('y', 'same/y')
    await p.sweep()
    for (const t of [a, d, x, y]) {
      expect(needIds(t.id)).toEqual([])
      expect(await includes(t.id)).toEqual([])
    }
  })

  it('adds nothing for a branch that took the base in, whatever the base holds', async () => {
    const p = project()
    // Another ticket's work landed in main, its branch kept.
    branch('dev5/landed', 'main')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge landed', 'dev5/landed')
    const landed = p.ticket('landed', 'dev5/landed')
    // b was cut before that and took main in; e was cut after it.
    git('checkout', '-q', '-b', 'dev5/b', 'main~1')
    commit('b')
    git('merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    branch('dev5/e', 'main')
    const b = p.ticket('b', 'dev5/b')
    const e = p.ticket('e', 'dev5/e')
    await p.sweep()
    for (const t of [b, e, landed]) {
      expect(needIds(t.id)).toEqual([])
      expect(await includes(t.id)).toEqual([])
    }
  })

  it('adds nothing for equal tips, and only hints at a stack whose lower branch moved on', async () => {
    const p = project()
    branch('eq/a', 'main')
    git('branch', 'eq/b', 'eq/a')
    const ea = p.ticket('ea', 'eq/a')
    const eb = p.ticket('eb', 'eq/b')
    branch('lo/a', 'main')
    branch('lo/b', 'lo/a')
    more('lo/a')
    const la = p.ticket('la', 'lo/a')
    const lb = p.ticket('lb', 'lo/b')
    await p.sweep()
    for (const t of [ea, eb, la, lb]) expect(needIds(t.id)).toEqual([])
    expect(await includes(ea.id)).toEqual([])
    expect(await includes(eb.id)).toEqual([])
    // Both hold a commit of the other's, neither is the owner: only the hint names it.
    expect(await includes(lb.id)).toEqual([la.id])
  })

  it('never makes a cycle, and does not throw', async () => {
    const p = project()
    branch('cy/a', 'main')
    branch('cy/b', 'cy/a')
    const a = p.ticket('a', 'cy/a')
    const b = p.ticket('b', 'cy/b')
    // a needs b by hand; b holds a's work, which would make b need a.
    await needs.changeTicket(a.id, { needs: [b.id] }, 'claude', agent)
    await p.sweep()
    expect(needIds(b.id)).toEqual([])
    expect(needIds(a.id)).toEqual([b.id])
    expect(lines(b.id)).toEqual([])
  })
})

describe('removing and keeping needs', () => {
  it('does not add again what the human removed, until new work is taken in', async () => {
    const p = project()
    branch('d7/a', 'main')
    branch('d7/b', 'd7/a')
    const a = p.ticket('a', 'd7/a')
    const b = p.ticket('b', 'd7/b')
    await p.sweep()
    expect(needIds(b.id)).toEqual([a.id])
    await needs.changeTicket(b.id, { needs: [] }, 'me', human)
    expect(needIds(b.id)).toEqual([])
    const dismissals = () =>
      dbm.db
        .select()
        .from(dbm.schema.ticketNeedDismissals)
        .where(eq(dbm.schema.ticketNeedDismissals.ticketId, b.id))
        .all()
    expect(dismissals()).toMatchObject([{ needsId: a.id, held: sha('d7/a') }])
    // The sweep runs again (something changed), and the need stays removed.
    p.ticket('other', 'd7/none')
    await p.sweep()
    expect(needIds(b.id)).toEqual([])
    // a gets a new commit, b takes it in: new work, so the need comes back.
    more('d7/a')
    git('checkout', '-q', 'd7/b')
    git('merge', '-q', '--no-ff', '-m', 'merge a', 'd7/a')
    await p.sweep()
    expect(rows(b.id)).toMatchObject([{ needsId: a.id, auto: true, held: sha('d7/a') }])
    expect(dismissals()).toEqual([])
    expect(lines(b.id)).toHaveLength(2)
  })

  it('leaves a need added by hand alone, held or not, and keeps the board’s own through an agent’s list', async () => {
    const p = project()
    branch('h7/a', 'main')
    branch('h7/b', 'h7/a')
    branch('h7/x', 'main')
    branch('h7/c', 'main')
    const a = p.ticket('a', 'h7/a')
    const b = p.ticket('b', 'h7/b')
    const x = p.ticket('x', 'h7/x')
    const c = p.ticket('c', 'h7/c')
    // By hand: c needs a without holding it; b needs a already, which it holds.
    await needs.changeTicket(c.id, { needs: [a.id] }, 'me', human)
    await needs.changeTicket(b.id, { needs: [a.id] }, 'me', human)
    await p.sweep()
    expect(rows(c.id)).toMatchObject([{ needsId: a.id, auto: false, held: '' }])
    expect(rows(b.id)).toMatchObject([{ needsId: a.id, auto: false, held: '' }])
    expect(lines(b.id)).toEqual([])
    // New work in a: still not touched, nor dropped when a is cancelled without landing.
    await needs.changeTicket(a.id, { status: 'cancelled' }, 'me', human)
    await p.sweep()
    expect(needIds(c.id)).toEqual([a.id])
    expect(needIds(b.id)).toEqual([a.id])

    // The board's own: x is stacked on the open branch h7/x2.
    branch('h7/x2', 'main')
    branch('h7/y', 'h7/x2')
    const x2 = p.ticket('x2', 'h7/x2')
    const y = p.ticket('y', 'h7/y')
    await p.sweep()
    expect(rows(y.id)).toMatchObject([{ needsId: x2.id, auto: true }])
    const held = rows(y.id)[0]!.held
    // An agent's list with another need, and then with none: the board's need stays, and is not dismissed.
    await needs.changeTicket(y.id, { needs: [x.id] }, 'claude', agent)
    expect(needIds(y.id)).toEqual([x.id, x2.id].sort((l, r) => l - r))
    await needs.changeTicket(y.id, { needs: [] }, 'claude', agent)
    expect(needIds(y.id)).toEqual([x2.id])
    expect(rows(y.id)).toMatchObject([{ needsId: x2.id, auto: true, held }])
    expect(dbm.db.select().from(dbm.schema.ticketNeedDismissals).all()).toEqual([])
    // The human adding a need keeps the board's row as it is.
    await needs.changeTicket(y.id, { needs: [x2.id, x.id] }, 'me', human)
    expect(rows(y.id).find((r) => r.needsId === x2.id)).toMatchObject({ auto: true, held })
    expect(rows(y.id).find((r) => r.needsId === x.id)).toMatchObject({ auto: false })
    // The agent's move to done counts what the board added: refused while it is not merged.
    await expect(
      needs.changeTicket(y.id, { status: 'done', needs: [] }, 'claude', agent),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('drops an automatic need when the other ticket was cancelled or archived without landing, and keeps it once landed', async () => {
    const p = project()
    branch('c8/a', 'main')
    branch('c8/b', 'c8/a')
    branch('c8/x', 'main')
    branch('c8/y', 'c8/x')
    branch('c8/p', 'main')
    branch('c8/q', 'c8/p')
    branch('c8/l', 'main')
    branch('c8/m', 'c8/l')
    const a = p.ticket('a', 'c8/a')
    const b = p.ticket('b', 'c8/b')
    const x = p.ticket('x', 'c8/x')
    const y = p.ticket('y', 'c8/y')
    const pp = p.ticket('p', 'c8/p')
    const q = p.ticket('q', 'c8/q')
    const l = p.ticket('l', 'c8/l')
    const m = p.ticket('m', 'c8/m')
    await p.sweep()
    expect(needIds(b.id)).toEqual([a.id])
    expect(needIds(y.id)).toEqual([x.id])
    expect(needIds(q.id)).toEqual([pp.id])
    expect(needIds(m.id)).toEqual([l.id])

    await needs.changeTicket(a.id, { status: 'cancelled' }, 'me', human)
    // x is done without having landed, then archived (only a finished ticket is).
    await needs.changeTicket(x.id, { status: 'done' }, 'me', human)
    features.archiveTicket(x.id, 'me')
    // p lands in main (its branch kept) and is then cancelled: it landed, so the need stays.
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge p', 'c8/p')
    await needs.changeTicket(pp.id, { status: 'cancelled' }, 'me', human)
    // l lands and is done: the need stays, met.
    git('merge', '-q', '--no-ff', '-m', 'merge l', 'c8/l')
    await needs.changeTicket(l.id, { status: 'done' }, 'me', human)
    await p.sweep()
    expect(needIds(b.id)).toEqual([])
    expect(lines(b.id)).toEqual([
      `#${b.id} now needs #${a.id}: its branch holds #${a.id}'s unmerged commits`,
      `#${b.id} no longer needs #${a.id}: #${a.id} was cancelled without landing`,
    ])
    expect(needIds(y.id)).toEqual([])
    expect(lines(y.id).at(-1)).toBe(
      `#${y.id} no longer needs #${x.id}: #${x.id} was archived without landing`,
    )
    expect(needIds(q.id)).toEqual([pp.id])
    expect(needIds(m.id)).toEqual([l.id])
    expect((await needs.ticketView(m.id)).needs).toMatchObject([{ id: l.id, merged: true, auto: true }])
  })
})

describe('every open ticket is looked at', () => {
  it('finds the work of a ticket beyond the 40 most recently updated, for the sweep and for the hint', async () => {
    const p = project()
    // The oldest ticket's branch: stacked on by one (certain), and moved on from by another (hint).
    branch('many/old', 'main')
    branch('many/up', 'many/old')
    branch('many/low', 'main')
    branch('many/high', 'many/low')
    more('many/low')
    git('checkout', '-q', 'main')
    const old = p.ticket('old', 'many/old')
    const low = p.ticket('low', 'many/low')
    const { db, schema } = dbm
    for (const id of [old.id, low.id])
      db.update(schema.tickets)
        .set({ updatedAt: '2020-01-01T00:00:00.000Z' })
        .where(eq(schema.tickets.id, id))
        .run()
    for (let i = 0; i < 45; i++) {
      git('branch', `many/f${i}`, 'main')
      p.ticket(`filler ${i}`, `many/f${i}`)
    }
    const up = p.ticket('up', 'many/up')
    const high = p.ticket('high', 'many/high')
    await p.sweep()
    expect(needIds(up.id)).toEqual([old.id])
    expect(await includes(high.id)).toEqual([low.id])
  })
})
