import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq, isNotNull } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-repo-request-'))
process.env.DATA_DIR = tmp

const HUMAN = 'enrique'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let repos: typeof import('./repos')
let summary: typeof import('./summary')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  repos = await import('./repos')
  summary = await import('./summary')
  // The human signed in: who a relayed Add goes to.
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

let checkouts = 0
/** A real git checkout in the temp dir, with `origin` at `url` when given (git only stores it: no network). */
function checkout(url?: string) {
  const dir = path.join(tmp, `checkout-${++checkouts}`)
  fs.mkdirSync(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (url) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir })
  return dir
}

function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  const repo = dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: path.join(tmp, `app-of-${name}`), baseBranch: 'main' })
    .returning()
    .get()
  return { id, repo }
}

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'agent') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}, as: 'human' | 'agent' = 'agent') {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
    as === 'agent' ? AGENT : HUMAN,
  )
  return ((await res.json()) as { result: any }).result
}
/** A tool call's answer: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>, as: 'human' | 'agent' = 'agent') {
  const result = (await rpc('tools/call', { name, arguments: args }, as)) as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

/** What a refused call says: its status and message. */
async function refusal(run: () => unknown) {
  try {
    await run()
  } catch (err) {
    const e = err as { status?: number; message: string }
    return { status: e.status, message: e.message }
  }
  throw new Error('the call went through')
}

const decisionsOn = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.updates)
    .where(and(eq(dbm.schema.updates.ticketId, ticketId), isNotNull(dbm.schema.updates.decision)))
    .all()
const activity = (projectId: number) =>
  dbm.db.select().from(dbm.schema.activity).where(eq(dbm.schema.activity.projectId, projectId)).all()
const replies = (postId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.comments)
    .where(and(eq(dbm.schema.comments.parentType, 'update'), eq(dbm.schema.comments.parentId, postId)))
    .all()
const names = (projectId: number) => repos.listRepos(projectId).map((r) => r.name)

/** The human's answer on the board, as the route gives it: the origin read, then decide. */
const answer = (postId: number, option: number) =>
  call('PUT', `/api/updates/${postId}/decision`, { option }, 'human')

describe('asking for a repo', () => {
  it('posts one Add / Don’t add card naming the repo over MCP, adding no repo and moving nothing', async () => {
    const { id: pid } = newProject('mcp-ask')
    const t = features.createTicket(pid, { title: 'build shop', status: 'in_progress' }, HUMAN)
    const dir = checkout('https://github.com/acme/shop.git')

    const card = await tool('add_repo', {
      ticketId: t.id,
      name: 'shop',
      repoPath: dir,
      githubRepo: 'acme/shop',
    })
    expect(card).toMatchObject({
      ticketId: t.id,
      author: AGENT,
      tab: 'main',
      decidedAt: null,
      archiveTickets: null,
      repoRequest: {
        projectId: pid,
        name: 'shop',
        repoPath: dir,
        githubRepo: 'acme/shop',
        baseBranch: 'main',
      },
      decision: [{ label: 'Add' }, { label: "Don't add" }],
    })
    expect(card.body.split('\n')[0]).toBe('Add repo shop?')
    for (const words of ['Name: shop', 'GitHub: acme/shop', dir, 'Base branch: main'])
      expect(card.body).toContain(words)
    // Asking adds nothing, and the card does not block.
    expect(names(pid)).toEqual(['app'])
    expect(features.getTicket(t.id).status).toBe('in_progress')
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({ actor: AGENT, text: `asked to add repo shop (acme/shop) at ${dir}` }),
    )
  })

  it('has a REST route for agents that does the same, base branch included', async () => {
    const { id: pid } = newProject('rest-ask')
    const t = features.createTicket(pid, { title: 'build', status: 'todo' }, HUMAN)
    const dir = checkout('git@github.com:acme/api.git')
    const asked = await call('POST', `/api/tickets/${t.id}/repo-request`, {
      name: 'api',
      repoPath: dir,
      githubRepo: 'acme/api',
      baseBranch: 'dev',
    })
    expect(asked.status).toBe(201)
    expect(asked.body).toMatchObject({
      ticketId: t.id,
      repoRequest: { projectId: pid, name: 'api', githubRepo: 'acme/api', baseBranch: 'dev' },
      decision: [{ label: 'Add' }, { label: "Don't add" }],
    })
    expect(asked.body.body).toContain('Base branch: dev')
    expect(names(pid)).toEqual(['app'])
    expect(features.getTicket(t.id).status).toBe('todo')
  })

  it('shows in Needs you as an open decision', async () => {
    const { id: pid } = newProject('needs-you')
    const t = features.createTicket(pid, { title: 'build', status: 'in_progress' }, HUMAN)
    const card = await features.requestRepo(
      t.id,
      { name: 'web', repoPath: checkout('https://github.com/acme/web'), githubRepo: 'acme/web' },
      AGENT,
    )
    const needsYou = summary.getSummary(pid, { humans: [HUMAN] }).projects[0]!.needsYou
    expect(needsYou.decisions).toEqual([
      expect.objectContaining({ postId: card.id, ticketId: t.id, question: 'Add repo web?', options: 2 }),
    ])
  })
})

