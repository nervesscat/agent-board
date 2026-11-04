import type { APIRequestContext, Locator, Page } from '@playwright/test'

import type { ActorRow, AgentTokenRow, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { HUMAN } from './env'
import { expect, expectTooltip, ok, openFeedTab, section, test } from './fixtures'

type Playwright = { request: { newContext: (o: object) => Promise<APIRequestContext> } }

/** REST as whoever `actor` names in test mode (orchestrator:<name>, agent:<name>), with any other headers. */
const as = (playwright: Playwright, baseURL: string | undefined, actor: string, headers = {}) =>
  playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Test-Actor': actor, ...headers } })

/** The role badge inside a name as `Actor` shows it. */
const badge = (scope: ReturnType<Page['locator']>, text: string) => scope.getByText(text, { exact: true })

/** Whether the page itself scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

/** That `inner` lies within `outer`'s left and right edges. */
async function expectInside(inner: Locator, outer: Locator) {
  const a = (await inner.boundingBox())!
  const b = (await outer.boundingBox())!
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1)
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1)
}

test('posts, replies and the assignee show who is who: Human, Orchestrator, Agent under its parent', async ({
  page,
  project,
  api,
  human,
  playwright,
  baseURL,
}, info) => {
  const orchName = `orch-r${info.workerIndex}`
  const sub = `${orchName}/worker-2`
  const legacy = `legacy-r${info.workerIndex}`
  const orch = await as(playwright, baseURL, `orchestrator:${orchName}`)
  const worker = await as(playwright, baseURL, `orchestrator:${orchName}`, { 'X-Agent-Name': sub })
  const old = await as(playwright, baseURL, `agent:${legacy}`)
  try {
    const t = await api.ticket({ title: 'Who is who', status: 'in_progress' })
    // The post, by the orchestrator; a reply under it by its worker, then one by the human.
    const post = await ok<{ id: number }>(
      orch.post(`/api/tickets/${t.id}/updates`, {
        data: { body: 'The plan, by the orchestrator.', progress: false },
      }),
    )
    await ok(
      worker.post('/api/comments', {
        data: { parentType: 'update', parentId: post.id, body: 'Built, by the worker.' },
      }),
    )
    await ok(
      human.post('/api/comments', {
        data: { parentType: 'update', parentId: post.id, body: 'Thanks, from me.' },
      }),
    )
    // An old post by a name the human makes an orchestrator only afterwards: it shows the role now.
    await ok(old.post(`/api/tickets/${t.id}/updates`, { data: { body: 'An older post.', progress: false } }))
    const token = await ok<{ id: number }>(human.post('/api/agent-tokens', { data: { name: legacy } }))
    await ok(human.patch(`/api/agent-tokens/${token.id}`, { data: { role: 'orchestrator' } }))
    // The worker claims the ticket: the assignee is the sub-identity.
    expect((await ok<TicketFull>(worker.post(`/api/tickets/${t.id}/claim`, { data: {} }))).assignee).toBe(sub)

    await page.goto(`/projects/${project.id}/features/${t.id}`)
    await openFeedTab(page, 'Main')
    const article = page.getByRole('article').filter({ hasText: 'The plan, by the orchestrator.' })
    await article.getByRole('button', { name: /2 replies/ }).click()

    const author = (text: string) =>
      page.locator(`span[data-slot="tooltip-trigger"][data-role]`).filter({ hasText: text })
    const orchActor = article.locator('span[data-slot="tooltip-trigger"][data-role="orchestrator"]').first()
    await expect(orchActor).toContainText(orchName)
    await expect(badge(orchActor, 'Orchestrator')).toBeVisible()
    await expectTooltip(orchActor, new RegExp(`^${orchName} \\(Orchestrator\\): `))

    const workerActor = author(sub).first()
    await expect(badge(workerActor, 'Agent')).toBeVisible()
    await expect(workerActor).toContainText(`under ${orchName}`)
    await expectTooltip(
      workerActor,
      `${sub} (Agent) ← ${orchName} (Orchestrator): an agent, a worker under ${orchName}`,
    )

    const humanActor = article.locator('span[data-slot="tooltip-trigger"][data-role="human"]').first()
    await expect(humanActor).toContainText(HUMAN)
    await expect(badge(humanActor, 'Human')).toBeVisible()
    await expect(page.getByText('admin', { exact: true })).toHaveCount(0)

    const legacyPost = page.getByRole('article').filter({ hasText: 'An older post.' })
    await expect(badge(legacyPost.locator('span[data-role]').first(), 'Orchestrator')).toBeVisible()

    // The assignee: in the ticket's Assignee field, and on the board card.
    const field = page.locator('#assignee')
    await expect(field).toContainText(sub)
    await expect(badge(field, 'Agent')).toBeVisible()
    await page.goto(`/projects/${project.id}/features?view=board`)
    const card = page.locator('[data-column="in_progress"]').getByRole('link', { name: /Who is who/ })
    const assignee = card.locator('span[data-role]').filter({ hasText: sub }).first()
    await expect(badge(assignee, 'Agent')).toBeVisible()
    await expect(assignee).toContainText(`under ${orchName}`)
  } finally {
    await Promise.all([orch.dispose(), worker.dispose(), old.dispose()])
  }
})

