import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp

let prs: typeof import('./prs')
beforeAll(async () => {
  prs = await import('./prs')
})

describe('localPath', () => {
  it('maps Windows drive paths into WSL, leaves everything else alone', async () => {
    const { localPath } = await import('./uploads')
    expect(localPath('C:\\Users\\me\\shot.png', 'linux')).toBe('/mnt/c/Users/me/shot.png')
    expect(localPath('D:/work/a b/rec.mp4', 'linux')).toBe('/mnt/d/work/a b/rec.mp4')
    expect(localPath('/home/me/shot.png', 'linux')).toBe('/home/me/shot.png')
    expect(localPath('C:\\Users\\me\\shot.png', 'win32')).toBe('C:\\Users\\me\\shot.png')
  })
})

describe('actors', () => {
  it('remembers how each name signed in; the last sign-in wins; built-ins fill the gaps', async () => {
    const { listActors, noteActor } = await import('./actors')
    noteActor('claude-acme', 'agent')
    noteActor('laptop', 'human')
    noteActor('laptop', 'human')
    const kinds = new Map(listActors().map((a) => [a.name, a.kind]))
    expect(kinds.get('claude-acme')).toBe('agent')
    expect(kinds.get('laptop')).toBe('human')
    expect(kinds.get('claude')).toBe('agent')
    noteActor('laptop', 'agent')
    expect(new Map(listActors().map((a) => [a.name, a.kind])).get('laptop')).toBe('agent')
  })
})

describe('prStatus', () => {
  it('merged is done, held or not; then hold wins over the review stage', () => {
    const st = (mergedAt: string | null, hold: boolean, reviewStage: 'pending' | 'reviewed' | 'on_hold') =>
      prs.prStatus({ mergedAt, hold, reviewStage })
    expect(st('2026-10-01T10:00:00Z', true, 'pending')).toBe('done')
    expect(st('2026-10-01T10:00:00Z', false, 'reviewed')).toBe('done')
    expect(st(null, true, 'reviewed')).toBe('on_hold')
    expect(st(null, false, 'reviewed')).toBe('reviewed')
    expect(st(null, false, 'on_hold')).toBe('on_hold')
    expect(st(null, false, 'pending')).toBe('pending')
  })
})