describe('the checks of a request', () => {
  let pid: number
  let ticketId: number
  beforeAll(() => {
    pid = newProject('checks').id
    ticketId = features.createTicket(pid, { title: 'checks', status: 'in_progress' }, HUMAN).id
  })
  const ask = (input: { name?: string; repoPath: string; githubRepo: string }) =>
    refusal(() => features.requestRepo(ticketId, { name: 'new', ...input }, AGENT))

  it('reads github.com’s owner/name from every shape of origin URL, and nothing else', () => {
    for (const url of [
      'https://github.com/acme/shop',
      'https://github.com/acme/shop.git',
      'https://github.com/acme/shop/',
      'https://someone@github.com/acme/shop.git',
      'git@github.com:acme/shop.git',
      'git@github.com:acme/shop',
      'ssh://git@github.com/acme/shop.git',
      'ssh://git@github.com:22/acme/shop',
      'HTTPS://GitHub.com/acme/shop.git',
    ])
      expect(repos.githubSlug(url), url).toBe('acme/shop')
    for (const url of [
      'https://gitlab.com/acme/shop.git',
      'https://github.com.evil.example/acme/shop',
      'https://github.com/acme',
      'https://github.com/acme/shop/tree/main',
      '/srv/git/shop.git',
      '',
    ])
      expect(repos.githubSlug(url), url).toBeNull()
  })

  it('refuses a path that does not exist, is relative, or is not a git checkout', async () => {
    const missing = path.join(tmp, 'nowhere')
    expect(await ask({ repoPath: missing, githubRepo: 'acme/shop' })).toEqual({
      status: 400,
      message: `${missing} does not exist`,
    })
    expect(await ask({ repoPath: 'some/where', githubRepo: 'acme/shop' })).toMatchObject({
      status: 400,
      message: expect.stringContaining('absolute path'),
    })
    const plain = path.join(tmp, 'plain-folder')
    fs.mkdirSync(plain)
    expect(await ask({ repoPath: plain, githubRepo: 'acme/shop' })).toEqual({
      status: 400,
      message: `${plain} is not a git checkout`,
    })
    expect(decisionsOn(ticketId)).toEqual([])
  })

  it('refuses a checkout without origin, one whose origin is not github.com, or another repo', async () => {
    const none = checkout()
    expect(await ask({ repoPath: none, githubRepo: 'acme/shop' })).toEqual({
      status: 400,
      message: `${none} has no origin remote`,
    })
    const gitlab = checkout('https://gitlab.com/acme/shop.git')
    expect(await ask({ repoPath: gitlab, githubRepo: 'acme/shop' })).toEqual({
      status: 400,
      message: `${gitlab}'s origin, https://gitlab.com/acme/shop.git, is not a github.com repository`,
    })
    // Credentials in the URL never reach the message.
    const secret = checkout('https://user:hunter2@gitlab.com/acme/shop.git')
    expect((await ask({ repoPath: secret, githubRepo: 'acme/shop' })).message).not.toContain('hunter2')
    const other = checkout('https://github.com/acme/other.git')
    expect(await ask({ repoPath: other, githubRepo: 'acme/shop' })).toEqual({
      status: 400,
      message: `${other}'s origin is acme/other, not acme/shop`,
    })
    expect(await ask({ repoPath: other, githubRepo: 'https://github.com/acme/other' })).toMatchObject({
      status: 400,
      message: expect.stringContaining('owner/name'),
    })
    expect(decisionsOn(ticketId)).toEqual([])
  })

  it('compares owner and name in any casing', async () => {
    const dir = checkout('https://github.com/Acme/Shop.git')
    const card = await features.requestRepo(
      ticketId,
      { name: 'cased', repoPath: dir, githubRepo: 'acme/shop' },
      AGENT,
    )
    expect(card.repoRequest).toMatchObject({ githubRepo: 'acme/shop' })
  })

  it('refuses a name the project has in any casing, and a path a repo of the board has in any spelling', async () => {
    const dir = checkout('https://github.com/acme/dup.git')
    expect(await ask({ name: ' APP ', repoPath: dir, githubRepo: 'acme/dup' })).toMatchObject({
      status: 409,
      message: expect.stringContaining('already has a repo named app'),
    })
    // A repo of another project at this checkout, registered with the other slash and a trailing one.
    const elsewhere = newProject('checks-elsewhere').id
    dbm.db
      .insert(dbm.schema.repos)
      .values({
        projectId: elsewhere,
        name: 'dup',
        repoPath: `${(process.platform === 'win32' ? dir.toUpperCase() : dir).replace(/[\\/]/g, '/')}/`,
      })
      .run()
    const dupe = await ask({ name: 'dup', repoPath: dir, githubRepo: 'acme/dup' })
    expect(dupe).toMatchObject({
      status: 409,
      message: expect.stringContaining('already registered as repo'),
    })
    expect(dupe.message).toContain('of project checks-elsewhere')
    expect(decisionsOn(ticketId).map((d) => d.repoRequest?.name)).toEqual(['cased'])
  })
})

