import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'
import { writeReport } from './runReports'
import { age, create, errorsOn, record } from './workTimeline'

/**
 * A work bar on the timeline opens the run report written for that run (the ticket page's chart and the
 * Roadmap's), or its facts with a line saying there is none. The old Run reports page is gone.
 */

const ticketBar = (page: Page) => page.getByRole('region', { name: 'Timeline' }).getByTestId('work-timeline')

test('a work bar opens its run report, by click and by Enter, and Escape returns to the bar', async ({
  page,
  project,
  human,
  agent,
}) => {
  const errors = errorsOn(page)
  const t = await create(human, project, { title: 'Import the ledger', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
  age(t.id, 30)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'builder' })
  await writeReport(agent, project.id, t.id, {
    agent: 'builder',
    model: 'claude-sonnet',
    difficulty: 4,
    confidence: 3,
    steps: [
      { name: 'read the spec', done: true, note: '' },
      { name: 'run the checks', done: false, note: 'lint was slow' },
    ],
    counts: { files: 5, tests: 12 },
    sections: { brief: 'The brief was enough to start.', approach: 'A pure matcher, then the dialog.' },
  })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const bar = page.getByRole('button', { name: /^Open the builder report: build by builder/ })
  await expect(bar).toHaveCount(1)
  await expect(bar).toHaveCSS('cursor', 'pointer')
  await bar.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Run report: builder' })).toBeVisible()
  await expect(dialog).toContainText('The brief was enough to start.')
  await expect(dialog).toContainText('A pure matcher, then the dialog.')
  await expect(dialog).toContainText('read the spec')
  await expect(dialog).toContainText('lint was slow')
  await expect(dialog).toContainText('files: 5')
  await expect(dialog).toContainText('Difficulty')
  await expect(dialog).toContainText('4 / 5')
  await expect(dialog).toContainText('3 / 5')
  await expect(dialog).not.toContainText('No report for this run')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  // From the keyboard: Enter opens it, Escape closes it and the focus is back on the bar.
  await bar.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('The brief was enough to start.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(bar).toBeFocused()
  await ticketBar(page).screenshot({ path: test.info().outputPath('timeline-run-report-bar.png') })
  expect(errors).toEqual([])
})

test('a bar names its round, and without a report opens its facts and says there is none', async ({
  page,
  project,
  human,
  agent,
}) => {
  const t = await create(human, project, { title: 'Hunt without a note', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'hunt', round: 3, agent: 'hunt-2' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'hunt-2' })
  // A report of another round does not belong to it.
  await writeReport(agent, project.id, t.id, {
    agent: 'hunt',
    round: 2,
    sections: { brief: 'The earlier round.' },
  })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const bar = page.getByRole('button', { name: /^Open the hunt-2 report, round 3: hunt round 3 by hunt-2/ })
  await bar.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('hunt round 3')
  await expect(dialog).toContainText('hunt-2')
  await expect(dialog).toContainText('Started')
  await expect(dialog).toContainText('Duration')
  await expect(dialog).toContainText('No report for this run.')
  await expect(dialog).not.toContainText('The earlier round.')
  await page.keyboard.press('Escape')
  await expect(bar).toBeFocused()
})

test('two hunts of one round each open their own report', async ({ page, project, human, agent }) => {
  const t = await create(human, project, { title: 'Two hunts', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'hunt', round: 2, agent: 'hunt-1' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'hunt-1' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'hunt', round: 2, agent: 'hunt-2' })
  age(t.id, 20)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'hunt-2' })
  // The spans: hunt-1 from 40 to 20 minutes ago, hunt-2 from 20 minutes ago to now. Written second one first.
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  await writeReport(agent, project.id, t.id, {
    agent: 'hunt',
    round: 2,
    startedAt: minutesAgo(19),
    endedAt: minutesAgo(1),
    sections: { brief: 'Brief of the second hunt.' },
  })
  await writeReport(agent, project.id, t.id, {
    agent: 'hunt',
    round: 2,
    startedAt: minutesAgo(39),
    endedAt: minutesAgo(21),
    sections: { brief: 'Brief of the first hunt.' },
  })

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  const first = page.getByRole('button', { name: /^Open the hunt-1 report, round 2: / })
  const second = page.getByRole('button', { name: /^Open the hunt-2 report, round 2: / })
  await first.click()
  await expect(page.getByRole('dialog')).toContainText('Brief of the first hunt.')
  await expect(page.getByRole('dialog')).not.toContainText('Brief of the second hunt.')
  await page.keyboard.press('Escape')
  await second.click()
  await expect(page.getByRole('dialog')).toContainText('Brief of the second hunt.')
  await expect(page.getByRole('dialog')).not.toContainText('Brief of the first hunt.')
})

