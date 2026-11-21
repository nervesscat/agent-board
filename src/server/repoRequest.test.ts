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

type Repo = import('#/db').schema.Repo
let dbm: typeof import('#/db')
let features: typeof import('./features')
let repos: typeof import('./repos')
let ticketRepos: typeof import('./ticketRepos')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  repos = await import('./repos')
  ticketRepos = await import('./ticketRepos')
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

/** A repo request's card as an older add_repo posted it: a decision post naming the repo its Add creates. */
async function requestCard(
  ticketId: number,
  input: { name: string; repoPath: string; githubRepo: string; baseBranch?: string },
  actor: string,
) {
  const ticket = features.getTicket(ticketId)
  const req = await repos.checkRepoRequest(ticket.projectId, input)
  const post = features.postUpdate(ticketId, `Add repo \`${req.name}\`?`, [], actor, {
    progress: false,
    decision: true,
    tab: 'main',
  })
  return dbm.db
    .update(dbm.schema.updates)
    .set({
      decision: [
        { label: 'Add', detail: 'Register the checkout as a repo of this project' },
        { label: "Don't add", detail: 'Leave the project as it is' },
      ],
      repoRequest: req,
    })
    .where(eq(dbm.schema.updates.id, post.id))
    .returning()
    .get()
}

describe('adding a repo', () => {
  it('adds the repo to the ticket’s project at once over MCP: no card, the ticket stays, activity under the agent', async () => {
    const { id: pid } = newProject('mcp-add')
    const t = features.createTicket(pid, { title: 'build shop', status: 'in_progress' }, HUMAN)
    const dir = checkout('https://github.com/acme/shop.git')
    const before = features.getTicket(t.id).repoId

    const repo = await tool('add_repo', {
      ticketId: t.id,
      name: 'shop',
      repoPath: dir,
      githubRepo: 'acme/shop',
    })
    expect(repo).toMatchObject({
      projectId: pid,
      name: 'shop',
      repoPath: dir,
      githubRepo: 'acme/shop',
      baseBranch: 'main',
    })
    expect(names(pid)).toEqual(['app', 'shop'])
    expect(decisionsOn(t.id)).toEqual([])
    expect(features.getTicket(t.id)).toMatchObject({ status: 'in_progress', repoId: before })
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({
        actor: AGENT,
        kind: 'project',
        text: 'added repo shop (acme/shop)',
        refType: 'repo',
        refId: repo.id,
      }),
    )
  })

  it('has REST routes for it, the older path included, base branch too; the human may call them', async () => {
    const { id: pid } = newProject('rest-add')
    const t = features.createTicket(pid, { title: 'build', status: 'todo' }, HUMAN)
    const dir = checkout('git@github.com:acme/api.git')
    const added = await call('POST', `/api/tickets/${t.id}/repos`, {
      name: 'api',
      repoPath: dir,
      githubRepo: 'acme/api',
      baseBranch: 'dev',
    })
    expect(added.status).toBe(201)
    expect(added.body).toMatchObject({
      projectId: pid,
      name: 'api',
      githubRepo: 'acme/api',
      baseBranch: 'dev',
    })
    const old = await call('POST', `/api/tickets/${t.id}/repo-request`, {
      name: 'web',
      repoPath: checkout('https://github.com/acme/web'),
      githubRepo: 'acme/web',
    })
    expect(old.status).toBe(201)
    const human = await call(
      'POST',
      `/api/tickets/${t.id}/repos`,
      { name: 'docs', repoPath: checkout('https://github.com/acme/docs'), githubRepo: 'acme/docs' },
      'human',
    )
    expect(human.status).toBe(201)
    expect(names(pid)).toEqual(['api', 'app', 'docs', 'web'])
    expect(features.getTicket(t.id).status).toBe('todo')
    expect(decisionsOn(t.id)).toEqual([])
  })
})

