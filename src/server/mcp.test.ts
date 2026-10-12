import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { MyGhPr } from './git'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-mcp-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')

// gh answers from a fixture: one open PR on the ticket's branch.
const ghPr: MyGhPr = {
  number: 7,
  title: 'Header: “fix” the menu',
  url: 'https://github.com/acme/app/pull/7',
  author: { login: 'claude' },
  headRefName: 'feat/menu',
  baseRefName: 'main',
  headRefOid: 'a1b2c3d4e5f6',
  isDraft: false,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  updatedAt: '2026-10-01T10:00:00Z',
  mergedAt: null,
  reviews: [],
  reviewRequests: [],
  requested: true,
  assigned: true,
}
vi.mock('./git', async (original) => ({
  ...(await original<typeof import('./git')>()),
  listMyPrs: async () => [ghPr],
  currentGithubLogin: async () => 'enrique',
  prMerged: async () => false,
}))

let features: typeof import('./features')
let uploads: typeof import('./uploads')
let dbm: typeof import('#/db')
let handleMcp: typeof import('./mcp').handleMcp
beforeAll(async () => {
  features = await import('./features')
  uploads = await import('./uploads')
  dbm = await import('#/db')
  handleMcp = (await import('./mcp')).handleMcp

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git('add', 'base.txt')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'feat/menu')
  fs.writeFileSync(path.join(repo, 'menu.txt'), 'menu\n')
  git('add', 'menu.txt')
  git('commit', '-q', '-m', 'menu')
  git('checkout', '-q', 'main')
})

async function mcp(name: string, args: Record<string, unknown> = {}) {
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    'claude',
  )
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  return { error: !!result.isError, text: result.content[0]!.text }
}

/** A project with a repo, tickets, lanes, posts, replies, files, a decision, a review, a report and a PR. */
async function seed() {
  const { db, schema } = dbm
  const pid = db.insert(schema.projects).values({ name: 'compact' }).returning().get().id
  db.insert(schema.repos)
    .values({ projectId: pid, name: 'app', repoPath: repo, githubRepo: 'acme/app' })
    .run()

  const file = (name: string, text: string) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, text)
    return uploads.saveFromPath(p, 'enrique')
  }
  // Newlines, quotes, tabs, backslashes and unicode inside strings: escaped in both forms.
  const body = 'Line one\nline "two"\twith a tab and a \\ backslash\n\n- ñandú, 日本語, emoji 🚀'
  const t = features.createTicket(
    pid,
    {
      title: 'Menü jumps on “mobile”',
      body,
      assignee: 'claude',
      branch: 'feat/menu',
      tags: ['UI', 'High'],
      tasks: ['reproduce', 'fix\nit'],
      attachmentIds: [(await file('spec.md', '# spec\n')).id],
    },
    'enrique',
  )
  features.createTicket(pid, { title: 'lane', parentId: t.id, assignee: 'claude', tags: ['UI'] }, 'claude')
  features.createTicket(pid, { title: 'other', body: '' }, 'enrique')
  features.addWorkspace(t.id, { name: 'wt', branch: 'feat/menu', path: repo }, 'claude')
  const post = features.postUpdate(t.id, body, [(await file('shot.png', 'png')).id], 'claude')
  features.addComment(
    {
      parentType: 'update',
      parentId: post.id,
      body: 'and on \n tablets?',
      attachmentIds: [(await file('log.txt', 'log\n')).id],
    },
    'enrique',
  )
  features.addComment({ parentType: 'ticket', parentId: t.id, body: 'any news? 👀' }, 'enrique')
  features.askDecision(
    t.id,
    {
      body: 'Which fix?',
      options: [
        { label: 'CSS', recommended: true },
        { label: 'JS', detail: 'a\nb' },
      ],
    },
    'claude',
  )
  await features.setResumeNote(t.id, 'State: half done\nNext: the rest', 'claude')
  const reviews = await import('./reviews')
  reviews.postResult(
    pid,
    {
      prNumber: 7,
      sha: 'a1b2c3d',
      verdict: 'pass',
      summaryMd: '# ok\n',
      checks: { lint: 'pass' },
      counts: { a: 1 },
    },
    'claude',
  )
  const reports = await import('./reports')
  reports.setReportSettings(pid, { cadence: 'daily', prompt: 'what\nhappened' }, 'enrique')
  await reports.postReport(
    pid,
    { body: 'did things\n', attachmentIds: [(await file('r.pdf', 'pdf')).id] },
    'claude',
  )
  return { pid, ticketId: t.id, postId: post.id }
}