describe('answering a request', () => {
  let pid: number
  let repoId: number
  beforeAll(() => {
    ;({
      id: pid,
      repo: { id: repoId },
    } = newProject('answers'))
  })
  const ask = async (name: string, slug = `acme/${name}`, extra: { baseBranch?: string } = {}) => {
    const t = features.createTicket(pid, { title: `for ${name}`, status: 'in_progress', repoId }, HUMAN)
    const dir = checkout(`https://github.com/${slug}.git`)
    const card = await features.requestRepo(t.id, { name, repoPath: dir, githubRepo: slug, ...extra }, AGENT)
    return { t, dir, card }
  }

  it('Add on the board adds the repo as asked, by the human, saying the agent asked', async () => {
    // The slug as given, in its casing: never looked up again with gh.
    const { t, dir, card } = await ask('shop', 'Acme/Shop')
    const answered = await answer(card.id, 0)
    expect(answered.status).toBe(200)
    const added = repos.listRepos(pid).find((r) => r.name === 'shop')
    expect(added).toMatchObject({
      projectId: pid,
      repoPath: dir,
      githubRepo: 'Acme/Shop',
      baseBranch: 'main',
    })
    expect(answered.body.repo).toMatchObject({ added: { id: added!.id }, already: null, refused: '' })
    expect(features.getPost(card.id)).toMatchObject({ decidedOption: 0, decidedBy: HUMAN })
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: HUMAN,
        text: `added repo shop (Acme/Shop), as ${AGENT} asked`,
        refType: 'ticket',
        refId: t.id,
      }),
    )
    expect(replies(card.id).map((r) => r.body)).toEqual([
      `Decided: **Add**\n\nAdded repo shop (repo ${added!.id}).`,
    ])
  })

  it('a relayed Add adds it in the human’s name, saying who relayed it', async () => {
    const { card } = await ask('relayed', 'acme/relayed', { baseBranch: 'develop' })
    const relayed = await tool('answer_decision', { postId: card.id, option: 0, words: 'yes, add it' })
    expect(relayed).toMatchObject({ decidedBy: '', relayedBy: AGENT, repo: { added: { name: 'relayed' } } })
    expect(repos.listRepos(pid).find((r) => r.name === 'relayed')).toMatchObject({ baseBranch: 'develop' })
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: HUMAN,
        text: `added repo relayed (acme/relayed), as ${AGENT} asked (answered in chat, relayed by ${AGENT})`,
      }),
    )
    expect(replies(card.id).at(-1)!.body).toMatch(
      /^Decided in chat: \*\*Add\*\*\n\nyes, add it\n\nAdded repo relayed/,
    )
  })

  it('Don’t add adds nothing; Add again is "already added", not a second repo', async () => {
    const { card } = await ask('twice')
    expect((await answer(card.id, 1)).body.repo).toBeNull()
    expect(names(pid)).not.toContain('twice')

    // Changed to Add, it adds.
    expect((await answer(card.id, 0)).body.repo.added).toMatchObject({ name: 'twice' })
    const again = await answer(card.id, 0)
    expect(again.status).toBe(200)
    expect(again.body.repo).toMatchObject({ added: null, already: { name: 'twice' } })
    expect(names(pid).filter((n) => n === 'twice')).toHaveLength(1)
    expect(replies(card.id).at(-1)!.body).toMatch(
      /^Changed the decision to: \*\*Add\*\*\n\nAlready added: repo twice/,
    )
  })

  it('checks again on Add: what changed since the request adds nothing, and the reply says why', async () => {
    const gone = await ask('gone')
    fs.rmSync(gone.dir, { recursive: true, force: true })
    const moved = await ask('moved')
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/elsewhere.git'], {
      cwd: moved.dir,
    })
    // Two requests for one name: only the first Add adds it.
    const first = await ask('same')
    const second = await ask('same')

    expect((await answer(gone.card.id, 0)).body.repo).toEqual({
      added: null,
      already: null,
      refused: `${gone.dir} does not exist`,
    })
    expect(replies(gone.card.id).at(-1)!.body).toBe(
      `Decided: **Add**\n\nNot added: ${gone.dir} does not exist.`,
    )
    expect((await answer(moved.card.id, 0)).body.repo.refused).toBe(
      `${moved.dir}'s origin is acme/elsewhere, not acme/moved`,
    )
    expect((await answer(first.card.id, 0)).body.repo.added).toMatchObject({ name: 'same' })
    const late = await answer(second.card.id, 0)
    expect(late.status).toBe(200)
    expect(late.body.repo.refused).toContain('already has a repo named same')
    expect(names(pid).filter((n) => ['gone', 'moved', 'same'].includes(n))).toEqual(['same'])
  })

  it('an ordinary card with an Add option adds nothing', async () => {
    const t = features.createTicket(pid, { title: 'plain', status: 'in_progress', repoId }, HUMAN)
    const card = features.askDecision(
      t.id,
      { body: 'Add a repo?', options: [{ label: 'Add' }, { label: 'No' }], block: false },
      AGENT,
    )
    const before = names(pid)
    expect((await answer(card.id, 0)).body.repo).toBeNull()
    expect(names(pid)).toEqual(before)
  })
})

