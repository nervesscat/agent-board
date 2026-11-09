import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { RESUME_TEMPLATE } from '#/lib/constants'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), `${msg}\n`)
  git('add', file)
  git('commit', '-q', '-m', msg)
  return git('rev-parse', 'HEAD')
}

let features: typeof import('./features')
let resume: typeof import('./resume')
let dbm: typeof import('#/db')
let pid: number
const NOTE =
  '**State:** the form saves; validation is next.\n\n**Next steps:**\n\n1. Validate the email field'

beforeAll(async () => {
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  commit('base.txt', 'base')
  git('branch', 'feat/form')

  features = await import('./features')
  resume = await import('./resume')
  dbm = await import('#/db')
  const { db, schema } = dbm
  pid = db.insert(schema.projects).values({ name: 'resume' }).returning().get().id
  db.insert(schema.repos).values({ projectId: pid, name: 'app', repoPath: repo, baseBranch: 'main' }).run()
})

/** Noon of the local day `days` from today, so a test reads the same in any time zone. */
const day = (days: number) => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12)
}

const setTicket = (id: number, values: Partial<typeof dbm.schema.tickets.$inferInsert>) =>
  dbm.db.update(dbm.schema.tickets).set(values).where(eq(dbm.schema.tickets.id, id)).run()

const logOn = (id: number, at: Date, kind = 'task') =>
  dbm.db
    .insert(dbm.schema.activity)
    .values({
      projectId: pid,
      actor: 'claude',
      kind,
      text: 'worked',
      refType: 'ticket',
      refId: id,
      createdAt: at.toISOString(),
    })
    .run()

const read = (id: number, now?: Date) => resume.resumeState(features.getTicket(id), now)

