import type { APIRequestContext, Page } from '@playwright/test'

import type { Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { expect, expectTooltip, ok, test } from './fixtures'
import { look, ownRepo } from './repos'

const ticket = (human: APIRequestContext, project: Project, title: string, branch: string) =>
  ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, { data: { title, status: 'in_progress', branch } }),
  )

/**
 * An open PR row as a refresh from GitHub would leave it (e2e has no GitHub): GitHub said mergeable,
 * as of `fetchedAt`.
 */
function seedPr(
  project: Project,
  pr: { number: number; branch: string; headSha: string; fetchedAt: string },
) {
  return inDatabase(
    (db) =>
      (
        db
          .prepare(
            `insert into prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha,
               waiting_on, review_stage, mergeable, merge_state_status, updated_at, fetched_at)
             values (?, ?, ?, ?, ?, 'me', ?, 'main', ?, 'others', 'pending', 'MERGEABLE', 'CLEAN', ?, ?)
             returning id`,
          )
          .get(
            project.id,
            project.repos[0]!.id,
            pr.number,
            `Work on ${pr.branch}`,
            `https://github.com/example/repo/pull/${pr.number}`,
            pr.branch,
            pr.headSha,
            pr.fetchedAt,
            pr.fetchedAt,
          ) as { id: number }
      ).id,
  )
}

const branchCard = (page: Page) =>
  page.locator('section').filter({ has: page.locator(':scope > h2', { hasText: /^Branch/ }) })

const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString()

test("shows conflicts with origin's moved base on the ticket and in the queue, though GitHub's stored word is mergeable", async ({
  page,
  human,
}, info) => {
  const repo = await ownRepo(human, `Merge state ${info.workerIndex}.${info.repeatEachIndex}`)
  const { project } = repo
  const t = await ticket(human, project, 'Shout the base', 'feat/shout')
  const head = repo.write('feat/shout', 'base.txt', 'BASE\nlines\n')
  await look(human, project)
  const id = seedPr(project, { number: 7, branch: 'feat/shout', headSha: head, fetchedAt: anHourAgo() })

  // Origin's main changes the same line its own way after GitHub's word.
  repo.write('main', 'base.txt', 'based\nlines\n')
  await look(human, project)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const chip = branchCard(page).getByText('conflicts', { exact: true })
  await expect(chip).toBeVisible()
  await expectTooltip(chip, /Checked here against origin\/main, .*\d/)
  await expect(branchCard(page).getByText('mergeable', { exact: true })).toHaveCount(0)

  await page.goto(`/projects/${project.id}/prs?filter=others`)
  const card = page.locator(`#pr-${id}`)
  await expect(card.getByText('conflicts', { exact: true })).toBeVisible()
  await expectTooltip(card.getByText('conflicts', { exact: true }), /Checked here against origin\/main/)
})

test("shows checking for a head not in the checkout until GitHub's word is newer than the base's move", async ({
  page,
  human,
}, info) => {
  const repo = await ownRepo(human, `Merge state fork ${info.workerIndex}.${info.repeatEachIndex}`)
  const { project } = repo
  const t = await ticket(human, project, 'From a fork', 'feat/fork')
  const id = seedPr(project, {
    number: 8,
    branch: 'feat/fork',
    headSha: 'abcdef0123456789abcdef0123456789abcdef01',
    fetchedAt: anHourAgo(),
  })
  repo.write('main', 'other.txt', 'other\n')
  await look(human, project)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(branchCard(page).getByText('checking', { exact: true })).toBeVisible()
  await expectTooltip(
    branchCard(page).getByText('checking', { exact: true }),
    /origin\/main moved after GitHub's word/,
  )

  // A refresh after the move brings GitHub's word again.
  inDatabase((db) =>
    db.prepare('update prs set fetched_at = ? where id = ?').run(new Date().toISOString(), id),
  )
  await page.reload()
  const chip = branchCard(page).getByText('mergeable', { exact: true })
  await expect(chip).toBeVisible()
  await expectTooltip(chip, /GitHub's word as of .*\d/)
})
