import path from 'node:path'

import type { Page } from '@playwright/test'

import type { RunConfig, TicketFull, TicketRuns, Workspace } from '#/lib/api'
import { e2eEnv, git } from './env'
import { BOARD_RUNS, expect, ok, test } from './fixtures'

/*
 * Runs for real, with stand-ins for what a project would run: a preview that is a Node one-liner
 * answering on PORT, and a job that is a Node one-liner that logs and stays up. Both start from a git
 * worktree of the run's repo, next to it, as an agent's worktree would be.
 */

const FAKE_PREVIEW = `node -e "require('http').createServer((q, r) => r.end('fake preview')).listen(process.env.PORT, '127.0.0.1')"`
const FAKE_JOB = `node -e "console.log('job started'); setInterval(() => console.log('tick'), 1000)"`

/** A git worktree of the run's repo, next to it, on a branch of its own. */
function worktreeOf(name: string) {
  const branch = `e2e-${name}`
  const worktree = path.join(e2eEnv().root, `wt-${name}`)
  git('worktree', 'add', '-q', '-b', branch, worktree, 'main')
  return { worktree, branch }
}

/** Fills the settings form of a new run and saves it (the form is open). */
async function fillRun(
  page: Page,
  form: ReturnType<Page['getByRole']>,
  run: { name: string; type: 'Preview' | 'Job'; start: string; port?: string },
) {
  await form.getByLabel('Name', { exact: true }).fill(run.name)
  if (run.type === 'Job') {
    await form.getByRole('combobox', { name: 'Type' }).click()
    await page.getByRole('option', { name: /^Job/ }).click()
  }
  await form.getByLabel('Start', { exact: true }).fill(run.start)
  if (run.port !== undefined) await form.getByLabel('Port', { exact: true }).fill(run.port)
  await form.getByRole('button', { name: 'Save' }).click()
}

test(
  'runs set up in the settings start and stop from the ticket’s Runs card: a preview with its link, a job with its log',
  BOARD_RUNS,
  async ({ page, human, agent, project }) => {
    // Two real runs started, stopped and started again, each waiting on a process to come up.
    test.setTimeout(120_000)
    const repo = project.repos[0]!
    const { worktree, branch } = worktreeOf(`${project.id}-runs`)
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, {
        data: { title: 'Run both', status: 'in_progress', branch },
      }),
    )
    await ok<Workspace>(
      human.post(`/api/tickets/${t.id}/workspaces`, { data: { name: 'wt', branch, path: worktree } }),
    )

    // An agent configures nothing: only the human writes a repo's runs.
    const refused = await agent.post(`/api/repos/${repo.id}/runs`, {
      data: { name: 'Evil', type: 'job', start: 'node -e "process.exit()"' },
    })
    expect(refused.status()).toBe(403)

    // The settings' Runs section: the preview, a refused port first (nothing saved), then the job.
    await page.goto(`/projects/${project.id}/settings`)
    const section = page.getByRole('region', { name: 'Runs' })
    const repoRuns = section.getByRole('group', { name: `Runs of ${repo.name}` })
    await expect(repoRuns).toContainText('No runs')
    await repoRuns.getByRole('button', { name: 'Add run' }).click()
    const form = repoRuns.getByRole('form', { name: 'New run' })
    await fillRun(page, form, { name: 'Fake preview', type: 'Preview', start: FAKE_PREVIEW, port: '47100' })
    await expect(form.getByRole('alert')).toHaveText('port: auto, or a port from 47101 to 47199')
    expect(await ok<RunConfig[]>(human.get(`/api/repos/${repo.id}/runs`))).toEqual([])
    await form.getByLabel('Port', { exact: true }).fill('auto')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toHaveCount(0)
    await expect(repoRuns.getByRole('listitem', { name: 'Fake preview' })).toContainText('Preview')
    await repoRuns.getByRole('button', { name: 'Add run' }).click()
    await fillRun(page, repoRuns.getByRole('form', { name: 'New run' }), {
      name: 'Fake job',
      type: 'Job',
      start: FAKE_JOB,
    })
    await expect(repoRuns.getByRole('listitem', { name: 'Fake job' })).toContainText('Job')
    const runs = await ok<RunConfig[]>(human.get(`/api/repos/${repo.id}/runs`))
    expect(runs.map((r) => [r.name, r.type, r.port, r.healthPath])).toEqual([
      ['Fake preview', 'preview', null, '/'],
      ['Fake job', 'job', null, ''],
    ])

    // The ticket's Runs card lists both, from the worktree.
    await page.goto(`/projects/${project.id}/features/${t.id}`)
    const card = page.getByRole('region', { name: 'Runs' })
    const previewRow = card.getByRole('listitem', { name: 'Fake preview' })
    const jobRow = card.getByRole('listitem', { name: 'Fake job' })
    await expect(previewRow.getByTestId('run-status')).toHaveText('Stopped')
    await expect(jobRow.getByTestId('run-status')).toHaveText('Stopped')
    const state = async (name: string) =>
      (await ok<TicketRuns>(human.get(`/api/tickets/${t.id}/runs`))).repos[0]!.runs.find(
        (r) => r.name === name,
      )!.state

    try {
      // The preview: running with an Open link that answers.
      await previewRow.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(previewRow.getByTestId('run-status')).toHaveText('Running', { timeout: 30_000 })
      const open = previewRow.getByRole('link', { name: 'Open' })
      const url = await open.getAttribute('href')
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:471\d\d$/)
      expect(await (await fetch(url!)).text()).toBe('fake preview')

      // The job: running, no link, and its log's last lines on the card.
      await jobRow.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(jobRow.getByTestId('run-status')).toHaveText('Running', { timeout: 30_000 })
      await expect(jobRow.getByRole('link', { name: 'Open' })).toHaveCount(0)
      await expect(jobRow.getByLabel('Fake job log')).toContainText('job started', { timeout: 20_000 })
      expect(await state('Fake job')).toMatchObject({ status: 'running', url: null, port: null })

      // Stop all stops both, and the preview's port answers no more.
      await card.getByRole('button', { name: 'Stop all' }).click()
      await expect(previewRow.getByTestId('run-status')).toHaveText('Stopped')
      await expect(jobRow.getByTestId('run-status')).toHaveText('Stopped')
      await expect
        .poll(() =>
          fetch(url!).then(
            () => 'answers',
            () => 'gone',
          ),
        )
        .toBe('gone')

      // Start all starts both again; each stops on its own.
      await card.getByRole('button', { name: 'Start all' }).click()
      await expect(previewRow.getByTestId('run-status')).toHaveText('Running', { timeout: 30_000 })
      await expect(jobRow.getByTestId('run-status')).toHaveText('Running', { timeout: 30_000 })
      await jobRow.getByRole('button', { name: 'Stop' }).click()
      await expect(jobRow.getByTestId('run-status')).toHaveText('Stopped')
      await expect(previewRow.getByTestId('run-status')).toHaveText('Running')
      await previewRow.getByRole('button', { name: 'Stop' }).click()
      await expect(previewRow.getByTestId('run-status')).toHaveText('Stopped')
      expect(await state('Fake preview')).toMatchObject({ status: 'stopped', port: null })
    } finally {
      await human.post(`/api/tickets/${t.id}/runs/stop`)
    }
  },
)

test('the Runs card stays hidden while the ticket’s repos have no runs and it has no link', async ({
  page,
  api,
  project,
}) => {
  const t = await api.ticket({ title: 'Nothing to run', status: 'in_progress' })
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Nothing to run')
  await expect(page.getByRole('region', { name: 'Details' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Runs' })).toHaveCount(0)
})