describe('the resume note', () => {
  it('is written, read back, and posted to the feed once per version', async () => {
    const t = features.createTicket(pid, { title: 'signup form' }, 'enrique')
    expect(await read(t.id)).toMatchObject({
      note: '',
      at: null,
      by: '',
      sha: null,
      stale: false,
      noHandoff: false,
    })

    const saved = await features.setResumeNote(t.id, `  ${NOTE}\n`, 'claude')
    expect(saved.resume).toMatchObject({ note: NOTE, by: 'claude', stale: false })
    expect(saved.resume.at).not.toBeNull()
    expect(saved.postId).not.toBeNull()

    // A new version replaces it; the feed keeps both, newest first, marked as handoffs and progress.
    await features.setResumeNote(t.id, 'second', 'enrique')
    expect((await read(t.id)).note).toBe('second')
    const feed = features.getTicketFull(t.id).updates
    expect(feed.map((u) => [u.body, u.handoff, u.progress, u.author])).toEqual([
      ['second', true, true, 'enrique'],
      [NOTE, true, true, 'claude'],
    ])
    // Saving the same note again only marks it as still current.
    expect((await features.setResumeNote(t.id, 'second', 'enrique')).postId).toBeNull()
    expect(features.getTicketFull(t.id).updates).toHaveLength(2)

    // The day's log says it, under a kind of its own.
    const log = dbm.db.select().from(dbm.schema.activity).where(eq(dbm.schema.activity.refId, t.id)).all()
    expect(log.filter((a) => a.kind === 'handoff').map((a) => a.text)).toEqual([
      `left a resume note on #${t.id} signup form: State: the form saves; validation is next.`,
      `left a resume note on #${t.id} signup form: second`,
    ])

    await expect(features.setResumeNote(t.id, '  ', 'claude')).rejects.toThrow(/empty/)
    await expect(features.setResumeNote(t.id, RESUME_TEMPLATE, 'claude')).rejects.toThrow(
      /fill in the template/,
    )
  })

  it('is written as one of the project agents, via the connected agent', async () => {
    const agents = await import('./projectAgents')
    agents.createAgent(pid, { name: 'Builder' }, 'enrique')
    const t = features.createTicket(pid, { title: 'persona' }, 'enrique')
    expect((await features.setResumeNote(t.id, 'built half', 'codex', { as: 'builder' })).resume.by).toBe(
      'Builder',
    )
    expect(features.getTicketFull(t.id).updates[0]).toMatchObject({
      author: 'Builder',
      via: 'codex',
      handoff: true,
    })
    await expect(features.setResumeNote(t.id, 'x', 'codex', { as: 'nobody' })).rejects.toThrow(
      /not one of this project's agents/,
    )
  })

  it('counts the commits on the ticket branch since it was written', async () => {
    const t = features.createTicket(pid, { title: 'git', branch: 'feat/form' }, 'enrique')
    const head = git('rev-parse', 'feat/form')
    expect((await features.setResumeNote(t.id, 'at the start', 'claude')).resume).toMatchObject({
      sha: head,
      commitsSince: 0,
      stale: false,
    })
    git('checkout', '-q', 'feat/form')
    commit('a.txt', 'one')
    commit('b.txt', 'two')
    git('checkout', '-q', 'main')
    expect(await read(t.id)).toMatchObject({ sha: head, commitsSince: 2, stale: true })

    // A fresh note catches up.
    expect((await features.setResumeNote(t.id, 'two commits in', 'claude')).resume).toMatchObject({
      sha: git('rev-parse', 'feat/form'),
      commitsSince: 0,
      stale: false,
    })

    // No branch here: nothing to count.
    const other = features.createTicket(pid, { title: 'no branch', branch: 'feat/gone' }, 'enrique')
    expect((await features.setResumeNote(other.id, 'x', 'claude')).resume).toMatchObject({
      sha: null,
      commitsSince: null,
    })
  })

  it('goes stale when a progress post comes after it, not a question or the note itself', async () => {
    const t = features.createTicket(pid, { title: 'stale' }, 'enrique')
    features.postUpdate(t.id, 'earlier progress', [], 'claude')
    await features.setResumeNote(t.id, 'note', 'claude')
    expect((await read(t.id)).stale).toBe(false)
    features.postUpdate(t.id, 'a question', [], 'enrique', { progress: false })
    expect((await read(t.id)).stale).toBe(false)
    // Posts are stamped to the millisecond; make sure this one lands after the note.
    await new Promise((r) => setTimeout(r, 5))
    features.postUpdate(t.id, 'more progress', [], 'claude')
    expect((await read(t.id)).stale).toBe(true)
  })

  it('flags a ticket that carried over to another day without a resume note, and counts its days', async () => {
    const t = features.createTicket(pid, { title: 'carry over' }, 'enrique')
    // Not being worked: nothing to hand off.
    expect(await read(t.id, day(1))).toMatchObject({ noHandoff: false, day: null })

    features.claimTicket(t.id, 'claude')
    expect(features.getTicket(t.id).startedAt).not.toBeNull()
    expect(await read(t.id)).toMatchObject({ noHandoff: false, day: 1 })
    // Tomorrow, with no note: it carried over without one.
    expect(await read(t.id, day(1))).toMatchObject({ noHandoff: true, day: 2 })
    // A note written today holds tomorrow.
    await features.setResumeNote(t.id, 'left off here', 'claude')
    expect(await read(t.id, day(1))).toMatchObject({ noHandoff: false, day: 2 })

    // Started three days ago, noted two days ago, worked yesterday: that session left no note.
    setTicket(t.id, { startedAt: day(-3).toISOString(), resumeAt: day(-2).toISOString() })
    logOn(t.id, day(-1))
    expect(await read(t.id)).toMatchObject({ noHandoff: true, day: 4 })
    // Work today does not count yet; a note on the day it was last worked does.
    logOn(t.id, day(0))
    setTicket(t.id, { resumeAt: day(-1).toISOString() })
    expect(await read(t.id)).toMatchObject({ noHandoff: false })

    // Blocked and in review it still carries over; done, archived or back in To do it does not.
    setTicket(t.id, { resumeAt: day(-2).toISOString() })
    for (const [values, noHandoff] of [
      [{ status: 'blocked' }, true],
      [{ status: 'review' }, true],
      [{ status: 'todo' }, false],
      [{ status: 'done' }, false],
      [{ status: 'review', archivedAt: day(0).toISOString() }, false],
    ] as const) {
      setTicket(t.id, values)
      expect((await read(t.id)).noHandoff).toBe(noHandoff)
    }
  })

  it('does not count a handoff as work that needs another one', async () => {
    const t = features.createTicket(pid, { title: 'handoffs are not work' }, 'enrique')
    features.claimTicket(t.id, 'claude')
    setTicket(t.id, { startedAt: day(-3).toISOString(), resumeAt: day(-2).toISOString() })
    logOn(t.id, day(-1), 'handoff')
    expect(await read(t.id)).toMatchObject({ noHandoff: false, day: 4 })
    logOn(t.id, day(-1))
    expect(await read(t.id)).toMatchObject({ noHandoff: true })
  })

  it('starts the days when work starts, and again after the ticket went back to wait', () => {
    const t = features.createTicket(pid, { title: 'days', status: 'in_progress' }, 'enrique')
    const first = features.getTicket(t.id).startedAt
    expect(first).not.toBeNull()
    setTicket(t.id, { startedAt: day(-2).toISOString() })
    // Between stages of work it keeps its start.
    features.updateTicket(t.id, { status: 'blocked' }, 'claude')
    features.updateTicket(t.id, { status: 'review' }, 'claude')
    expect(features.getTicket(t.id).startedAt).toBe(day(-2).toISOString())
    // Back to To do and claimed again: a new start.
    features.updateTicket(t.id, { status: 'todo' }, 'enrique')
    expect(features.getTicket(t.id).startedAt).toBe(day(-2).toISOString())
    features.claimTicket(t.id, 'codex')
    expect(features.getTicket(t.id).startedAt! > day(-1).toISOString()).toBe(true)
  })
})

