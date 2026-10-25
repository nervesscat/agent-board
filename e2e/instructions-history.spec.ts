import type { APIRequestContext, Page } from '@playwright/test'

import type { InstructionsSet, ProjectInstructionChange } from '#/lib/api'
import { HUMAN } from './env'
import { expect, ok, section, test } from './fixtures'

/** REST as whoever `actor` names in test mode (orchestrator:<name>, agent:<name>), with any other headers. */
async function as(
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
  actor: string,
  headers: Record<string, string> = {},
) {
  return playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Test-Actor': actor, ...headers } })
}

const history = (page: Page) => page.getByRole('region', { name: 'Instructions history' })

test("an orchestrator's change of the instructions waits in Needs you until the human marks it reviewed", async ({
  page,
  project,
  human,
  playwright,
  baseURL,
}, info) => {
  const orchName = `orch-n${info.workerIndex}`
  const orch = await as(playwright, baseURL, `orchestrator:${orchName}`)
  const worker = await as(playwright, baseURL, `agent:${orchName}`, { 'X-Agent-Name': `${orchName}/w1` })
  try {
    await ok(
      human.put(`/api/projects/${project.id}/instructions`, { data: { instructions: 'Run the checks.' } }),
    )
    // A worker, the orchestrator's own sub-identity included, is told to ask its orchestrator.
    const refused = await worker.put(`/api/projects/${project.id}/instructions`, {
      data: { instructions: 'Skip the checks.' },
    })
    expect(refused.status()).toBe(403)
    expect((await refused.json()).error).toContain('ask your orchestrator')
    const set = await ok<InstructionsSet>(
      orch.put(`/api/projects/${project.id}/instructions`, {
        data: { instructions: 'Run the checks.\n\nAnd the e2e suite.' },
      }),
    )
    expect(set.change).toMatchObject({ changedBy: orchName, role: 'orchestrator', state: 'pending' })

    await page.goto(`/projects/${project.id}`)
    const needs = section(page, 'Needs you')
    const row = needs.getByRole('listitem').filter({ hasText: 'Project instructions changed' })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(`by ${orchName}`)
    await expect(row.getByText('Orchestrator', { exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Revert' })).toBeVisible()
    await expect(row.getByRole('link', { name: 'Project instructions changed' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/settings#instructions-history`,
    )
    await row.getByRole('button', { name: 'Reviewed' }).click()
    await expect(row).toHaveCount(0)
    const [latest] = await ok<ProjectInstructionChange[]>(
      human.get(`/api/projects/${project.id}/instructions/changes`),
    )
    expect(latest).toMatchObject({ id: set.change!.id, state: 'accepted', resolvedBy: HUMAN })
    // The text stays as the orchestrator set it.
    expect((await ok<{ instructions: string }>(human.get(`/api/projects/${project.id}`))).instructions).toBe(
      'Run the checks.\n\nAnd the e2e suite.',
    )
  } finally {
    await orch.dispose()
    await worker.dispose()
  }
})

test('the project settings show the history with a diff; Revert puts the text back and adds an entry', async ({
  page,
  project,
  playwright,
  baseURL,
}, info) => {
  const orchName = `orch-h${info.workerIndex}`
  const orch = await as(playwright, baseURL, `orchestrator:${orchName}`)
  try {
    await page.goto(`/projects/${project.id}/settings`)
    await expect(history(page)).toContainText('No changes yet.')

    // The human's own edit, in the editor: kept as an accepted entry with the Human badge.
    const editor = page.getByRole('region', { name: 'Project instructions' })
    await editor.getByRole('button', { name: /No instructions yet/ }).click()
    await editor.getByRole('textbox', { name: 'Project instructions' }).fill('Keep commits small.')
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(editor).toContainText('Keep commits small.')
    const mine = history(page).getByRole('listitem', { name: `Change by ${HUMAN}` })
    await expect(mine).toHaveCount(1)
    await expect(mine.getByText('Human', { exact: true })).toBeVisible()
    await expect(mine).toContainText('reviewed')

    await ok(
      orch.put(`/api/projects/${project.id}/instructions`, {
        data: { instructions: 'Keep commits small.\nSquash before merging.' },
      }),
    )
    await page.reload()
    const theirs = history(page).getByRole('listitem', { name: `Change by ${orchName}` })
    await expect(theirs).toHaveCount(1)
    await expect(theirs.getByText('Orchestrator', { exact: true })).toBeVisible()
    await expect(theirs).toContainText('waiting on you')
    const diff = theirs.getByRole('group', { name: 'What changed in the instructions' })
    await expect(diff.locator('ins')).toHaveText(['+Squash before merging.'])
    await expect(diff).toContainText('Keep commits small.')
    // Newest first.
    await expect(history(page).getByRole('listitem')).toHaveText([new RegExp(orchName), new RegExp(HUMAN)])
    // The older entry cannot be reverted while the newer one stands.
    await expect(mine.getByRole('button', { name: 'Revert' })).toBeDisabled()

    await theirs.getByRole('button', { name: 'Revert' }).click()
    await expect(editor).not.toContainText('Squash before merging.')
    await expect(editor).toContainText('Keep commits small.')
    const entries = history(page).getByRole('listitem')
    await expect(entries).toHaveCount(3)
    await expect(entries.first()).toContainText('a revert')
    await expect(entries.first().getByText('Human', { exact: true })).toBeVisible()
    await expect(theirs).toContainText('reverted')
    await expect(theirs.getByRole('button', { name: 'Revert' })).toHaveCount(0)
  } finally {
    await orch.dispose()
  }
})