describe('the card stays as asked', () => {
  it('refuses editing its body over REST and MCP, and moving its tab leaves its words', async () => {
    const { id: pid } = newProject('card-stays')
    const t = features.createTicket(pid, { title: 'stays', status: 'in_progress' }, HUMAN)
    const card = await tool('add_repo', {
      ticketId: t.id,
      name: 'stays',
      repoPath: checkout('https://github.com/acme/stays'),
      githubRepo: 'acme/stays',
    })
    for (const as of ['agent', 'human'] as const) {
      const edit = await call('PATCH', `/api/updates/${card.id}`, { body: 'Add repo other?' }, as)
      expect(edit.status, as).toBe(409)
      expect(edit.body.error).toContain("a repo request's card names the repo it adds")
    }
    const mcp = await tool('edit_post', { id: card.id, body: 'Add repo other?' })
    expect(mcp.error).toContain("a repo request's card names the repo it adds")
    expect((await call('PATCH', `/api/updates/${card.id}`, { tab: 'agents' })).status).toBe(200)
    expect(features.getPost(card.id)).toMatchObject({ body: card.body, editedAt: null })
  })
})

describe('who may add repos', () => {
  it('the request is an agent’s: the human gets 403 on add_repo and its REST route', async () => {
    const { id: pid } = newProject('human-asks')
    const t = features.createTicket(pid, { title: 'h', status: 'in_progress' }, HUMAN)
    const input = { name: 'h', repoPath: checkout('https://github.com/acme/h'), githubRepo: 'acme/h' }
    expect(await tool('add_repo', { ticketId: t.id, ...input }, 'human')).toEqual({
      error: 'the human adds repos directly; agents ask here',
    })
    expect((await call('POST', `/api/tickets/${t.id}/repo-request`, input, 'human')).status).toBe(403)
    expect(decisionsOn(t.id)).toEqual([])
  })

  it('an agent gets 403 on adding, changing and removing a repo; the human keeps all three', async () => {
    const { id: pid, repo } = newProject('repo-writes')
    const dir = checkout()
    const add = { projectId: pid, name: 'direct', repoPath: dir }
    expect((await call('POST', '/api/repos', add)).status).toBe(403)
    expect((await call('PATCH', `/api/repos/${repo.id}`, { name: 'renamed' })).status).toBe(403)
    expect((await call('DELETE', `/api/repos/${repo.id}`)).status).toBe(403)
    expect(names(pid)).toEqual(['app'])

    expect((await call('POST', '/api/repos', add, 'human')).status).toBe(201)
    expect((await call('PATCH', `/api/repos/${repo.id}`, { name: 'renamed' }, 'human')).status).toBe(200)
    expect(names(pid)).toEqual(['direct', 'renamed'])
    expect((await call('DELETE', `/api/repos/${repo.id}`, undefined, 'human')).status).toBe(200)
    expect(names(pid)).toEqual(['direct'])
  })

  it('an agent’s Add answer on the board is refused', async () => {
    const { id: pid } = newProject('agent-decides')
    const t = features.createTicket(pid, { title: 'a', status: 'in_progress' }, HUMAN)
    const card = await features.requestRepo(
      t.id,
      { name: 'a', repoPath: checkout('https://github.com/acme/a'), githubRepo: 'acme/a' },
      AGENT,
    )
    expect((await call('PUT', `/api/updates/${card.id}/decision`, { option: 0 })).status).toBe(403)
    expect(names(pid)).toEqual(['app'])
  })
})