describe('reads of the resume note', () => {
  const call = async (method: string, url: string, body?: unknown, agent = true) => {
    const { api } = await import('./api')
    const res = await api.handle(
      new Request(`http://board${url}`, {
        method,
        headers: {
          ...(agent ? { authorization: 'Bearer token-of-x' } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      agent ? 'claude' : 'enrique',
    )
    return res.json()
  }

  it('come with get, claim and the list, the list without the note itself', async () => {
    const t = features.createTicket(pid, { title: 'reads' }, 'enrique')
    await call('PUT', `/api/tickets/${t.id}/resume`, { note: 'from the human' }, false)

    const full = await call('GET', `/api/tickets/${t.id}`)
    expect(full.resume).toMatchObject({
      note: 'from the human',
      by: 'enrique',
      commitsSince: null,
      stale: false,
    })
    expect(full).not.toHaveProperty('resumeNote')

    const claimed = await call('POST', `/api/tickets/${t.id}/claim`, { branch: 'feat/reads' })
    expect(claimed).toMatchObject({
      assignee: 'claude',
      resume: { note: 'from the human', noHandoff: false, day: 1 },
    })

    const rows = await call('GET', `/api/projects/${pid}/tickets?q=reads`)
    expect(rows).toHaveLength(1)
    expect(rows[0].resume).toEqual({ at: full.resume.at, stale: false, noHandoff: false, day: 1 })
    expect(rows[0]).not.toHaveProperty('resumeNote')

    // Speaking as one of the project's agents is for connected agents only.
    await expect(
      call('PUT', `/api/tickets/${t.id}/resume`, { note: 'as builder', as: 'Builder' }, false),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      (await call('PUT', `/api/tickets/${t.id}/resume`, { note: 'as builder', as: 'Builder' })).resume.by,
    ).toBe('Builder')
  })

  it('are cheap to batch: one state per ticket of a list', async () => {
    const rows = features.listTickets(pid)
    const briefs = await resume.withResumeBriefs(rows, day(1))
    expect(briefs.map((b) => b.id)).toEqual(rows.map((r) => r.id))
    expect(briefs.every((b) => !('resumeNote' in b) && 'noHandoff' in b.resume)).toBe(true)
  })
})
