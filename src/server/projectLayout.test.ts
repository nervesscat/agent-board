import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { defaultLayout, inArea, type Layout } from '#/lib/layout'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-project-layout-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

/** A project as one made before the column: no layout stored. */
const newProject = (name: string) => dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

const layoutOf = async (id: number) => (await call('GET', `/api/projects/${id}`)).body.layout as Layout
/** The layout as the row keeps it: null for the defaults. */
const stored = (id: number) =>
  dbm.db
    .select({ layout: dbm.schema.projects.layout })
    .from(dbm.schema.projects)
    .where(eq(dbm.schema.projects.id, id))
    .get()!.layout

describe("a project's layout", () => {
  it('is the defaults on a project that never saved one, over every read', async () => {
    const p = newProject('fresh')
    expect(await layoutOf(p)).toEqual(defaultLayout())
    const listed = (await call('GET', '/api/projects')).body as { id: number; layout: Layout }[]
    expect(listed.find((x) => x.id === p)!.layout).toEqual(defaultLayout())
    const made = await call('POST', '/api/projects', { name: 'made' })
    expect(made.body.layout).toEqual(defaultLayout())
    expect(stored(p)).toBeNull()
  })

  it('is saved as it is in effect and handed out merged with the elements there are now', async () => {
    const p = newProject('saved')
    // Gallery first and hidden, Overview hidden (locked), an id that is gone, Details in the main column.
    const layout = [
      { id: 'nav.gallery', area: 'nav', hidden: true },
      { id: 'nav.overview', area: 'nav', hidden: true },
      { id: 'nav.gone', area: 'nav' },
      { id: 'ticket.details', area: 'ticket.main' },
    ]
    const res = await call('PATCH', `/api/projects/${p}`, { layout })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const nav = inArea(res.body.layout, 'nav')
    // The pages it left out, each after the one before it by default: Team to Settings (Repositories and
    // Instructions among them) after Gallery, PR queue to Previews after Overview, which shows though it
    // was sent hidden.
    expect(nav.map((it) => it.id)).toEqual([
      'nav.gallery',
      'nav.agents',
      'nav.daily',
      'nav.cleanup',
      'nav.repositories',
      'nav.instructions',
      'nav.settings',
      'nav.overview',
      'nav.prs',
      'nav.features',
      'nav.roadmap',
      'nav.previews',
    ])
    expect(nav[0]!.hidden).toBe(true)
    expect(nav.filter((it) => it.hidden)).toHaveLength(1)
    expect(res.body.layout.some((it: { id: string }) => it.id === 'nav.gone')).toBe(false)
    // Details in the main column, after the sections that come before it there by default.
    expect(inArea(res.body.layout, 'ticket.main').map((it) => it.id)).toEqual([
      'ticket.resume',
      'ticket.instructions',
      'ticket.tasks',
      'ticket.timeline',
      'ticket.lanes',
      'ticket.activity',
      'ticket.details',
    ])
    expect(inArea(res.body.layout, 'ticket.side').map((it) => it.id)).not.toContain('ticket.details')
    expect(await layoutOf(p)).toEqual(res.body.layout)
    // What is stored is the cleaned layout, not what was sent.
    expect(stored(p)).toEqual(res.body.layout)

    // The summary's project carries the Overview's cards that show.
    const hidden = res.body.layout.map((it: Layout[number]) =>
      it.id === 'overview.doneToday' ? { ...it, hidden: true } : it,
    )
    await call('PATCH', `/api/projects/${p}`, { layout: hidden })
    const summary = await call('GET', `/api/summary?projectId=${p}`)
    expect(summary.body.projects[0].project.overview).toEqual([
      'overview.needsYou',
      'overview.inProgress',
      'overview.next',
      'overview.carryingOver',
    ])
  })

  it('goes back to the defaults with null', async () => {
    const p = newProject('reset')
    await call('PATCH', `/api/projects/${p}`, { layout: [{ id: 'nav.daily', area: 'nav', hidden: true }] })
    expect(stored(p)).not.toBeNull()
    const res = await call('PATCH', `/api/projects/${p}`, { layout: null })
    expect(res.status).toBe(200)
    expect(res.body.layout).toEqual(defaultLayout())
    expect(stored(p)).toBeNull()
  })

  it('refuses a malformed one (400) and keeps what was saved', async () => {
    const p = newProject('malformed')
    for (const layout of [
      'x',
      [{ id: 'nav.daily' }],
      [{ id: 1, area: 'nav' }],
      [{ id: 'nav.daily', area: 'nav', hidden: 'yes' }],
    ]) {
      const res = await call('PATCH', `/api/projects/${p}`, { layout })
      expect(res.status, JSON.stringify(layout)).toBe(400)
    }
    expect(stored(p)).toBeNull()
  })

  it('is set by the human only: an agent gets 403 and nothing changes', async () => {
    const p = newProject('agent')
    const res = await call('PATCH', `/api/projects/${p}`, { layout: null }, 'agent')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only the human sets the project's layout/)
    const hide = [{ id: 'nav.daily', area: 'nav', hidden: true }]
    expect((await call('PATCH', `/api/projects/${p}`, { layout: hide }, 'agent')).status).toBe(403)
    expect(stored(p)).toBeNull()
    // An agent still reads it.
    expect((await call('GET', `/api/projects/${p}`, undefined, 'agent')).body.layout).toEqual(defaultLayout())
  })
})