describe('the checks of an add', () => {
  let pid: number
  let ticketId: number
  beforeAll(() => {
    pid = newProject('checks').id
    ticketId = features.createTicket(pid, { title: 'checks', status: 'in_progress' }, HUMAN).id
  })
  const ask = (input: { name?: string; repoPath: string; githubRepo: string }) =>
    refusal(() => features.addProjectRepo(ticketId, { name: 'new', ...input }, AGENT))

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
    expect(names(pid)).toEqual(['app'])
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
    expect(names(pid)).toEqual(['app'])
  })

  it('compares owner and name in any casing', async () => {
    const dir = checkout('https://github.com/Acme/Shop.git')
    const repo = await features.addProjectRepo(
      ticketId,
      { name: 'cased', repoPath: dir, githubRepo: 'acme/shop' },
      AGENT,
    )
    expect(repo).toMatchObject({ githubRepo: 'acme/shop' })
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
    expect(names(pid)).toEqual(['app', 'cased'])
  })

  it('refuses a registered checkout spelled with ., .. or doubled slashes, and stores a path resolved', async () => {
    const dir = checkout('https://github.com/acme/spelled.git')
    const fwd = dir.replace(/\\/g, '/')
    const parent = path.dirname(fwd)
    const base = path.basename(fwd)
    // Resolved, a new checkout's path loses its `.`, `..` and doubled slashes.
    const repo = await features.addProjectRepo(
      ticketId,
      { name: 'spelled', repoPath: `${parent}/nope/..//./${base}/.`, githubRepo: 'acme/spelled' },
      AGENT,
    )
    expect(repo).toMatchObject({ repoPath: dir })

    const registered = checkout('https://github.com/acme/registered.git')
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: newProject('checks-spelled').id, name: 'registered', repoPath: registered })
      .run()
    const r = registered.replace(/\\/g, '/')
    const [p, b] = [path.dirname(r), path.basename(r)]
    for (const spelling of [`${p}/./${b}`, `${r}/.`, `${p}/nope/../${b}`, `${p}//${b}`]) {
      expect(
        await ask({ name: 'registered', repoPath: spelling, githubRepo: 'acme/registered' }),
        spelling,
      ).toMatchObject({
        status: 409,
        message: expect.stringContaining('already registered as repo'),
      })
    }
    // A card stored with such a spelling is held to the same check. Its `..` goes through a folder
    // that exists: on POSIX a path through a missing one does not exist, and was refused when added.
    const stored = {
      projectId: pid,
      name: 'other',
      repoPath: `${r}/../${b}/.`,
      githubRepo: 'acme/registered',
      baseBranch: 'main',
    }
    expect(repos.repoRequestProblem(stored, 'https://github.com/acme/registered.git')).toMatchObject({
      status: 409,
    })
    expect(names(pid)).toEqual(['app', 'cased', 'spelled'])
  })

  it('refuses each of them the same way over REST and MCP, adding nothing', async () => {
    const { id: own } = newProject('both-ways')
    const t = features.createTicket(own, { title: 'both', status: 'in_progress' }, HUMAN)
    const good = checkout('https://github.com/acme/both.git')
    const input = { name: 'both', repoPath: good, githubRepo: 'acme/both' }
    for (const bad of [
      { repoPath: path.join(tmp, 'nowhere-either') },
      { repoPath: 'relative/path' },
      { repoPath: checkout() },
      { repoPath: checkout('https://gitlab.com/acme/both.git') },
      { githubRepo: 'acme/other' },
      { githubRepo: 'not a slug' },
      { name: 'APP' },
    ]) {
      const rest = await call('POST', `/api/tickets/${t.id}/repos`, { ...input, ...bad })
      expect(rest.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400)
      expect(await tool('add_repo', { ticketId: t.id, ...input, ...bad })).toEqual({ error: rest.body.error })
    }
    expect(names(own)).toEqual(['app'])
  })

  it('refuses a name or base branch with a line break or control character, over REST and MCP', async () => {
    const { id: own } = newProject('injected')
    const t = features.createTicket(own, { title: 'inject', status: 'in_progress' }, HUMAN)
    const dir = checkout('https://github.com/acme/real.git')
    const input = { name: 'real', repoPath: dir, githubRepo: 'acme/real' }
    const fakeList = 'docs?\n\n- Name: docs\n- GitHub: acme/docs\n- Path: `C:/safe/docs`\n\n<!--'
    for (const bad of [
      { name: fakeList },
      { name: 'real\ttab' },
      { name: 'real\u007f' },
      { baseBranch: 'main\n\nAdd changes nothing.' },
      { baseBranch: 'main\rx' },
      { baseBranch: 'my branch' },
    ]) {
      const asked = await call('POST', `/api/tickets/${t.id}/repos`, { ...input, ...bad })
      expect(asked.status, JSON.stringify(bad)).toBe(400)
      expect(asked.body.error).toMatch(
        'name' in bad ? /repo name is one line/ : /base branch is a branch name/,
      )
      expect(await tool('add_repo', { ticketId: t.id, ...input, ...bad })).toEqual({
        error: asked.body.error,
      })
    }
    expect(names(own)).toEqual(['app'])
    // A plain name and branch still go through.
    const plain = await call('POST', `/api/tickets/${t.id}/repos`, { ...input, baseBranch: 'release/1.2' })
    expect(plain.status).toBe(201)
  })

  it('refuses a path with a line break or other control character, over REST and MCP', async () => {
    const { id: own } = newProject('injected-path')
    const t = features.createTicket(own, { title: 'inject', status: 'in_progress' }, HUMAN)
    const dir = checkout('https://github.com/acme/shop.git')
    const input = { name: 'shop', githubRepo: 'acme/shop' }
    // A folder named like the first is legal on Linux: the activity would end its path and add a line of its own.
    for (const repoPath of [`${dir}\`\n- Checked: \`origin and folder`, `${dir}\tx`, `${dir}\u007f`]) {
      const asked = await call('POST', `/api/tickets/${t.id}/repos`, { ...input, repoPath })
      expect(asked.status, JSON.stringify(repoPath)).toBe(400)
      expect(asked.body.error).toMatch(/path is one line/)
      expect(await tool('add_repo', { ticketId: t.id, ...input, repoPath })).toEqual({
        error: asked.body.error,
      })
    }
    expect(names(own)).toEqual(['app'])
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
    const card = await requestCard(t.id, { name, repoPath: dir, githubRepo: slug, ...extra }, AGENT)
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

  it('Add gives a checkout of the board its Preview run, as adding a repo by hand does; other repos get none', async () => {
    const { card, dir } = await ask('board-copy')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-board' }))
    const { card: plain } = await ask('not-board')
    expect((await answer(card.id, 0)).body.repo.added).toMatchObject({ name: 'board-copy' })
    expect((await answer(plain.id, 0)).body.repo.added).toMatchObject({ name: 'not-board' })
    const runsOf = (name: string) => {
      const repo = repos.listRepos(pid).find((r) => r.name === name)!
      const configs = dbm.db
        .select()
        .from(dbm.schema.runConfigs)
        .where(eq(dbm.schema.runConfigs.repoId, repo.id))
        .all()
      return { seeded: repo.runsSeeded, runs: configs.map((c) => [c.name, c.type, c.createdBy]) }
    }
    expect(runsOf('board-copy')).toEqual({ seeded: true, runs: [['Preview', 'preview', 'board']] })
    expect(runsOf('not-board')).toEqual({ seeded: false, runs: [] })
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

  it('on Add, refuses a path a repo of the board took since, in any spelling, and adds nothing', async () => {
    const { card, dir } = await ask('taken')
    const fwd = dir.replace(/\\/g, '/')
    // The human added it to another project by hand, spelled with `.` and `..`.
    dbm.db
      .insert(dbm.schema.repos)
      .values({
        projectId: newProject('answers-taken').id,
        name: 'taken-there',
        repoPath: `${path.dirname(fwd)}/x/../${path.basename(fwd)}/.`,
      })
      .run()
    const answered = await answer(card.id, 0)
    expect(answered.status).toBe(200)
    expect(answered.body.repo).toMatchObject({ added: null, already: null })
    expect(answered.body.repo.refused).toContain('already registered as repo')
    expect(names(pid)).not.toContain('taken')
  })

  it('Add again finds the repo it added in any spelling: already added', async () => {
    const { card, dir } = await ask('respelled')
    expect((await answer(card.id, 0)).body.repo.added).toMatchObject({ name: 'respelled' })
    const added = repos.listRepos(pid).find((r) => r.name === 'respelled')!
    const fwd = dir.replace(/\\/g, '/')
    dbm.db
      .update(dbm.schema.repos)
      .set({ repoPath: `${path.dirname(fwd)}//${path.basename(fwd)}/./` })
      .where(eq(dbm.schema.repos.id, added.id))
      .run()
    expect((await answer(card.id, 0)).body.repo).toMatchObject({ added: null, already: { id: added.id } })
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

describe('a card an older add_repo posted stays as asked', () => {
  it('refuses editing its body over REST and MCP, and moving its tab leaves its words', async () => {
    const { id: pid } = newProject('card-stays')
    const t = features.createTicket(pid, { title: 'stays', status: 'in_progress' }, HUMAN)
    const card = await requestCard(
      t.id,
      { name: 'stays', repoPath: checkout('https://github.com/acme/stays'), githubRepo: 'acme/stays' },
      AGENT,
    )
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
  it('an agent gets 403 on adding, changing and removing a repo; the human keeps all three', async () => {
    const { id: pid, repo } = newProject('repo-writes')
    const dir = checkout()
    const add = { projectId: pid, name: 'direct', repoPath: dir }
    const refused = await call('POST', '/api/repos', add)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain('POST /api/tickets/:id/repos')
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
    const card = await requestCard(
      t.id,
      { name: 'a', repoPath: checkout('https://github.com/acme/a'), githubRepo: 'acme/a' },
      AGENT,
    )
    expect((await call('PUT', `/api/updates/${card.id}/decision`, { option: 0 })).status).toBe(403)
    expect(names(pid)).toEqual(['app'])
  })
})

describe('own project only', () => {
  it('an add goes to the named ticket’s project, whatever else is passed', async () => {
    const { id: here } = newProject('own-here')
    const { id: there } = newProject('own-there')
    const t = features.createTicket(here, { title: 'here', status: 'in_progress' }, HUMAN)
    const repo = await tool('add_repo', {
      ticketId: t.id,
      projectId: there,
      projectName: 'brand new',
      name: 'own',
      repoPath: checkout('https://github.com/acme/own'),
      githubRepo: 'acme/own',
    })
    expect(repo).toMatchObject({ projectId: here, name: 'own' })
    expect(names(here)).toEqual(['app', 'own'])
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
    const added = await call('POST', `/api/tickets/${t.id}/repos`, { ...input, as: 'nobody' })
    expect(added.status).toBe(400)
    expect(added.body.error).toContain('is not one of this project')
    expect((await call('POST', '/api/tickets/999999/repos', input)).status).toBe(404)
    expect(names(pid)).toEqual(['app'])
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
        // The ticket's list of repos changes with it, and says so.
        text: `updated ticket #${t.id} moving (moved to repo shop from app, base branch → dev, repos → shop)`,
      }),
    )
    // The REST route does the same, with the base branch given.
    const back = await call('PUT', `/api/tickets/${t.id}/repo`, { repoId: app.id, baseBranch: 'release' })
    expect(back.status).toBe(200)
    expect(features.getTicket(t.id)).toMatchObject({ repoId: app.id, baseBranch: 'release' })
  })

  it('set_ticket_repo to a repo the ticket already spans makes it the primary, with its own branch, base and PR', async () => {
    const { id: pid, repo: app } = newProject('promote')
    const shop = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'shop', repoPath: path.join(tmp, 'promote-shop'), baseBranch: 'dev' })
      .returning()
      .get()
    const t = features.createTicket(
      pid,
      { title: 'spanning', status: 'in_progress', repoId: app.id, branch: 'feat/app' },
      HUMAN,
    )
    features.updateTicket(
      t.id,
      {
        repos: [
          { repoId: app.id },
          { repoId: shop.id, branch: 'feat/shop', baseBranch: 'release', prNumber: 12 },
        ],
      },
      HUMAN,
    )
    const moved = await tool('set_ticket_repo', { ticketId: t.id, repoId: shop.id })
    // Its own base, not the repo's dev: none was given.
    expect(moved).toMatchObject({
      id: t.id,
      repoId: shop.id,
      branch: 'feat/shop',
      baseBranch: 'release',
      prNumber: 12,
    })
    // The old primary stays among the ticket's repos, with what it had.
    expect(ticketRepos.ticketRepoList(features.getTicket(t.id))).toEqual([
      {
        repoId: shop.id,
        name: 'shop',
        branch: 'feat/shop',
        baseBranch: 'release',
        prNumber: 12,
        primary: true,
      },
      { repoId: app.id, name: 'app', branch: 'feat/app', baseBranch: 'main', prNumber: null, primary: false },
    ])
    expect(activity(pid).at(-1)).toMatchObject({
      actor: AGENT,
      text: `updated ticket #${t.id} spanning (branch → feat/shop, PR → #12, moved to repo shop from app, base branch → release, repos → shop, app)`,
    })
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

/** A project with an agent-added repo `shop` (a checkout with origin acme/shop) and its ticket. */
async function projectWithShop(name: string) {
  const { id: pid, repo: app } = newProject(name)
  const t = features.createTicket(pid, { title: 'work', status: 'in_progress' }, HUMAN)
  const dir = checkout('https://github.com/acme/shop.git')
  const shop = await tool('add_repo', {
    ticketId: t.id,
    name: 'shop',
    repoPath: dir,
    githubRepo: 'acme/shop',
  })
  return { pid, app, shop, dir, t }
}
const repoRow = (id: number) =>
  dbm.db.select().from(dbm.schema.repos).where(eq(dbm.schema.repos.id, id)).get()
const patchRepo = (pid: number, repoId: number, body: Record<string, unknown>) =>
  call('PATCH', `/api/projects/${pid}/repos/${repoId}`, body)

describe('changing a repo', () => {
  it('changes the name and base branch over MCP, logging each under the agent, and nothing else', async () => {
    const { pid, shop, dir } = await projectWithShop('upd-basic')
    const named = await tool('update_repo', { projectId: pid, repoId: shop.id, name: '  Storefront  ' })
    expect(named).toMatchObject({ id: shop.id, name: 'Storefront', repoPath: dir, githubRepo: 'acme/shop' })
    const based = await tool('update_repo', { projectId: pid, repoId: shop.id, baseBranch: 'release/2' })
    expect(based).toMatchObject({ name: 'Storefront', baseBranch: 'release/2', projectId: pid })
    expect(activity(pid).filter((a) => a.text.startsWith('updated repo'))).toEqual([
      expect.objectContaining({
        actor: AGENT,
        kind: 'project',
        text: 'updated repo Storefront',
        refType: 'repo',
        refId: shop.id,
      }),
      expect.objectContaining({ actor: AGENT, text: 'updated repo Storefront' }),
    ])
    // Over REST: the same, and the case of its own name may change.
    const rest = await patchRepo(pid, shop.id, { name: 'STOREFRONT' })
    expect(rest.status).toBe(200)
    expect(rest.body).toMatchObject({ name: 'STOREFRONT' })
  })

  it('refuses an empty patch, a bad name or base branch, and a name another repo of the project has', async () => {
    const { pid, shop } = await projectWithShop('upd-fields')
    expect(await patchRepo(pid, shop.id, {})).toMatchObject({ status: 400 })
    expect(await tool('update_repo', { projectId: pid, repoId: shop.id })).toEqual({
      error: expect.stringContaining('give at least one of'),
    })
    expect((await patchRepo(pid, shop.id, { name: 'a\nb' })).body.error).toMatch(/repo name is one line/)
    expect((await patchRepo(pid, shop.id, { baseBranch: 'my branch' })).body.error).toMatch(/base branch/)
    expect((await patchRepo(pid, shop.id, { githubRepo: 'nope' })).body.error).toMatch(/owner\/name/)
    const taken = await patchRepo(pid, shop.id, { name: ' APP ' })
    expect(taken.status).toBe(409)
    expect(taken.body.error).toContain('already has a repo named app')
    expect(await tool('update_repo', { projectId: pid, repoId: shop.id, name: 'App' })).toEqual({
      error: taken.body.error,
    })
    expect(repoRow(shop.id)).toMatchObject({ name: 'shop', baseBranch: 'main' })
    expect(activity(pid).filter((a) => a.text.startsWith('updated repo'))).toEqual([])
  })

  it('repaths to another checkout of the same origin, clears the origin looks, and checks what changes', async () => {
    const { pid, shop, dir } = await projectWithShop('upd-path')
    dbm.db.insert(dbm.schema.originRefs).values({ repoId: shop.id, ref: 'main', sha: 'abc' }).run()
    dbm.db.insert(dbm.schema.originRefMoves).values({ repoId: shop.id, ref: 'main', newSha: 'abc' }).run()
    dbm.db.insert(dbm.schema.originLooks).values({ repoId: shop.id }).run()
    const looks = () => [
      dbm.db.select().from(dbm.schema.originRefs).where(eq(dbm.schema.originRefs.repoId, shop.id)).all()
        .length,
      dbm.db
        .select()
        .from(dbm.schema.originRefMoves)
        .where(eq(dbm.schema.originRefMoves.repoId, shop.id))
        .all().length,
      dbm.db.select().from(dbm.schema.originLooks).where(eq(dbm.schema.originLooks.repoId, shop.id)).all()
        .length,
    ]
    expect(looks()).toEqual([1, 1, 1])

    // Refused: not a checkout of acme/shop, or one that is not a checkout at all; nothing changes.
    const other = checkout('https://github.com/acme/other.git')
    expect((await patchRepo(pid, shop.id, { repoPath: other })).body.error).toBe(
      `${other}'s origin is acme/other, not acme/shop`,
    )
    expect((await patchRepo(pid, shop.id, { repoPath: path.join(tmp, 'gone') })).status).toBe(400)
    expect((await patchRepo(pid, shop.id, { repoPath: 'rel/path' })).body.error).toContain('absolute path')
    expect(repoRow(shop.id)).toMatchObject({ repoPath: dir })
    expect(looks()).toEqual([1, 1, 1])

    // Another repo's path is refused, any spelling; the repo's own path is not another's.
    const app = names(pid).includes('app') ? repos.listRepos(pid).find((r) => r.name === 'app')! : null
    const taken = checkout('https://github.com/acme/shop.git')
    dbm.db.update(dbm.schema.repos).set({ repoPath: taken }).where(eq(dbm.schema.repos.id, app!.id)).run()
    const dupe = await patchRepo(pid, shop.id, { repoPath: `${taken}/.` })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toContain('already registered as repo')
    expect(await patchRepo(pid, shop.id, { repoPath: `${dir}/.` })).toMatchObject({ status: 200 })
    expect(looks()).toEqual([1, 1, 1])

    const moved = checkout('git@github.com:Acme/Shop.git')
    const done = await tool('update_repo', { projectId: pid, repoId: shop.id, repoPath: moved })
    expect(done).toMatchObject({ repoPath: moved, githubRepo: 'acme/shop', projectId: pid })
    expect(looks()).toEqual([0, 0, 0])
    expect(activity(pid)).toContainEqual(
      expect.objectContaining({ actor: AGENT, text: 'updated repo shop', refType: 'repo', refId: shop.id }),
    )
  })

  it('changes githubRepo only to the slug the checkout’s origin has, and a repath with it', async () => {
    const { pid, shop } = await projectWithShop('upd-slug')
    const rename = checkout('https://github.com/acme/renamed.git')
    // The origin is not the stored slug, and the new slug is not what the current checkout has either.
    expect((await patchRepo(pid, shop.id, { githubRepo: 'acme/renamed' })).body.error).toContain(
      'origin is acme/shop, not acme/renamed',
    )
    expect((await patchRepo(pid, shop.id, { repoPath: rename })).body.error).toContain(
      'origin is acme/renamed, not acme/shop',
    )
    const both = await patchRepo(pid, shop.id, { repoPath: rename, githubRepo: 'ACME/Renamed' })
    expect(both.status).toBe(200)
    expect(both.body).toMatchObject({ repoPath: rename, githubRepo: 'ACME/Renamed' })
    // The same slug in another casing is no change.
    expect(await patchRepo(pid, shop.id, { githubRepo: 'acme/renamed' })).toMatchObject({ status: 200 })
    expect(repoRow(shop.id)!.githubRepo).toBe('ACME/Renamed')
  })

  it('refuses another project’s repo with 403 and an unknown one with 404, changing nothing', async () => {
    const mine = await projectWithShop('upd-mine')
    const theirs = await projectWithShop('upd-theirs')
    const before = repoRow(theirs.shop.id)
    const rest = await patchRepo(mine.pid, theirs.shop.id, { name: 'taken-over', baseBranch: 'x' })
    expect(rest.status).toBe(403)
    expect(rest.body.error).toContain('is in another project')
    expect(
      await tool('update_repo', { projectId: mine.pid, repoId: theirs.shop.id, name: 'taken-over' }),
    ).toEqual({ error: rest.body.error })
    expect(repoRow(theirs.shop.id)).toEqual(before)
    expect(activity(theirs.pid).filter((a) => a.text.startsWith('updated repo'))).toEqual([])
    expect((await patchRepo(mine.pid, 999999, { name: 'x' })).status).toBe(404)
    expect(await tool('update_repo', { projectId: mine.pid, repoId: 999999, name: 'x' })).toEqual({
      error: expect.stringContaining('not found'),
    })
    // The project is no way to move a repo: projectId in the body is not a field.
    const move = await patchRepo(mine.pid, mine.shop.id, { projectId: theirs.pid, name: 'stays' })
    expect(move.status).toBe(200)
    expect(repoRow(mine.shop.id)).toMatchObject({ projectId: mine.pid, name: 'stays' })
  })
})

describe('removing a repo', () => {
  /** A project with two repos: `one` has a run, a PR with its PR ticket and two feature tickets. */
  async function scenario(name: string) {
    const prTickets = await import('./prTickets')
    const projectId = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
    const [one, two] = ['one', 'two'].map((n) =>
      dbm.db
        .insert(dbm.schema.repos)
        .values({ projectId, name: n, repoPath: path.join(tmp, `${name}-${n}`), githubRepo: `acme/${n}` })
        .returning()
        .get(),
    ) as [Repo, Repo]
    dbm.db
      .insert(dbm.schema.runConfigs)
      .values({ repoId: one.id, name: 'preview', type: 'preview', start: 'node x.js' })
      .run()
    const now = new Date().toISOString()
    const pr = dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId,
        repoId: one.id,
        number: 7,
        title: 'seven',
        url: 'https://github.com/acme/one/pull/7',
        author: 'ana',
        headRef: 'feat/one',
        baseRef: 'main',
        headSha: 'abc1234',
        updatedAt: now,
        fetchedAt: now,
      })
      .returning()
      .get()
    prTickets.openPrTickets(projectId, () => 'pending')
    // Spans both: the primary falls to the second. Spans one only: it keeps no repo.
    const spans = features.createTicket(
      projectId,
      {
        title: 'spans',
        repos: [
          { repoId: one.id, branch: 'a' },
          { repoId: two.id, branch: 'b' },
        ],
      },
      HUMAN,
    )
    const solo = features.createTicket(projectId, { title: 'solo', repoId: one.id }, HUMAN)
    const rest = features.createTicket(projectId, { title: 'rest', repoId: two.id }, HUMAN)
    return { projectId, one, two, pr, spans, solo, rest }
  }
  /** What a removal leaves, by names: the same for the page's Remove and the agent's. */
  function snapshot(s: Awaited<ReturnType<typeof scenario>>) {
    const repoName = (id: number | null) =>
      repos.listRepos(s.projectId).find((r) => r.id === id)?.name ?? null
    return {
      repos: names(s.projectId),
      runs: dbm.db
        .select()
        .from(dbm.schema.runConfigs)
        .where(eq(dbm.schema.runConfigs.repoId, s.one.id))
        .all().length,
      prs: dbm.db.select().from(dbm.schema.prs).where(eq(dbm.schema.prs.projectId, s.projectId)).all().length,
      prTickets: dbm.db
        .select()
        .from(dbm.schema.tickets)
        .where(and(eq(dbm.schema.tickets.projectId, s.projectId), isNotNull(dbm.schema.tickets.prId)))
        .all().length,
      tickets: features
        .listTickets(s.projectId)
        .map((t) => ({ title: t.title, repo: repoName(t.repoId), branch: t.branch }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    }
  }

  it('does what the Repositories page’s Remove does, over MCP and REST', async () => {
    const page = await scenario('remove-page')
    expect(snapshot(page)).toMatchObject({ repos: ['one', 'two'], runs: 1, prs: 1, prTickets: 1 })
    expect((await call('DELETE', `/api/repos/${page.one.id}`, undefined, 'human')).status).toBe(200)
    const expected = snapshot(page)
    expect(expected).toEqual({
      repos: ['two'],
      runs: 0,
      prs: 0,
      prTickets: 0,
      tickets: [
        { title: 'rest', repo: 'two', branch: '' },
        { title: 'solo', repo: null, branch: '' },
        { title: 'spans', repo: 'two', branch: 'b' },
      ],
    })

    const viaMcp = await scenario('remove-mcp')
    const gone = await tool('delete_repo', { projectId: viaMcp.projectId, repoId: viaMcp.one.id })
    expect(gone).toMatchObject({ id: viaMcp.one.id, name: 'one', projectId: viaMcp.projectId })
    expect(snapshot(viaMcp)).toEqual(expected)

    const viaRest = await scenario('remove-rest')
    const res = await call('DELETE', `/api/projects/${viaRest.projectId}/repos/${viaRest.one.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: viaRest.one.id, name: 'one' })
    expect(snapshot(viaRest)).toEqual(expected)

    // The same line in the project's activity as the page's, under the agent's name.
    for (const s of [viaMcp, viaRest])
      expect(activity(s.projectId)).toContainEqual(
        expect.objectContaining({ actor: AGENT, kind: 'project', text: 'removed repo one' }),
      )
    expect(activity(page.projectId)).toContainEqual(
      expect.objectContaining({ actor: HUMAN, text: 'removed repo one' }),
    )
  })

  it('leaves the checkout on disk alone', async () => {
    const { pid, shop, dir } = await projectWithShop('remove-disk')
    await tool('delete_repo', { projectId: pid, repoId: shop.id })
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(names(pid)).toEqual(['app'])
  })

  it('refuses another project’s repo with 403 and an unknown one with 404, removing nothing', async () => {
    const mine = await projectWithShop('remove-mine')
    const theirs = await projectWithShop('remove-theirs')
    const rest = await call('DELETE', `/api/projects/${mine.pid}/repos/${theirs.shop.id}`)
    expect(rest.status).toBe(403)
    expect(rest.body.error).toContain('is in another project')
    expect(await tool('delete_repo', { projectId: mine.pid, repoId: theirs.shop.id })).toEqual({
      error: rest.body.error,
    })
    expect(names(theirs.pid)).toEqual(['app', 'shop'])
    expect(activity(theirs.pid).filter((a) => a.text.startsWith('removed repo'))).toEqual([])
    expect((await call('DELETE', `/api/projects/${mine.pid}/repos/999999`)).status).toBe(404)
    expect(await tool('delete_repo', { projectId: mine.pid, repoId: 999999 })).toEqual({
      error: expect.stringContaining('not found'),
    })
  })
})
