import type { APIRequestContext } from '@playwright/test'

import type { PrRow, Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { HUMAN } from './env'
import { expect, ok, section, test } from './fixtures'

/**
 * A PR of the queue has a ticket of its own, unless a feature ticket names it: its card opens that
 * ticket, it lives in To do, it is on no features view, and its decisions and replies wait in Needs you.
 */

type Row = { id: number }

let prNumbers = 5000

/**
 * An open PR row as a refresh from GitHub would leave it (the e2e repos have no GitHub slug, so none
 * comes). Its author owns its ticket's threads, so a test that waits on the human names the human.
 */
function seedPr(project: Project, title: string, author = 'someone') {
  const number = ++prNumbers
  const now = new Date().toISOString()
  const id = inDatabase(
    (db) =>
      (
        db
          .prepare(
            `insert into prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha,
               waiting_on, review_stage, updated_at, fetched_at)
             values (?, ?, ?, ?, ?, ?, ?, 'main', 'abcdef1234567', 'me', 'pending', ?, ?) returning id`,
          )
          .get(
            project.id,
            project.repos[0]!.id,
            number,
            title,
            `https://github.com/example/repo/pull/${number}`,
            author,
            `branch-${number}`,
            now,
            now,
          ) as Row
      ).id,
  )
  return { id, number }
}

/** The PR's row after a refresh, which opens the ticket of each open PR no feature ticket names. */
async function refreshedRow(human: APIRequestContext, project: Project, pr: Row): Promise<PrRow> {
  const rows = await ok<PrRow[]>(human.get(`/api/projects/${project.id}/prs?refresh=1`))
  return rows.find((r) => r.id === pr.id)!
}

test('a PR of the queue gets its own ticket at the refresh, and its card opens that ticket', async ({
  page,
  project,
  human,
  api,
}) => {
  const pr = seedPr(project, 'Fresh from the queue')
  const { ticket } = await refreshedRow(human, project, pr)
  expect(ticket).toMatchObject({ title: `PR #${pr.number}: Fresh from the queue`, status: 'todo' })

  await page.goto(`/projects/${project.id}/prs#pr-${pr.id}`)
  const open = page.locator(`#pr-${pr.id}`).getByRole('link', { name: 'Open ticket' })
  await expect(open).toHaveAttribute('href', `/projects/${project.id}/features/${ticket!.id}`)
  await open.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${ticket!.id}$`))
  await expect(
    page.getByRole('heading', { level: 1, name: `PR #${pr.number}: Fresh from the queue` }),
  ).toBeVisible()
  // Its page offers no delete (the trash icon is the delete trigger). A feature ticket's page does: the control.
  await expect(page.locator('svg.lucide-trash-2')).toHaveCount(0)
  const feature = await api.ticket({ title: 'A feature, for the delete control' })
  await page.goto(`/projects/${project.id}/features/${feature.id}`)
  await expect(page.locator('svg.lucide-trash-2')).toHaveCount(1)
})

test("a PR's ticket is in To do, and on no features view: not the board, the list or the archive", async ({
  page,
  project,
  human,
  api,
}) => {
  const pr = seedPr(project, 'Kept off the board')
  const title = `PR #${pr.number}: Kept off the board`
  const { ticket } = await refreshedRow(human, project, pr)
  expect((await ok<TicketFull>(human.get(`/api/tickets/${ticket!.id}`))).status).toBe('todo')
  // Feature tickets on each view: once they show, the PR's ticket is known to be off that view too.
  await api.ticket({ title: 'A feature ticket', status: 'todo' })

  await page.goto(`/projects/${project.id}/features?view=board`)
  await expect(page.getByText('A feature ticket').first()).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)
  await page.getByRole('tab', { name: 'List' }).click()
  await expect(page.getByText('A feature ticket').first()).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)

  // Done and archived, as the human would do it: it is still on no view.
  await ok(human.patch(`/api/tickets/${ticket!.id}`, { data: { status: 'done' } }))
  await ok(human.post(`/api/tickets/${ticket!.id}/archive`))
  const shipped = await api.ticket({ title: 'A shipped feature', status: 'done' })
  await ok(human.post(`/api/tickets/${shipped.id}/archive`))
  // A visit reads the archive as it is now: the board page read it before these archives.
  await page.goto(`/projects/${project.id}/features?view=archived`)
  await expect(page.getByText('A shipped feature').first()).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)
})

test('a feature ticket that names a PR takes its card over, and the PR gets no ticket of its own', async ({
  page,
  project,
  human,
}) => {
  const pr = seedPr(project, 'Named by a feature')
  const feature = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'The feature behind it', prNumber: pr.number },
    }),
  )
  const row = await refreshedRow(human, project, pr)
  expect(row.ticket?.id).toBe(feature.id)
  const ownTickets = inDatabase(
    (db) => (db.prepare('select count(*) as n from tickets where pr_id = ?').get(pr.id) as { n: number }).n,
  )
  expect(ownTickets).toBe(0)

  await page.goto(`/projects/${project.id}/prs#pr-${pr.id}`)
  await expect(page.locator(`#pr-${pr.id}`).getByRole('link', { name: 'Open ticket' })).toHaveAttribute(
    'href',
    `/projects/${project.id}/features/${feature.id}`,
  )
})

test("a decision on a PR's ticket is a PR row in Needs you, linked to its post", async ({
  page,
  project,
  human,
  agent,
}) => {
  const pr = seedPr(project, 'Ship it?')
  const { ticket } = await refreshedRow(human, project, pr)
  const decision = await ok<Row>(
    agent.post(`/api/tickets/${ticket!.id}/decisions`, {
      data: { body: 'Merge it now?', options: [{ label: 'Merge' }, { label: 'Wait' }] },
    }),
  )

  await page.goto(`/projects/${project.id}`)
  const needs = section(page, 'Needs you')
  await expect(needs.getByRole('link', { name: 'Decide: Merge it now?' })).toHaveAttribute(
    'href',
    `/projects/${project.id}/features/${ticket!.id}#post-${decision.id}`,
  )
  await expect(needs.getByText(`PR #${pr.number}: Ship it?`)).toBeVisible()
})

test("a reply on a PR's ticket that waits on the human is a PR row in Needs you, linked to the reply", async ({
  page,
  project,
  human,
  agent,
}) => {
  const pr = seedPr(project, 'Mine, waiting', HUMAN)
  const { ticket } = await refreshedRow(human, project, pr)
  const question = await ok<Row>(
    human.post(`/api/tickets/${ticket!.id}/updates`, { data: { body: 'Is CI green?', progress: false } }),
  )
  const reply = await ok<Row>(
    agent.post('/api/comments', {
      data: { parentType: 'update', parentId: question.id, body: 'CI is green now.' },
    }),
  )

  await page.goto(`/projects/${project.id}`)
  const row = section(page, 'Needs you').getByRole('link', { name: `PR #${pr.number}: Mine, waiting` })
  await expect(row).toHaveAttribute(
    'href',
    `/projects/${project.id}/features/${ticket!.id}#post-${question.id}-reply-${reply.id}`,
  )
})
