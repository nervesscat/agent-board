import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let repos: typeof import('./repos')
let features: typeof import('./features')
let prTickets: typeof import('./prTickets')
let projects: typeof import('./projects')
beforeAll(async () => {
  repos = await import('./repos')
  features = await import('./features')
  prTickets = await import('./prTickets')
  projects = await import('./projects')
})

describe('deleteRepo', () => {
  it("takes the repo's PR tickets with its PR rows, and keeps its feature tickets with no repo", async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'repo removal' }).returning().get().id
    const [one, two] = ['one', 'two'].map((name) =>
      db
        .insert(schema.repos)
        .values({
          projectId,
          name,
          repoPath: `/r/removal-${name}`,
          baseBranch: 'main',
          githubRepo: `acme/${name}`,
        })
        .returning()
        .get(),
    )
    const now = new Date().toISOString()
    // The same PR number in both repos: each PR has a ticket of its own.
    const [prOne, prTwo] = [one, two].map((repo) =>
      db
        .insert(schema.prs)
        .values({
          projectId,
          repoId: repo.id,
          number: 5,
          title: `five in ${repo.name}`,
          url: `https://github.com/acme/${repo.name}/pull/5`,
          author: 'ana',
          headRef: `feat/${repo.name}`,
          baseRef: 'main',
          headSha: 'abc1234',
          updatedAt: now,
          fetchedAt: now,
        })
        .returning()
        .get(),
    )
    prTickets.openPrTickets(projectId, () => 'pending')
    const ownOne = db.select().from(schema.tickets).where(eq(schema.tickets.prId, prOne.id)).get()!
    const ownTwo = db.select().from(schema.tickets).where(eq(schema.tickets.prId, prTwo.id)).get()!
    features.addWorkspace(ownOne.id, { name: 'review' }, 'claude')
    const feature = features.createTicket(projectId, { title: 'feature in one', repoId: one.id }, 'claude')

    repos.deleteRepo(one.id, 'enrique')

    // The removed repo's PR row, its ticket and that ticket's workspace are gone; the other repo's PR and ticket stay.
    expect(db.select().from(schema.prs).where(eq(schema.prs.id, prOne.id)).get()).toBeUndefined()
    expect(db.select().from(schema.tickets).where(eq(schema.tickets.id, ownOne.id)).get()).toBeUndefined()
    expect(
      db.select().from(schema.workspaces).where(eq(schema.workspaces.ticketId, ownOne.id)).all(),
    ).toEqual([])
    expect(db.select().from(schema.prs).where(eq(schema.prs.id, prTwo.id)).get()).toMatchObject({ number: 5 })
    expect(db.select().from(schema.tickets).where(eq(schema.tickets.id, ownTwo.id)).get()).toMatchObject({
      prId: prTwo.id,
    })
    // No PR ticket reads as a feature ticket: not in the list, not in the project's count.
    expect(features.listTickets(projectId).map((t) => t.id)).toEqual([feature.id])
    expect(projects.listProjects().find((p) => p.id === projectId)!.counts).toEqual({
      tickets: 1,
      openPrs: 1,
    })
    // The feature ticket of the removed repo stays, with no repo, as a repo's removal has always left it.
    expect(features.getTicket(feature.id)).toMatchObject({ repoId: null })
  })
})

describe('POST /api/repos', () => {
  it('takes a body written by hand with \\\\ separators and stores the path exactly', async () => {
    const { db, schema } = await import('#/db')
    const projectId = db.insert(schema.projects).values({ name: 'backslash paths' }).returning().get().id
    // Backslash separators on every OS: Windows' own, else a folder name holding them (legal there).
    const repoPath =
      process.platform === 'win32'
        ? path.join(tmp, 'backslash', 'Python', 'x')
        : path.join(tmp, ['backslash', 'Python', 'x'].join(String.fromCharCode(0x5c)))
    fs.mkdirSync(repoPath, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repoPath })
    // Escaped by hand, as a client writing JSON text does: each backslash doubled, nothing else changed.
    const escaped = repoPath.replaceAll('\\', '\\\\')
    const body = `{"projectId":${projectId},"repoPath":"${escaped}"}`
    expect(body).toContain(String.raw`\\`)

    const created = await call('POST', '/api/repos', body)
    expect(created.status, await created.clone().text()).toBe(201)
    expect(((await created.json()) as { repoPath: string }).repoPath).toBe(repoPath)
    const listed = (await (await call('GET', '/api/repos')).json()) as {
      projectId: number
      repoPath: string
    }[]
    expect(listed.filter((r) => r.projectId === projectId).map((r) => r.repoPath)).toEqual([repoPath])
  })

  it("refuses a body with a bad escape, saying the parser's reason", async () => {
    // A body after a shell collapsed \\ to \: \c is no JSON escape.
    const res = await call('POST', '/api/repos', String.raw`{"projectId":1,"repoPath":"C:\code"}`)
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: string }
    expect(error).toMatch(/^body must be JSON: .*escaped character/i)
  })
})

/** A call through the routes as the API serves them, with `body` sent as these exact bytes. */
async function call(method: string, pathname: string, body?: string) {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body,
  })
  return handle({ request, actor: 'enrique' })
}