describe('review findings', () => {
  let dbm: typeof import('#/db')
  let reviews: typeof import('./reviews')
  let needs: typeof import('./needs')
  let prsMod: typeof import('./prs')
  let http: typeof import('./http')
  let guarded: (ctx: { request: Request }) => Promise<Response>
  beforeAll(async () => {
    dbm = await import('#/db')
    reviews = await import('./reviews')
    needs = await import('./needs')
    prsMod = await import('./prs')
    http = await import('./http')
    const { api } = await import('./api')
    // As the server answers: an HttpError becomes its status with `{error}`; the caller is the human.
    guarded = http.api(({ request }: { request: Request }) => api.handle(request, 'enrique'))
  })

  let seq = 0
  /** A project with one repo; the PR and rows are seeded per test. */
  function project() {
    seq += 1
    const p = dbm.db
      .insert(dbm.schema.projects)
      .values({ name: `reviews-${seq}` })
      .returning()
      .get()
    const r = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: p.id, name: 'api', repoPath: `/r/reviews-${seq}` })
      .returning()
      .get()
    return { projectId: p.id, repoId: r.id }
  }

  const finding = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `finding ${id}`,
    severity: 'medium',
    verdict: 'confirmed',
    origin: 'original-build',
    finder: 'hunt-a',
    ...over,
  })

  const expectHttp = (fn: () => unknown, status: number) => {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(http.HttpError)
      expect((err as InstanceType<typeof http.HttpError>).status).toBe(status)
      return
    }
    throw new Error(`expected a ${status}`)
  }

  async function call(method: string, pathname: string, body?: unknown) {
    const res = await guarded({
      request: new Request(`http://localhost${pathname}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('stores each finding with its eight fields and reads it back from getResult', () => {
    const { projectId, repoId } = project()
    const row = reviews.postResult(
      projectId,
      {
        prNumber: 1,
        sha: 'abc1234',
        verdict: 'SHIP AFTER FIXES',
        summaryMd: 'two findings',
        repoId,
        round: 1,
        findings: [
          finding('F1', { severity: 'major' }),
          finding('F2', { verdict: 'plausible', origin: 'pre-existing', finder: 'verify', title: 'second' }),
        ],
      },
      'claude',
    )
    const got = reviews.getResult(row.id)
    expect(got.round).toBe(1)
    expect(got.findings).toEqual([
      {
        id: 'F1',
        title: 'finding F1',
        severity: 'major',
        verdict: 'confirmed',
        origin: 'original-build',
        finder: 'hunt-a',
        round: 1,
        fixedIn: null,
      },
      {
        id: 'F2',
        title: 'second',
        severity: 'medium',
        verdict: 'plausible',
        origin: 'pre-existing',
        finder: 'verify',
        round: 1,
        fixedIn: null,
      },
    ])
  })

  it('a result posted without findings or round stores round null and no findings', () => {
    const { projectId, repoId } = project()
    const row = reviews.postResult(
      projectId,
      { prNumber: 2, sha: 'abc1234', verdict: 'SHIP', summaryMd: '', repoId },
      'claude',
    )
    expect(reviews.getResult(row.id)).toMatchObject({ round: null, findings: [] })
  })

  it('refuses a bad severity, verdict, origin or finder with a 400 and stores nothing', () => {
    const { projectId, repoId } = project()
    const post = (findings: unknown[]) =>
      reviews.postResult(
        projectId,
        { prNumber: 3, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId, round: 1, findings },
        'claude',
      )
    expectHttp(() => post([finding('F1', { severity: 'critical' })]), 400)
    expectHttp(() => post([finding('F1', { verdict: 'refuted' })]), 400)
    expectHttp(() => post([finding('F1', { origin: 'someday' })]), 400)
    expectHttp(() => post([finding('F1', { finder: 'hunt-c' })]), 400)
    expect(reviews.listResults(projectId, 100, { prNumber: 3 })).toHaveLength(0)
  })

  it('a result with findings needs a round, a finding round must be its result round, and ids are unique', () => {
    const { projectId, repoId } = project()
    const post = (round: number | undefined, findings: unknown[]) =>
      reviews.postResult(
        projectId,
        { prNumber: 4, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId, round, findings },
        'claude',
      )
    expectHttp(() => post(undefined, [finding('F1')]), 400)
    expectHttp(() => post(1, [finding('F1', { round: 2 })]), 400)
    expectHttp(() => post(1, [finding('F1'), finding('F1')]), 400)
    expectHttp(() => post(0, []), 400)
    expect(post(1, [finding('F1', { round: 1 })]).round).toBe(1)
  })

  it('setFindingFixed changes only the named finding and refuses a bad SHA or an unknown finding', () => {
    const { projectId, repoId } = project()
    const row = reviews.postResult(
      projectId,
      {
        prNumber: 5,
        sha: 'abc1234',
        verdict: 'FIX',
        summaryMd: '',
        repoId,
        round: 1,
        findings: [finding('F1'), finding('F2')],
      },
      'claude',
    )
    const updated = reviews.setFindingFixed(projectId, row.id, 'F1', 'abc1234')
    expect(updated.findings.map((f) => [f.id, f.fixedIn])).toEqual([
      ['F1', 'abc1234'],
      ['F2', null],
    ])
    expect(reviews.getResult(row.id).findings.map((f) => [f.id, f.fixedIn])).toEqual([
      ['F1', 'abc1234'],
      ['F2', null],
    ])
    expectHttp(() => reviews.setFindingFixed(projectId, row.id, 'F2', 'not-a-sha'), 400)
    expectHttp(() => reviews.setFindingFixed(projectId, row.id, 'F9', 'abc1234'), 404)
    expect(reviews.setFindingFixed(projectId, row.id, 'F1', null).findings[0]!.fixedIn).toBeNull()
  })

  it('setFindingFixed reaches a result only through its own project: another project gets 404 and the row is unchanged', () => {
    const a = project()
    const b = project()
    const row = reviews.postResult(
      a.projectId,
      {
        prNumber: 8,
        sha: 'abc1234',
        verdict: 'FIX',
        summaryMd: '',
        repoId: a.repoId,
        round: 1,
        findings: [finding('F1')],
      },
      'claude',
    )
    expectHttp(() => reviews.setFindingFixed(b.projectId, row.id, 'F1', 'abc1234'), 404)
    expect(reviews.getResult(row.id).findings.map((f) => [f.id, f.fixedIn])).toEqual([['F1', null]])
    expect(reviews.setFindingFixed(a.projectId, row.id, 'F1', 'abc1234').findings[0]!.fixedIn).toBe('abc1234')
  })

  it('the REST routes post a result with findings and set fixedIn on one finding', async () => {
    const { projectId, repoId } = project()
    const posted = await call('POST', `/api/projects/${projectId}/reviews/results`, {
      prNumber: 6,
      sha: 'abc1234',
      verdict: 'FIX',
      summaryMd: '',
      repoId,
      round: 1,
      findings: [finding('F1'), finding('F2')],
    })
    expect(posted.status).toBe(201)
    const bad = await call('POST', `/api/projects/${projectId}/reviews/results`, {
      prNumber: 6,
      sha: 'abc1234',
      verdict: 'FIX',
      summaryMd: '',
      repoId,
      round: 1,
      findings: [finding('F1', { severity: 'critical' })],
    })
    expect(bad.status).toBe(400)

    const id = posted.body.id as number
    const set = await call('PATCH', `/api/projects/${projectId}/reviews/results/${id}/findings/F1`, {
      fixedIn: 'abc1234',
    })
    expect(set.status).toBe(200)
    const read = await call('GET', `/api/reviews/results/${id}`)
    expect(read.body.findings.map((f: { id: string; fixedIn: string | null }) => [f.id, f.fixedIn])).toEqual([
      ['F1', 'abc1234'],
      ['F2', null],
    ])
    expect(
      (
        await call('PATCH', `/api/projects/${projectId}/reviews/results/${id}/findings/F9`, {
          fixedIn: 'abc1234',
        })
      ).status,
    ).toBe(404)
  })

  it('a PR keeps one row per round: rounds 1 and 2 of the same head are both listed, neither overwritten', () => {
    const { projectId, repoId } = project()
    const base = { prNumber: 7, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId }
    reviews.postResult(projectId, { ...base, round: 1, findings: [finding('F1')] }, 'claude')
    reviews.postResult(
      projectId,
      { ...base, round: 2, findings: [finding('F1', { verdict: 'plausible' })] },
      'claude',
    )
    const rows = reviews.listResults(projectId, 100, { prNumber: 7 })
    expect(rows.map((r) => r.round).sort()).toEqual([1, 2])
    expect(rows.find((r) => r.round === 1)!.findings[0]!.verdict).toBe('confirmed')
    expect(rows.find((r) => r.round === 2)!.findings[0]!.verdict).toBe('plausible')
  })

  it('roundsOf groups results by round, ascending, keeps findings and drops summaries; rows without a round are in no round', () => {
    const row = (id: number, round: number | null) =>
      ({
        id,
        round,
        summaryMd: 'long',
        findings: [],
        prNumber: 8,
      }) as unknown as import('#/db').schema.ReviewResult
    const grouped = reviews.roundsOf([row(1, 2), row(2, null), row(3, 1), row(4, 2)])
    expect(grouped.map((g) => g.round)).toEqual([1, 2])
    expect(grouped[0]!.results.map((r) => r.id)).toEqual([3])
    expect(grouped[1]!.results.map((r) => r.id)).toEqual([1, 4])
    expect(grouped[1]!.results[0]).not.toHaveProperty('summaryMd')
  })

  it('listRounds reads one PR of the repo by round, ascending', () => {
    const { projectId, repoId } = project()
    const base = { prNumber: 9, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId }
    reviews.postResult(projectId, { ...base, round: 2, findings: [finding('F1', { round: 2 })] }, 'claude')
    reviews.postResult(projectId, { ...base, round: 1, findings: [finding('F1')] }, 'claude')
    reviews.postResult(projectId, { ...base, prNumber: 10, round: 1, findings: [finding('F1')] }, 'claude')
    const rounds = reviews.listRounds(projectId, 9, repoId)
    expect(rounds.map((g) => g.round)).toEqual([1, 2])
    expect(rounds.every((g) => g.results.every((r) => r.prNumber === 9))).toBe(true)
    expect(rounds[1]!.results[0]!.findings[0]).toMatchObject({ id: 'F1', round: 2, fixedIn: null })
  })

  it('ticketView carries the review rounds of the ticket PR, and an empty list without a PR', async () => {
    const { projectId, repoId } = project()
    const base = { prNumber: 11, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId }
    reviews.postResult(projectId, { ...base, round: 1, findings: [finding('F1')] }, 'claude')
    reviews.postResult(
      projectId,
      { ...base, round: 2, findings: [finding('F1', { verdict: 'plausible' })] },
      'claude',
    )
    const withPr = dbm.db
      .insert(dbm.schema.tickets)
      .values({ projectId, title: 'with a PR', status: 'todo', createdBy: 'enrique', repoId, prNumber: 11 })
      .returning()
      .get()
    const view = await needs.ticketView(withPr.id)
    expect(view.reviewRounds.map((g) => g.round)).toEqual([1, 2])
    expect(view.reviewRounds[1]!.results[0]!.findings[0]).toMatchObject({ id: 'F1', verdict: 'plausible' })

    const noPr = dbm.db
      .insert(dbm.schema.tickets)
      .values({ projectId, title: 'no PR', status: 'todo', createdBy: 'enrique', repoId })
      .returning()
      .get()
    expect((await needs.ticketView(noPr.id)).reviewRounds).toEqual([])
  })

  it('listPrs rows carry the review rounds of their PR', async () => {
    const { projectId, repoId } = project()
    const now = new Date().toISOString()
    dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId,
        repoId,
        number: 12,
        title: 'a PR',
        url: 'https://example.test/pull/12',
        author: 'enrique',
        headRef: 'feat',
        baseRef: 'main',
        headSha: 'abc1234',
        open: true,
        updatedAt: now,
        fetchedAt: now,
      })
      .run()
    const base = { prNumber: 12, sha: 'abc1234', verdict: 'FIX', summaryMd: '', repoId }
    reviews.postResult(projectId, { ...base, round: 1, findings: [finding('F1')] }, 'claude')
    reviews.postResult(
      projectId,
      { ...base, round: 2, findings: [finding('F1', { verdict: 'plausible' })] },
      'claude',
    )
    const row = (await prsMod.listPrs(projectId)).find((p) => p.number === 12)!
    expect(row.reviewRounds.map((g) => g.round)).toEqual([1, 2])
    expect(row.reviewRounds[0]!.results[0]!.findings[0]).toMatchObject({ id: 'F1', severity: 'medium' })
  })
})

describe('the feature-review templates emit findings in the record shape', () => {
  const dir = fileURLToPath(new URL('./skill/review/skills/feature-review/', import.meta.url))
  const FIELDS = ['id', 'title', 'severity', 'verdict', 'origin', 'finder', 'round', 'fixedIn']
  /** The text from one heading up to the next, so a field named elsewhere in the file does not count. */
  const section = (file: string, from: string, to: string) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    const start = text.indexOf(from)
    expect(start).toBeGreaterThanOrEqual(0)
    return text.slice(start, text.indexOf(to, start + from.length))
  }

  it('the report template names all eight fields in its confirmed and plausible findings', () => {
    const findings = section(
      'report-template.md',
      '## Confirmed findings',
      '## Verification of acceptance criteria',
    )
    for (const field of FIELDS) expect(findings).toMatch(new RegExp(`\\b${field}\\b`))
    // Its severity line names the three levels only.
    expect(findings.match(/severity `([^`]*)`/g)).toEqual(Array(2).fill('severity `major|medium|minor`'))
  })

  it('the summary template names all eight fields in its findings bullet', () => {
    const findings = section('summary-template.md', '## Findings', '## Evidence')
    for (const field of FIELDS) expect(findings).toMatch(new RegExp(`\\b${field}\\b`))
  })
})
