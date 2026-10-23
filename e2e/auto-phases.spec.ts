import type { Project, TicketFull } from '#/lib/api'
import { inDatabase } from './db'
import { expect, expectTooltip, ok, test } from './fixtures'

const AUTO = ['Pushed', 'PR', 'CI', 'Preview', 'Merged']

/** An open PR row as a refresh from GitHub would leave it (e2e has no GitHub), on `branch`. */
function seedPr(project: Project, number: number, branch: string) {
  const now = new Date().toISOString()
  inDatabase((db) =>
    db
      .prepare(
        `insert into prs (project_id, repo_id, number, title, url, author, head_ref, base_ref, head_sha,
           waiting_on, review_stage, mergeable, merge_state_status, updated_at, fetched_at)
         values (?, ?, ?, ?, ?, 'me', ?, 'main', ?, 'others', 'pending', 'MERGEABLE', 'CLEAN', ?, ?)`,
      )
      .run(
        project.id,
        project.repos[0]!.id,
        number,
        `Work on ${branch}`,
        `https://github.com/example/repo/pull/${number}`,
        branch,
        'f'.repeat(40),
        now,
        now,
      ),
  )
}

test('the phases the board ticks are marked, their boxes off, and nobody ticks them by hand', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Ticked by the board', status: 'in_progress', tasks: ['CI'] },
    }),
  )
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Tasks' })
  const box = (name: string) => card.getByRole('checkbox', { name, exact: true })
  const marks = card.getByLabel('Ticked automatically')
  // One mark per automatic phase; Implementation, Hand-off post and a subtask named CI have none.
  await expect(marks).toHaveCount(AUTO.length)
  const subtasks = card.getByRole('list', { name: 'Subtasks of Implementation' })
  await expect(subtasks.getByRole('checkbox', { name: 'CI', exact: true })).toBeEnabled()
  await expect(subtasks.getByLabel('Ticked automatically')).toHaveCount(0)
  for (const name of ['Implementation', 'Hand-off post']) await expect(box(name)).toBeEnabled()
  const top = card.locator('> ul > li > div')
  for (const name of AUTO) {
    const row = top.filter({ has: page.getByRole('checkbox', { name, exact: true }) })
    await expect(row.getByRole('checkbox', { name, exact: true })).toBeDisabled()
    await expect(row.getByLabel('Ticked automatically')).toHaveCount(1)
  }
  for (const name of ['Implementation', 'Hand-off post']) {
    const row = top.filter({ has: page.getByRole('checkbox', { name, exact: true }) })
    await expect(row.getByLabel('Ticked automatically')).toHaveCount(0)
  }

  // The tooltip says what the board checks.
  const ciRow = top.filter({ has: page.getByRole('checkbox', { name: 'CI', exact: true }) })
  await expectTooltip(
    ciRow.getByLabel('Ticked automatically'),
    `Ticked by the board from GitHub (the PR's checks green, or a "CI run locally: green" comment on the head SHA)`,
  )
  await card.screenshot({ path: test.info().outputPath('auto-phases-marker.png') })

  // A click on a disabled box sends nothing.
  let patched = false
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/api/tasks/')) patched = true
  })
  const ciBox = ciRow.getByRole('checkbox', { name: 'CI', exact: true })
  await ciBox.click({ force: true })
  await expect(ciBox).not.toBeChecked()
  expect(patched).toBe(false)

  // Over REST it is refused, for the human and for an agent, and the tick stays as it was.
  const ci = (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).tasks.find(
    (x) => x.text === 'CI' && x.parentId === null,
  )!
  expect(ci.auto).toBe(true)
  for (const as of [human, agent]) {
    const res = await as.patch(`/api/tasks/${ci.id}`, { data: { done: true } })
    expect(res.status()).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('"CI" is ticked by the board')
  }
  expect(
    (await ok<TicketFull>(human.get(`/api/tickets/${t.id}`))).tasks.find((x) => x.id === ci.id)!.done,
  ).toBe(false)
})

test('a PR on the branch ticks PR on the page, with no one ticking it', async ({ page, project, human }) => {
  const branch = `feat/auto-pr-${project.id}`
  const t = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Opened as a PR', status: 'in_progress', branch },
    }),
  )
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const card = page.getByRole('region', { name: 'Tasks' })
  const pr = card.getByRole('checkbox', { name: 'PR', exact: true })
  await expect(pr).not.toBeChecked()
  seedPr(project, 4000 + project.id, branch)
  // The page reads the ticket again every 10 seconds; that read ticks it.
  await expect(pr).toBeChecked({ timeout: 20_000 })
  await card.screenshot({ path: test.info().outputPath('auto-phases-pr-ticked.png') })
})