describe('MCP tool results', () => {
  let s: Awaited<ReturnType<typeof seed>>
  beforeAll(async () => {
    s = await seed()
    await (await import('./prs')).refreshPrs(s.pid)
  })

  // Each tool, with what its service hands back: the expected text is that, serialized the old way.
  const cases: [string, () => Record<string, unknown>, () => Promise<unknown>][] = [
    ['whoami', () => ({}), async () => ({ actor: 'claude' })],
    ['list_projects', () => ({}), async () => (await import('./projects')).listProjects()],
    [
      'get_project',
      () => ({ projectId: s.pid }),
      async () => (await import('./projects')).getProjectFull(s.pid),
    ],
    ['get_summary', () => ({ projectId: s.pid }), async () => (await import('./summary')).getSummary(s.pid)],
    ['get_summary', () => ({}), async () => (await import('./summary')).getSummary(undefined)],
    ['list_prs', () => ({ projectId: s.pid }), async () => (await import('./prs')).listPrs(s.pid)],
    [
      'list_review_results',
      () => ({ projectId: s.pid }),
      async () =>
        (await import('./reviews')).listResults(s.pid, 20, {}).map(({ summaryMd: _summary, ...r }) => r),
    ],
    [
      'list_tickets',
      () => ({ projectId: s.pid }),
      async () => (await import('./needs')).ticketRows(s.pid, {}),
    ],
    [
      'get_ticket',
      () => ({ ticketId: s.ticketId }),
      async () => (await import('./needs')).ticketView(s.ticketId, {}),
    ],
    [
      'get_ticket',
      () => ({ ticketId: s.ticketId, laneUpdates: true }),
      async () => (await import('./needs')).ticketView(s.ticketId, { laneUpdates: true }),
    ],
    [
      'get_ticket_git',
      () => ({ ticketId: s.ticketId }),
      async () => (await import('./needs')).ticketGitView(s.ticketId),
    ],
    [
      'cleanup_report',
      () => ({ projectId: s.pid }),
      async () => (await import('./cleanup')).cleanupReport(s.pid),
    ],
    ['list_my_threads', () => ({ projectId: s.pid }), async () => features.myThreads(s.pid, 'claude')],
    ['check_inbox', () => ({ projectId: s.pid }), async () => features.checkInbox(s.pid, 'claude')],
    [
      'list_comments',
      () => ({ parentType: 'ticket', parentId: s.ticketId }),
      async () => features.listComments('ticket', s.ticketId),
    ],
    [
      'list_comments',
      () => ({ parentType: 'update', parentId: s.postId }),
      async () => features.listComments('update', s.postId),
    ],
    ['list_actors', () => ({}), async () => (await import('./actors')).listActors()],
    [
      'daily_report',
      () => ({ projectId: s.pid }),
      async () => {
        const { dailyReport, today } = await import('./daily')
        return dailyReport(today(), s.pid)
      },
    ],
    [
      'get_report_settings',
      () => ({ projectId: s.pid }),
      async () => (await import('./reports')).getReportSettings(s.pid),
    ],
    [
      'list_reports',
      () => ({ projectId: s.pid }),
      async () => (await import('./reports')).listReports(s.pid, {}),
    ],
  ]
  it.each(cases)(
    '%s: compact JSON, the same data as the pretty form, field for field',
    async (name, args, expected) => {
      // The clock stands still, so a stamp like get_summary's generatedAt is the same in both answers.
      vi.useFakeTimers({ now: new Date(), toFake: ['Date'] })
      onTestFinished(() => void vi.useRealTimers())
      const got = await mcp(name, args())
      expect(got.error).toBe(false)
      const pretty = JSON.stringify(await uploads.ensureLocalFiles(await expected()), null, 2)
      // Compact: no indentation or line break between tokens (a newline in a string stays \n).
      expect(got.text).toBe(JSON.stringify(JSON.parse(got.text)))
      expect(got.text).not.toMatch(/\n/)
      // The same data: same fields, same values, same types; and the same text once the pretty form is
      // compacted, so the keys come in the same order too.
      expect(JSON.parse(got.text)).toStrictEqual(JSON.parse(pretty))
      expect(got.text).toBe(JSON.stringify(JSON.parse(pretty)))
    },
  )

  it('carry what was seeded: files with their paths, strings with newlines and unicode, nulls', async () => {
    const ticket = JSON.parse((await mcp('get_ticket', { ticketId: s.ticketId })).text)
    expect(ticket.body).toContain('\n')
    expect(ticket.body).toContain('🚀')
    expect(ticket.attachments[0].path).toBe(uploads.attachmentPath(ticket.attachments[0]))
    expect(JSON.stringify(ticket)).toContain(':null')
    const comments = JSON.parse(
      (await mcp('list_comments', { parentType: 'update', parentId: s.postId })).text,
    )
    expect(JSON.stringify(comments)).toContain('log.txt')
    expect((await mcp('list_prs', { projectId: s.pid })).text).toContain('"number":7')
  })

  it('still answer an error as its plain message', async () => {
    expect(await mcp('get_ticket', { ticketId: 999999 })).toEqual({
      error: true,
      text: 'ticket not found',
    })
  })
})
