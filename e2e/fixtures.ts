import fs from 'node:fs'

import {
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  test as base,
  expect,
} from '@playwright/test'

import type { Project, Repo, TicketFull } from '#/lib/api'
import { AGENT, HUMAN, e2eEnv } from './env'

export { expect }

/**
 * What a test that starts a run the board runs (a preview or a job), or changes the board-wide preview
 * limit, is tagged with: every run counts against that one limit, so these tests run one at a time
 * (the board-runs project in playwright.config.ts), next to the others.
 */
export const BOARD_RUNS = { tag: '@board-runs' }

/** A JSON body, after checking the call worked (the error text in the failure if it did not). */
export async function ok<T>(res: APIResponse | Promise<APIResponse>): Promise<T> {
  const r = await res
  expect(r.ok(), `${r.url()} answered ${r.status()}: ${await r.text()}`).toBe(true)
  return (await r.json()) as T
}

/**
 * How long to wait before each retry of a seeding call the board answered with a 5xx, in order. Only a
 * 5xx is tried again: a 5xx means the board failed, not that the call was wrong, and a create that
 * failed writes nothing (its ticket and rows land together). A 4xx, and a 5xx after the last retry, fail
 * the test with the URL, the status and the body, exactly as `ok` does.
 */
const RETRY_AFTER_MS = [250, 750]

/** `ok` for a seeding call, trying it again when the board answers a 5xx. */
export async function okRetrying<T>(send: () => Promise<APIResponse>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await send()
    const pause = RETRY_AFTER_MS[attempt]
    if (r.status() < 500 || pause === undefined) {
      expect(r.ok(), `${r.url()} answered ${r.status()}: ${await r.text()}`).toBe(true)
      return (await r.json()) as T
    }
    await new Promise((wait) => setTimeout(wait, pause))
  }
}

/**
 * A project of its own, pointing at the run's git repo, with its stages: the defaults, which the board
 * creates as they are first read.
 */
export async function seedProject(human: APIRequestContext, name: string) {
  const { repoPath } = e2eEnv()
  const created = await okRetrying<{ id: number }>(() => human.post('/api/projects', { data: { name } }))
  await okRetrying<Repo>(() =>
    human.post('/api/repos', { data: { projectId: created.id, repoPath, name: 'repo' } }),
  )
  const project = await okRetrying<Project>(() => human.get(`/api/projects/${created.id}`))
  expect(project.stages.map((s) => s.key)).toEqual(
    expect.arrayContaining(['todo', 'in_progress', 'blocked', 'done']),
  )
  return project
}

/** The project global setup seeded, for pages that only need one to exist. */
export function seededProject(): Project {
  return JSON.parse(fs.readFileSync(e2eEnv().seedFile, 'utf8')).project as Project
}

/** A card of the Home or Overview summary (Needs you, In progress…), by the start of its title. */
export const section = (scope: Page | Locator, title: string) => {
  // The inner locator of `has` is matched inside each card, so it starts from the page.
  const page = 'page' in scope ? scope.page() : scope
  return scope.locator('[data-slot="card"]').filter({
    has: page.locator('[data-slot="card-title"]').filter({ hasText: new RegExp(`^\\s*${title}`) }),
  })
}

/** Opens that tab of a ticket's feed (Main, open on arrival, or Agents, the agents' working record). */
export const openFeedTab = (page: Page, name: 'Main' | 'Agents') =>
  page
    .getByRole('tablist', { name: 'Feed' })
    .getByRole('tab', { name: new RegExp(`^${name}`) })
    .click()

/** The tooltip showing now: the app's shared tooltip, open (one shows at a time). */
export const tooltip = (page: Page) => page.locator('[data-slot="tooltip-content"][data-open]')

/**
 * Rests the pointer on `target`, coming from outside it as a person's would (a tooltip opens as the
 * pointer enters), and expects its tooltip to say exactly `text`, line breaks and all, or to match it.
 * The pointer enters again if the page moved the target from under it before the tooltip opened (a
 * picture loading above it).
 */
export async function expectTooltip(target: Locator, text: string | RegExp) {
  const tip = tooltip(target.page())
  await expect(async () => {
    await target.page().mouse.move(0, 0)
    await target.hover()
    await expect(tip).toBeVisible({ timeout: 2000 })
    const shown = await tip.innerText()
    if (typeof text === 'string') expect(shown).toBe(text)
    else expect(shown).toMatch(text)
  }).toPass({ timeout: 10_000 })
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
  // The board renders on the server, and its buttons do nothing until React takes the page over: a
  // full load (goto, reload) waits for that, so a click right after it is never lost.
  page: async ({ page }, use) => {
    const hydrated = () =>
      page.waitForFunction(() => Object.keys(document.body).some((k) => k.startsWith('__reactFiber')))
    const goto = page.goto.bind(page)
    const reload = page.reload.bind(page)
    page.goto = async (...args) => {
      const res = await goto(...args)
      await hydrated()
      return res
    }
    page.reload = async (...args) => {
      const res = await reload(...args)
      await hydrated()
      return res
    }
    await use(page)
  },
  project: async ({ human }, use, info) => {
    await use(await seedProject(human, `${info.title.slice(0, 60)} (${info.workerIndex}.${++projects})`))
  },
  api: async ({ human, project }, use) => {
    await use({
      ticket: (input) =>
        okRetrying<TicketFull>(() => human.post(`/api/projects/${project.id}/tickets`, { data: input })).then(
          (t) => okRetrying<TicketFull>(() => human.get(`/api/tickets/${t.id}`)),
        ),
      getTicket: (id) => ok<TicketFull>(human.get(`/api/tickets/${id}`)),
    })
  },
})