test('a work bar on the Roadmap opens the report of its own ticket', async ({
  page,
  project,
  human,
  agent,
}) => {
  const first = await create(human, project, { title: 'Roadmap ledger', status: 'in_progress' })
  const second = await create(human, project, { title: 'Roadmap export', status: 'in_progress' })
  for (const [t, brief] of [
    [first, 'Brief of the ledger run.'],
    [second, 'Brief of the export run.'],
  ] as const) {
    await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
    age(t.id, 30)
    await record(agent, project, t.id, { kind: 'span_end', agent: 'builder' })
    await writeReport(agent, project.id, t.id, { agent: 'builder', sections: { brief } })
  }

  await page.goto(`/projects/${project.id}/roadmap`)
  const ticket = page.getByTestId('roadmap').getByRole('region', { name: `#${first.id} Roadmap ledger` })
  const bar = ticket.getByRole('button', { name: /^Open the builder report: build by builder/ })
  await bar.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Brief of the ledger run.')
  await expect(dialog).not.toContainText('Brief of the export run.')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(bar).toBeFocused()

  const other = page.getByTestId('roadmap').getByRole('region', { name: `#${second.id} Roadmap export` })
  await other.getByRole('button', { name: /^Open the builder report: / }).click()
  await expect(page.getByRole('dialog')).toContainText('Brief of the export run.')
  await expect(page.getByRole('dialog')).not.toContainText('Brief of the ledger run.')
})

test('a Roadmap bar without a report says so', async ({ page, project, human, agent }) => {
  const t = await create(human, project, { title: 'Roadmap quiet', status: 'in_progress' })
  await record(agent, project, t.id, { kind: 'span_start', phase: 'build', agent: 'builder' })
  age(t.id, 30)
  await record(agent, project, t.id, { kind: 'span_end', agent: 'builder' })

  await page.goto(`/projects/${project.id}/roadmap`)
  const ticket = page.getByTestId('roadmap').getByRole('region', { name: `#${t.id} Roadmap quiet` })
  await ticket.getByRole('button', { name: /^Open the builder report: / }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('No report for this run.')
  await expect(dialog).toContainText('Duration')
})

test('the sidebar has no Run reports entry, and an old link lands on the Roadmap or the ticket', async ({
  page,
  api,
  project,
}) => {
  await page.goto(`/projects/${project.id}`)
  await expect(page.locator('aside nav').getByRole('link', { name: 'Run reports' })).toHaveCount(0)
  await expect(page.locator('aside nav').getByRole('link', { name: 'Roadmap' })).toBeVisible()

  const roadmap = new RegExp(`/projects/${project.id}/roadmap(\\?.*)?$`)
  await page.goto(`/projects/${project.id}/run-reports`)
  await expect(page).toHaveURL(roadmap)
  // The agent filter has nowhere to go, and a ticket that is no number falls to the Roadmap.
  await page.goto(`/projects/${project.id}/run-reports?agent=hunt`)
  await expect(page).toHaveURL(roadmap)
  await page.goto(`/projects/${project.id}/run-reports?ticket=abc`)
  await expect(page).toHaveURL(roadmap)

  const t = await api.ticket({ title: 'Where the report lives' })
  await page.goto(`/projects/${project.id}/run-reports?ticket=${t.id}`)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}(\\?.*)?$`))
  await page.goto(`/projects/${project.id}/run-reports?agent=hunt&ticket=${t.id}`)
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/features/${t.id}(\\?.*)?$`))
})