test('Settings > Agents: each token with its role, the Orchestrator switch, its sub-identities and Revoke', async ({
  page,
  human,
  playwright,
  baseURL,
}, info) => {
  const name = `ident-${info.workerIndex}-${Date.now() % 100_000}`
  const token = await ok<{ id: number }>(human.post('/api/agent-tokens', { data: { name } }))
  // It signs in, and one of its subagents says who it is.
  const self = await as(playwright, baseURL, `agent:${name}`)
  const helper = await as(playwright, baseURL, `agent:${name}`, { 'X-Agent-Name': `${name}/helper` })
  try {
    await ok(self.get('/api/me'))
    expect(await ok(helper.get('/api/me'))).toMatchObject({
      actor: `${name}/helper`,
      role: 'worker',
      parent: name,
    })

    await page.goto('/settings')
    const agents = page.getByRole('region', { name: 'Agent tokens' })
    const row = agents.getByRole('listitem', { name: `Agent ${name}` })
    await expect(badge(row, 'Agent').first()).toBeVisible()
    const subs = row.getByRole('list', { name: `Working under ${name}` })
    await expect(subs).toContainText(`${name}/helper`)
    await expect(subs).toContainText(/seen/)

    const toggle = row.getByRole('switch', { name: `${name}: orchestrator` })
    await expect(toggle).not.toBeChecked()
    await expectTooltip(toggle.locator('xpath=ancestor::label[1]'), /also changes the projects' instructions/)
    await toggle.click()
    await expect(toggle).toBeChecked()
    // The role badge itself: the switch's label reads Orchestrator too.
    await expect(row.locator('span[data-role="orchestrator"]')).toHaveText('Orchestrator')
    const actors = await ok<ActorRow[]>(human.get('/api/actors'))
    expect(actors.find((a) => a.name === name)).toMatchObject({ role: 'orchestrator', parent: '' })
    expect(actors.find((a) => a.name === `${name}/helper`)).toMatchObject({ role: 'worker', parent: name })
    expect(await ok(self.get('/api/me'))).toMatchObject({ actor: name, role: 'worker' })
    const tokens = await ok<AgentTokenRow[]>(human.get('/api/agent-tokens'))
    expect(tokens.find((t) => t.id === token.id)).toMatchObject({ role: 'orchestrator' })

    // Connect an agent shows the role, read-only.
    await page.goto('/agents?shell=bash')
    const listed = page
      .getByRole('list', { name: 'Agent tokens' })
      .getByRole('listitem')
      .filter({ hasText: name })
    await expect(badge(listed, 'Orchestrator')).toBeVisible()
    await expect(listed.getByRole('switch')).toHaveCount(0)

    // Back in Settings: a worker again, then revoked.
    await page.goto('/settings')
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(badge(row, 'Agent').first()).toBeVisible()
    expect(
      (await ok<AgentTokenRow[]>(human.get('/api/agent-tokens'))).find((t) => t.id === token.id),
    ).toMatchObject({
      role: 'worker',
    })
    await row.getByRole('button', { name: `Revoke ${name}` }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveCount(0)
    expect((await ok<AgentTokenRow[]>(human.get('/api/agent-tokens'))).map((t) => t.id)).not.toContain(
      token.id,
    )
  } finally {
    await Promise.all([self.dispose(), helper.dispose()])
  }
})

test('an agent never sees the Agents section, nor can it change a role', async ({
  page,
  human,
  agent,
}, info) => {
  const token = await ok<{ id: number }>(
    human.post('/api/agent-tokens', { data: { name: `hidden-${info.workerIndex}-${Date.now() % 100_000}` } }),
  )
  const refused = await agent.patch(`/api/agent-tokens/${token.id}`, { data: { role: 'orchestrator' } })
  expect(refused.status()).toBe(403)
  await page.setExtraHTTPHeaders({ 'X-Test-Actor': 'agent:claude' })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Agent tokens' })).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('Settings > Agents and the instructions history fit 390px', async ({
    page,
    project,
    human,
    playwright,
    baseURL,
  }, info) => {
    const name = `a-very-long-agent-token-name-${info.workerIndex}`.slice(0, 40)
    await ok(human.post('/api/agent-tokens', { data: { name } }))
    const sub = await as(playwright, baseURL, `orchestrator:${name}`, {
      'X-Agent-Name': `${name}/a-long-subagent-name-that-goes-on`,
    })
    const orch = await as(playwright, baseURL, `orchestrator:${name}`)
    try {
      await ok(sub.get('/api/me'))
      await ok(
        orch.put(`/api/projects/${project.id}/instructions`, {
          data: {
            instructions: 'Run the checks before every push, and the e2e suite before a hand-off.\n\nMore.',
          },
        }),
      )
      await page.goto('/settings')
      await expect(
        page.getByRole('region', { name: 'Agent tokens' }).getByRole('listitem', { name: `Agent ${name}` }),
      ).toBeVisible()
      expect(await scrollsSideways(page)).toBe(false)

      await page.goto(`/projects/${project.id}/settings`)
      const history = page.getByRole('region', { name: 'Instructions history' })
      await expect(history.getByRole('group', { name: 'What changed in the instructions' })).toBeVisible()
      expect(await scrollsSideways(page)).toBe(false)

      await page.goto(`/projects/${project.id}`)
      await expect(page.getByText('Project instructions changed')).toBeVisible()
      expect(await scrollsSideways(page)).toBe(false)
    } finally {
      await Promise.all([sub.dispose(), orch.dispose()])
    }
  })

  test('a deep sub-identity stays inside its post, its Summary, the Assignee field and the Overview rows', async ({
    page,
    project,
    api,
    playwright,
    baseURL,
  }, info) => {
    const orchName = `orch-w${info.workerIndex}`
    const sub = `${orchName}/builder-with-a-long-sub-identity/importer-lane-one`
    const worker = await as(playwright, baseURL, `orchestrator:${orchName}`, { 'X-Agent-Name': sub })
    try {
      const t = await api.ticket({ title: 'Narrow names', status: 'in_progress' })
      await ok(worker.post(`/api/tickets/${t.id}/claim`, { data: {} }))
      await ok(
        worker.post(`/api/tickets/${t.id}/updates`, {
          data: { body: 'A post by the worker.', progress: false },
        }),
      )
      await ok(worker.put(`/api/tickets/${t.id}/summary`, { data: { body: 'Where it stands.' } }))
      await ok(
        worker.post(`/api/projects/${project.id}/tickets/${t.id}/events`, { data: { kind: 'heartbeat' } }),
      )
      // Silent for 40 minutes: it is in progress and stalled on the Overview.
      inDatabase((db) => {
        db.prepare(
          "update ticket_events set at = strftime('%Y-%m-%dT%H:%M:%fZ', at, '-40 minutes') where ticket_id = ?",
        ).run(t.id)
        db.prepare(
          `update tickets set "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt", '-40 minutes'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '-40 minutes') where id = ?`,
        ).run(t.id)
      })
      const actorIn = (scope: Locator) =>
        scope
          .locator('span[data-slot="tooltip-trigger"][data-role="worker"]')
          .filter({ hasText: sub })
          .first()

      await page.goto(`/projects/${project.id}/features/${t.id}`)
      await openFeedTab(page, 'Main')
      const post = page.getByRole('article').filter({ hasText: 'A post by the worker.' })
      const summary = page.getByRole('article', { name: 'Summary' })
      const field = page.locator('#assignee')
      await expect(actorIn(post)).toBeVisible()
      await expect(actorIn(summary)).toBeVisible()
      await expect(field).toContainText(sub)
      expect(await scrollsSideways(page)).toBe(false)
      await expectInside(actorIn(post), post)
      await expectInside(actorIn(summary), summary)
      await expectInside(field.getByText(sub, { exact: true }), field)
      // The whole chain is still in the tooltip.
      await expectTooltip(
        actorIn(post),
        new RegExp(
          `^${sub} \\(Agent\\) ← ${orchName}/builder-with-a-long-sub-identity \\(Agent\\) ← ${orchName} `,
        ),
      )

      await page.goto(`/projects/${project.id}`)
      const needsYou = section(page, 'Needs you')
      const stalled = needsYou
        .getByRole('listitem')
        .filter({ has: page.getByRole('link', { name: `Stalled: #${t.id} Narrow names` }) })
      const working = section(page, 'In progress')
        .getByRole('listitem')
        .filter({ has: page.getByRole('link', { name: /Narrow names/ }) })
      await expect(actorIn(stalled)).toBeVisible()
      await expect(actorIn(working)).toBeVisible()
      expect(await scrollsSideways(page)).toBe(false)
      await expectInside(actorIn(stalled), needsYou)
      await expectInside(actorIn(working), section(page, 'In progress'))
      await page.screenshot({ path: test.info().outputPath('deep-sub-identity-overview-390.png') })
    } finally {
      await worker.dispose()
    }
  })

  test("a deep sub-identity on a board card is cut short: its badge and the card's time stay in view", async ({
    page,
    project,
    api,
    playwright,
    baseURL,
  }, info) => {
    const orchName = `orch-c${info.workerIndex}`
    const sub = `${orchName}/builder-with-a-long-sub-identity/importer-lane-one`
    const worker = await as(playwright, baseURL, `orchestrator:${orchName}`, { 'X-Agent-Name': sub })
    try {
      const t = await api.ticket({ title: 'Card with a deep assignee', status: 'in_progress' })
      await ok(worker.post(`/api/tickets/${t.id}/claim`, { data: {} }))

      await page.goto(`/projects/${project.id}/features?view=board`)
      const card = page
        .locator('[data-column="in_progress"]')
        .getByRole('link', { name: /Card with a deep assignee/ })
      await card.scrollIntoViewIfNeeded()
      const actor = card
        .locator('span[data-slot="tooltip-trigger"][data-role="worker"]')
        .filter({ hasText: sub })
      const name = actor.getByTestId('actor-name')
      const role = actor.locator('[data-role="worker"]').getByText('Agent', { exact: true })
      const time = card.getByTestId('card-time')
      await expect(name).toHaveText(sub)
      await expect(role).toBeVisible()
      await expect(time).toBeVisible()
      // The name is cut short on its line, not the badge or the time after it.
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
      const row = time.locator('..')
      for (const inner of [role, time]) {
        await expectInside(inner, card)
        await expectInside(inner, row)
      }
      // The whole name and chain are in the tooltip.
      await expectTooltip(
        actor,
        new RegExp(
          `^${sub} \\(Agent\\) ← ${orchName}/builder-with-a-long-sub-identity \\(Agent\\) ← ${orchName} `,
        ),
      )
      await page.screenshot({ path: test.info().outputPath('deep-sub-identity-card-390.png') })
    } finally {
      await worker.dispose()
    }
  })
})
