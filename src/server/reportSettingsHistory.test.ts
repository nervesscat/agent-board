import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_REPORT_TEMPLATE } from '#/lib/reportTemplate'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-history-'))
process.env.DATA_DIR = tmp

let dbm: typeof import('#/db')
let reports: typeof import('./reports')
let history: typeof import('./reportSettingsHistory')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  reports = await import('./reports')
  history = await import('./reportSettingsHistory')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })
})

let projects = 0
const newProject = () =>
  dbm.db
    .insert(dbm.schema.projects)
    .values({ name: `history ${++projects}` })
    .returning()
    .get().id
const human = (p: number, patch: { prompt?: string; template?: string }) =>
  reports.setReportSettings(p, patch, 'enrique')
const agent = (p: number, patch: { prompt?: string; template?: string }) =>
  reports.setReportSettings(p, patch, 'claude', { agent: true })
const linesOf = (p: number) =>
  dbm.db
    .select()
    .from(dbm.schema.activity)
    .where(
      and(eq(dbm.schema.activity.projectId, p), eq(dbm.schema.activity.refType, 'report-settings-change')),
    )
    .all()

async function rest(method: string, pathname: string, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: as === 'agent' ? { authorization: 'Bearer gate_test' } : {},
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

describe('the history of the prompt and the template', () => {
  it('keeps every change with the value before it, who made it and whether an agent did, newest first', () => {
    const p = newProject()
    human(p, { prompt: 'Two lines.' })
    agent(p, { template: '## Shipped\n\n## Next\n' })
    // The same value again is no change.
    human(p, { prompt: 'Two lines.' })
    agent(p, { template: '## Shipped\n\n## Next\n' })

    const [template, prompt] = history.listChanges(p)
    expect(history.listChanges(p)).toHaveLength(2)
    expect(prompt).toMatchObject({
      projectId: p,
      field: 'prompt',
      oldValue: '',
      newValue: 'Two lines.',
      changedBy: 'enrique',
      byAgent: false,
      state: 'accepted',
    })
    // The default template is kept spelled out, so the change shows what it replaced.
    expect(template).toMatchObject({
      field: 'template',
      oldValue: DEFAULT_REPORT_TEMPLATE,
      newValue: '## Shipped\n\n## Next\n',
      changedBy: 'claude',
      byAgent: true,
      state: 'pending',
    })
    expect(template!.createdAt).toBeTruthy()
    expect(history.listChanges(p, { field: 'prompt' })).toEqual([prompt])
    expect(history.getChange(template!.id)).toEqual(template)
  })

  it('puts each change in the activity as a line by whoever made it, pointing at the change', () => {
    const p = newProject()
    human(p, { prompt: 'Two lines.', template: '## A\n' })
    const changes = history.listChanges(p)
    expect(linesOf(p).map((a) => [a.actor, a.text, a.refId])).toEqual([
      ['enrique', 'changed the report prompt', changes.find((c) => c.field === 'prompt')!.id],
      ['enrique', 'changed the report template', changes.find((c) => c.field === 'template')!.id],
    ])
  })

  it('records nothing when the template is set back to the default it already follows', () => {
    const p = newProject()
    human(p, { template: DEFAULT_REPORT_TEMPLATE })
    human(p, { template: '' })
    expect(history.listChanges(p)).toEqual([])
  })

  it('answers 404 for a change that does not exist', () => {
    expect(() => history.getChange(987_654)).toThrow(/no report settings change 987654/)
  })
})

describe('an agent’s change', () => {
  it('waits on the human, in the settings, until accepted; a human’s never waits', () => {
    const p = newProject()
    human(p, { prompt: 'Mine.' })
    expect(reports.getReportSettings(p).pending).toEqual([])
    agent(p, { prompt: 'Theirs.' })
    const [change] = reports.getReportSettings(p).pending
    expect(change).toMatchObject({
      field: 'prompt',
      oldValue: 'Mine.',
      newValue: 'Theirs.',
      state: 'pending',
    })

    const accepted = history.acceptChange(change!.id, 'enrique')
    expect(accepted).toMatchObject({ state: 'accepted', resolvedBy: 'enrique' })
    expect(accepted.resolvedAt).toBeTruthy()
    expect(reports.getReportSettings(p)).toMatchObject({ prompt: 'Theirs.', pending: [] })
    // Accepting again changes nothing.
    expect(history.acceptChange(change!.id, 'enrique')).toEqual(accepted)
  })

  it('reverted, puts the value back, as a change of its own in the history and the activity', () => {
    const p = newProject()
    human(p, { prompt: 'Mine.' })
    agent(p, { prompt: 'Theirs.' })
    const change = history.pendingChanges(p)[0]!

    const { change: reverted, settings } = history.revertChange(change.id, 'enrique')
    expect(reverted).toMatchObject({ id: change.id, state: 'reverted', resolvedBy: 'enrique' })
    expect(settings).toMatchObject({ prompt: 'Mine.', pending: [], updatedBy: 'enrique' })
    expect(reports.getReportSettings(p).prompt).toBe('Mine.')

    const [revert] = history.listChanges(p)
    expect(revert).toMatchObject({
      field: 'prompt',
      oldValue: 'Theirs.',
      newValue: 'Mine.',
      changedBy: 'enrique',
      byAgent: false,
      state: 'accepted',
      revertOf: change.id,
    })
    expect(linesOf(p).at(-1)).toMatchObject({
      actor: 'enrique',
      text: "reverted claude's change of the report prompt",
      refId: revert!.id,
    })
    // Reverted once is enough, and it cannot be accepted any more.
    expect(() => history.revertChange(change.id, 'enrique')).toThrow(/already reverted/)
    expect(() => history.acceptChange(change.id, 'enrique')).toThrow(/reverted/)
  })

  it('reverted back to the default template, follows the default again', () => {
    const p = newProject()
    agent(p, { template: '## Mine\n' })
    history.revertChange(history.pendingChanges(p)[0]!.id, 'enrique')
    expect(reports.getReportSettings(p)).toMatchObject({
      template: DEFAULT_REPORT_TEMPLATE,
      templateIsDefault: true,
    })
    expect(reports.readReportSettings(p).template).toBe('')
  })

  it('is reverted only while the field still holds it: a later change goes first', () => {
    const p = newProject()
    agent(p, { prompt: 'One.' })
    agent(p, { prompt: 'Two.' })
    const [second, first] = history.pendingChanges(p)
    expect(() => history.revertChange(first!.id, 'enrique')).toThrow(/changed again since/)
    expect(history.getChange(first!.id).state).toBe('pending')

    history.revertChange(second!.id, 'enrique')
    expect(reports.getReportSettings(p).prompt).toBe('One.')
    history.revertChange(first!.id, 'enrique')
    expect(reports.getReportSettings(p)).toMatchObject({ prompt: '', pending: [] })
  })

  it('is not reverted while a later change stands that set the same value again', async () => {
    const p = newProject()
    human(p, { prompt: 'P0' })
    agent(p, { prompt: 'X' })
    human(p, { prompt: 'Y' })
    agent(p, { prompt: 'X' })
    const [newer, older] = history.pendingChanges(p)

    // The human's Y stands after the older change: reverting that one would drop it.
    const refused = await rest('POST', `/api/report-settings/changes/${older!.id}/revert`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/changed again since: revert the later change first/)
    expect(history.getChange(older!.id).state).toBe('pending')
    expect(reports.getReportSettings(p).prompt).toBe('X')
    // The notice offers Revert on the newer one only.
    expect(history.pendingChanges(p)).toMatchObject([
      { id: newer!.id, oldValue: 'Y', newValue: 'X', revertable: true },
      { id: older!.id, oldValue: 'P0', newValue: 'X', revertable: false },
    ])

    // The newer one has no later change: it goes back to the human's Y.
    expect((await rest('POST', `/api/report-settings/changes/${newer!.id}/revert`)).status).toBe(200)
    expect(reports.getReportSettings(p).prompt).toBe('Y')
    // The human's change still stands, so the older one stays refused.
    expect(history.pendingChanges(p)).toMatchObject([{ id: older!.id, revertable: false }])
    expect(() => history.revertChange(older!.id, 'enrique')).toThrow(/changed again since/)
    expect(reports.getReportSettings(p).prompt).toBe('Y')
  })

  it('is undone newest first back to the start, past the records the reverts leave', () => {
    const p = newProject()
    human(p, { prompt: 'P0' })
    agent(p, { prompt: 'X' })
    agent(p, { prompt: 'Y' })
    agent(p, { prompt: 'X' })
    const [c, b, a] = history.pendingChanges(p)
    expect([c, b, a].map((change) => change!.revertable)).toEqual([true, false, false])

    history.revertChange(c!.id, 'enrique')
    expect(reports.getReportSettings(p).prompt).toBe('Y')
    expect(history.pendingChanges(p).map((change) => [change.id, change.revertable])).toEqual([
      [b!.id, true],
      [a!.id, false],
    ])
    history.revertChange(b!.id, 'enrique')
    expect(reports.getReportSettings(p).prompt).toBe('X')
    expect(history.pendingChanges(p)).toMatchObject([{ id: a!.id, revertable: true }])
    history.revertChange(a!.id, 'enrique')
    expect(reports.getReportSettings(p)).toMatchObject({ prompt: 'P0', pending: [] })
    // Each revert is recorded as a change pointing at the one it undid.
    expect(
      history
        .listChanges(p)
        .filter((change) => change.revertOf !== null)
        .map((change) => change.revertOf),
    ).toEqual([a!.id, b!.id, c!.id])
  })
})

describe('the history over REST', () => {
  it('lists the changes newest first and answers one by id', async () => {
    const p = newProject()
    human(p, { prompt: 'A.' })
    agent(p, { prompt: 'B.' })
    const list = await rest('GET', `/api/projects/${p}/report-settings/changes`)
    expect(list.body.map((c: { newValue: string }) => c.newValue)).toEqual(['B.', 'A.'])
    expect((await rest('GET', `/api/report-settings/changes/${list.body[0].id}`)).body).toEqual(list.body[0])
    expect((await rest('GET', `/api/projects/${p}/report-settings`)).body.pending).toEqual([
      { ...list.body[0], revertable: true },
    ])
  })

  it('lets the human accept or revert, never an agent', async () => {
    const p = newProject()
    human(p, { prompt: 'Mine.' })
    agent(p, { prompt: 'Theirs.' })
    const id = history.pendingChanges(p)[0]!.id
    for (const action of ['accept', 'revert'])
      expect((await rest('POST', `/api/report-settings/changes/${id}/${action}`, 'agent')).status).toBe(403)
    expect(history.getChange(id).state).toBe('pending')
    expect(reports.getReportSettings(p).prompt).toBe('Theirs.')

    const reverted = await rest('POST', `/api/report-settings/changes/${id}/revert`)
    expect(reverted.status).toBe(200)
    expect(reverted.body).toMatchObject({ change: { state: 'reverted' }, settings: { prompt: 'Mine.' } })
    expect((await rest('POST', `/api/report-settings/changes/${id}/revert`)).status).toBe(409)
  })
})