describe('own project only', () => {
  it('a request goes to the named ticket’s project, whatever else is passed', async () => {
    const { id: here } = newProject('own-here')
    const { id: there } = newProject('own-there')
    const t = features.createTicket(here, { title: 'here', status: 'in_progress' }, HUMAN)
    const card = await tool('add_repo', {
      ticketId: t.id,
      projectId: there,
      projectName: 'brand new',
      name: 'own',
      repoPath: checkout('https://github.com/acme/own'),
      githubRepo: 'acme/own',
    })
    expect(card.repoRequest.projectId).toBe(here)
    expect((await answer(card.id, 0)).body.repo.added).toMatchObject({ projectId: here })
    expect(names(there)).toEqual(['app'])
    expect(
      dbm.db
        .select()
        .from(dbm.schema.projects)
        .all()
        .map((p) => p.name),
    ).not.toContain('brand new')
  })

  it('as must be one of the project’s agents; an unknown ticket is 404', async () => {
    const { id: pid } = newProject('own-as')
    const t = features.createTicket(pid, { title: 'as', status: 'in_progress' }, HUMAN)
    const input = { name: 'as', repoPath: checkout('https://github.com/acme/as'), githubRepo: 'acme/as' }
    const asked = await call('POST', `/api/tickets/${t.id}/repo-request`, { ...input, as: 'nobody' })
    expect(asked.status).toBe(400)
    expect(asked.body.error).toContain('is not one of this project')
    expect((await call('POST', '/api/tickets/999999/repo-request', input)).status).toBe(404)
    expect(decisionsOn(t.id)).toEqual([])
  })
})

