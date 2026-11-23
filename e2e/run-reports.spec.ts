import { openFeedTab, expect, test } from './fixtures'
import { writeReport } from './runReports'

test('a run report written through the MCP shows on the ticket’s Agents side', async ({
  page,
  api,
  project,
  agent,
}) => {
  const t = await api.ticket({ title: 'Import the ledger' })
  const other = await api.ticket({ title: 'Unrelated work' })
  await writeReport(agent, project.id, t.id, {
    agent: 'hunt',
    round: 2,
    branch: 'feat/ledger',
    headSha: 'a1b2c3d4e5f6a7b8',
    model: 'claude-sonnet',
    effort: 'high',
    briefedBy: 'orch',
    durationMs: 40 * 60_000,
    difficulty: 4,
    confidence: 3,
    steps: [
      { name: 'read the diff', done: true, note: '' },
      { name: 'apply the checklists', done: false, note: 'no classification in the spec' },
    ],
    counts: { candidates: 2, dropped: 1 },
    sections: {
      brief: 'The brief missed the spec’s runbook; I found it in the ticket’s posts.',
      techniques: 'Reliability and injection checklists, picked from the API classification.',
      problems: 'One flaky unit test, rerun once.',
    },
  })
  await writeReport(agent, project.id, other.id, { agent: 'verify', sections: { evidence: 'x' } })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await openFeedTab(page, 'Agents')
  const panel = page.getByRole('region', { name: 'Run reports' })
  await expect(panel).toContainText('hunt')
  await expect(panel).toContainText('round 2')
  // This ticket's own report only: the other ticket's report is not here.
  await expect(panel).not.toContainText('verify')

  await panel.getByRole('button', { name: /hunt/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Run report: hunt round 2' })).toBeVisible()
  await expect(dialog).toContainText('40m')
  await expect(dialog).toContainText('Difficulty')
  await expect(dialog).toContainText('4 / 5')
  await expect(dialog).toContainText('Confidence')
  await expect(dialog).toContainText('3 / 5')
  await expect(dialog).toContainText('The brief missed the spec’s runbook')
  await expect(dialog).toContainText('Reliability and injection checklists')
  await expect(dialog).toContainText('apply the checklists')
  await expect(dialog).toContainText('no classification in the spec')
  await expect(dialog).toContainText('candidates: 2')
  await dialog.getByRole('button', { name: 'Close' }).click()

  // A ticket no subagent reported on has no report entry at all.
  const quiet = await api.ticket({ title: 'Nothing reported' })
  await page.goto(`/projects/${project.id}/features/${quiet.id}`)
  await openFeedTab(page, 'Agents')
  await expect(page.getByRole('region', { name: 'Run reports' })).toHaveCount(0)
})

test('a project agent starts with the common part and keeps a template of its own', async ({
  page,
  project,
}) => {
  await page.goto(`/projects/${project.id}/agents`)
  await page.getByRole('button', { name: 'New agent' }).click()
  const template = page.getByLabel('Run report template')
  await expect(template).toHaveValue(/the kind of run/)
  await page.getByLabel('Name', { exact: true }).fill('auditor')
  const own = '## The rule\n\nAudit the audit: one run report, before the hand-off.'
  await template.fill(own)
  await page.getByRole('button', { name: 'Add agent' }).click()
  await expect(page.getByText('auditor', { exact: true })).toBeVisible()

  // Reopening the editor shows the template as it was saved.
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByLabel('Run report template')).toHaveValue(own)
})
