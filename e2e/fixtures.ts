import fs from 'node:fs'

import { type APIRequestContext, type APIResponse, test as base, expect } from '@playwright/test'

import type { Project, Repo, TicketFull } from '#/lib/api'
import { AGENT, HUMAN, e2eEnv } from './env'

export { expect }

/** A JSON body, after checking the call worked (the error text in the failure if it did not). */
export async function ok<T>(res: APIResponse | Promise<APIResponse>): Promise<T> {
  const r = await res
  expect(r.ok(), `${r.url()} answered ${r.status()}: ${await r.text()}`).toBe(true)
  return (await r.json()) as T
}

/**
 * A project of its own, pointing at the run's git repo, with its stages: the defaults, which the board
 * creates as they are first read.
 */
export async function seedProject(human: APIRequestContext, name: string) {
  const { repoPath } = e2eEnv()
  const created = await ok<{ id: number }>(human.post('/api/projects', { data: { name } }))
  await ok<Repo>(human.post('/api/repos', { data: { projectId: created.id, repoPath, name: 'repo' } }))
  const project = await ok<Project>(human.get(`/api/projects/${created.id}`))
  expect(project.stages.map((s) => s.key)).toEqual(
    expect.arrayContaining(['todo', 'in_progress', 'blocked', 'done']),
  )
  return project
}

/** The project global setup seeded, for pages that only need one to exist. */
export function seededProject(): Project {
  return JSON.parse(fs.readFileSync(e2eEnv().seedFile, 'utf8')).project as Project
}

export interface Api {
  ticket(input: { title: string; status?: string; body?: string; tags?: string[] }): Promise<TicketFull>
  getTicket(id: number): Promise<TicketFull>
}

let projects = 0

export const test = base.extend<{
  /** REST as the human (the browser, without a header, is the same human). */
  human: APIRequestContext
  /** REST as an agent: every human-only route answers it 403. */
  agent: APIRequestContext
  /** A fresh project for this test alone, so ticket counts and columns are only its own. */
  project: Project
  api: Api
}>({
  human: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { 'X-Test-Actor': `human:${HUMAN}` },
    })
    await use(ctx)
    await ctx.dispose()
  },
  agent: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { 'X-Test-Actor': `agent:${AGENT}` },
    })
    await use(ctx)
    await ctx.dispose()
  },
  project: async ({ human }, use, info) => {
    await use(await seedProject(human, `${info.title.slice(0, 60)} (${info.workerIndex}.${++projects})`))
  },
  api: async ({ human, project }, use) => {
    await use({
      ticket: (input) =>
        ok<TicketFull>(human.post(`/api/projects/${project.id}/tickets`, { data: input })).then((t) =>
          ok<TicketFull>(human.get(`/api/tickets/${t.id}`)),
        ),
      getTicket: (id) => ok<TicketFull>(human.get(`/api/tickets/${id}`)),
    })
  },
})