describe('moving a ticket to a repo', () => {
  it('set_ticket_repo moves it at once, its base branch to the repo’s, and logs the move', async () => {
    const { id: pid, repo: app } = newProject('move')
    const other = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'shop', repoPath: path.join(tmp, 'move-shop'), baseBranch: 'dev' })
      .returning()
      .get()
    const t = features.createTicket(pid, { title: 'moving', status: 'in_progress', repoId: app.id }, HUMAN)
    const moved = await tool('set_ticket_repo', { ticketId: t.id, repoId: other.id })
    expect(moved).toMatchObject({ id: t.id, repoId: other.id, baseBranch: 'dev' })
    expect(decisionsOn(t.id)).toEqual([])
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: AGENT,
        text: `updated ticket #${t.id} moving (moved to repo shop from app, base branch → dev)`,
      }),
    )
    // The REST route does the same, with the base branch given.
    const back = await call('PUT', `/api/tickets/${t.id}/repo`, { repoId: app.id, baseBranch: 'release' })
    expect(back.status).toBe(200)
    expect(features.getTicket(t.id)).toMatchObject({ repoId: app.id, baseBranch: 'release' })
  })

  it('refuses a repo of another project, a PR’s own ticket, and an unknown ticket or repo', async () => {
    const { id: pid, repo: app } = newProject('move-refused')
    const { repo: foreign } = newProject('move-foreign')
    const second = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'second', repoPath: path.join(tmp, 'move-second') })
      .returning()
      .get()
    const t = features.createTicket(pid, { title: 't', status: 'in_progress', repoId: app.id }, HUMAN)

    const cross = await tool('set_ticket_repo', { ticketId: t.id, repoId: foreign.id })
    expect(cross.error).toBe(`repo ${foreign.id} is not in project ${pid}`)
    expect((await call('PUT', `/api/tickets/${t.id}/repo`, { repoId: foreign.id })).status).toBe(400)
    expect(features.getTicket(t.id).repoId).toBe(app.id)

    const now = new Date().toISOString()
    const pr = dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId: pid,
        repoId: app.id,
        number: 7,
        title: 'pr',
        url: 'https://example.invalid/pr/7',
        author: HUMAN,
        headRef: 'feat/pr',
        baseRef: 'main',
        headSha: 'abc',
        updatedAt: now,
        fetchedAt: now,
      })
      .returning()
      .get()
    const own = features.createTicket(pid, { title: 'PR 7', status: 'review', repoId: app.id }, HUMAN)
    dbm.db
      .update(dbm.schema.tickets)
      .set({ prId: pr.id, prNumber: 7 })
      .where(eq(dbm.schema.tickets.id, own.id))
      .run()
    const prMove = await call('PUT', `/api/tickets/${own.id}/repo`, { repoId: second.id })
    expect(prMove.status).toBe(400)
    expect(prMove.body.error).toContain('its PR and repo cannot change')

    expect((await call('PUT', '/api/tickets/999999/repo', { repoId: app.id })).status).toBe(404)
    expect((await call('PUT', `/api/tickets/${t.id}/repo`, { repoId: 999_999 })).status).toBe(404)
  })
})
