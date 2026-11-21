import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { APIRequestContext, Page } from '@playwright/test'

import { AGENT } from './env'
import { expect, ok, test } from './fixtures'
import type { Api } from './fixtures'

/** A command that records its standard input and environment in a file under `dir`, then exits 0. */
function recorder(dir: string) {
  const script = path.join(dir, 'record.mjs')
  const out = path.join(dir, 'ran.jsonl')
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs'",
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (c) => (input += c))",
      "process.stdin.on('end', () => {",
      '  const e = process.env',
      '  fs.appendFileSync(process.argv[2], JSON.stringify({',
      '    input, ticket: e.BOARD_TICKET_ID, project: e.BOARD_PROJECT_ID, agent: e.BOARD_AGENT_NAME,',
      "    file: e.BOARD_RESUME_PROMPT_FILE, fileText: fs.readFileSync(e.BOARD_RESUME_PROMPT_FILE, 'utf8'),",
      "  }) + '\\n')",
      "  console.log('resume recorded')",
      '})',
    ].join('\n'),
  )
  const runs = () =>
    fs.existsSync(out)
      ? fs
          .readFileSync(out, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, string>)
      : []
  return { command: `"${process.execPath}" "${script}" "${out}"`, runs }
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-resume-'))

/** A ticket held by the agent that asked a decision: the answer on its card is what resumes it. */
async function askedTicket(api: Api, human: APIRequestContext, agent: APIRequestContext) {
  const t = await api.ticket({ title: 'Pick a storage', status: 'in_progress' })
  await ok(human.patch(`/api/tickets/${t.id}`, { data: { assignee: AGENT } }))
  await ok(
    agent.post(`/api/tickets/${t.id}/decisions`, {
      data: {
        body: 'Where should uploads live?',
        options: [{ label: 'Local disk' }, { label: 'MinIO', recommended: true }],
      },
    }),
  )
  return t
}

async function decide(page: Page) {
  const card = page.getByRole('group', { name: 'Decision' })
  await card.getByRole('radio', { name: /MinIO/ }).click()
  await card.getByRole('button', { name: 'Decide' }).click()
  await expect(card).toContainText('decided by enrique')
}

const resumeCard = (page: Page) => page.getByRole('region', { name: 'Resume' })

test('the Resume settings offer the presets, and a custom command and timeout persist', async ({
  page,
  project,
}) => {
  await page.goto(`/settings?tab=project&project=${project.id}`)
  const section = page.getByRole('region', { name: 'Resume' })
  const command = section.getByLabel('Resume command')
  const timeout = section.getByLabel('Stop it after (minutes)')
  const save = section.getByRole('button', { name: 'Save', exact: true })

  await expect(command).toHaveValue('')
  await expect(timeout).toHaveValue('240')
  await expect(section).toContainText('Resuming is off.')
  await expect(save).toBeDisabled()

  const presets = section.getByRole('group', { name: 'Presets' })
  for (const name of ['Claude Code', 'Codex', 'OpenCode'])
    await expect(presets.getByRole('button', { name })).toBeVisible()
  await presets.getByRole('button', { name: /^Codex/ }).click()
  await expect(command).toHaveValue('codex exec')
  await presets.getByRole('button', { name: /^Claude Code/ }).click()
  await expect(command).toHaveValue('claude -p')
  await expect(section).toContainText('Unsaved changes.')

  await command.fill('my-agent --resume')
  await timeout.fill('15')
  await save.click()
  await expect(section).toContainText('No changes.')
  expect(
    await ok<{ resumeCommand: string; resumeTimeoutMinutes: number }>(
      page.request.get(`/api/projects/${project.id}`),
    ),
  ).toMatchObject({
    resumeCommand: 'my-agent --resume',
    resumeTimeoutMinutes: 15,
  })

  await page.reload()
  await expect(command).toHaveValue('my-agent --resume')
  await expect(timeout).toHaveValue('15')

  // A timeout out of range cannot be saved.
  await timeout.fill('0')
  await expect(save).toBeDisabled()
})

test("the human's answer runs the resume command once, and the ticket's Resume card shows the run", async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const dir = tempDir()
  const rec = recorder(dir)
  await ok(human.patch(`/api/projects/${project.id}`, { data: { resumeCommand: rec.command } }))
  const t = await askedTicket(api, human, agent)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await decide(page)

  const card = resumeCard(page)
  await expect(card).toContainText('Finished')
  await expect(card.getByText('node', { exact: true })).toBeVisible()
  await expect(card.getByLabel('Log')).toContainText('resume recorded')
  await expect(card.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled()

  const runs = rec.runs()
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ ticket: String(t.id), project: String(project.id), agent: AGENT })
  expect(runs[0]!.input).toContain('Where should uploads live?')
  expect(runs[0]!.input).toContain('MinIO')
  expect(runs[0]!.fileText).toBe(runs[0]!.input)

  // The reply under the card says the board continued the work.
  const post = (await api.getTicket(t.id)).updates.find((u) => u.decision)!
  const replies = await ok<{ author: string; body: string }[]>(
    human.get(`/api/comments?parentType=update&parentId=${post.id}`),
  )
  expect(replies.filter((r) => r.author === 'board')).toEqual([
    expect.objectContaining({
      author: 'board',
      body: expect.stringMatching(/^Continuing: the board started node/),
    }),
  ])
  await page.reload()
  await expect(resumeCard(page)).toContainText('Finished')
  expect(rec.runs()).toHaveLength(1)
})

test('a resume that fails shows Failed on the ticket, with Retry starting a new run', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const dir = tempDir()
  await ok(
    human.patch(`/api/projects/${project.id}`, {
      data: { resumeCommand: `"${process.execPath}" -e "console.log('about to fail');process.exit(1)"` },
    }),
  )
  const t = await askedTicket(api, human, agent)

  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await decide(page)

  const card = resumeCard(page)
  await expect(card).toContainText('Failed')
  await expect(card.getByLabel('Log')).toContainText('about to fail')
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('blocked')
  const retry = card.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()

  // Retry runs the command again (it fails again here): a new row, and the one before it is kept.
  const before = await ok<{ current: { id: number } }>(human.get(`/api/tickets/${t.id}/resume`))
  await retry.click()
  await expect
    .poll(
      async () =>
        (await ok<{ current: { id: number } }>(human.get(`/api/tickets/${t.id}/resume`))).current.id,
    )
    .toBeGreaterThan(before.current.id)
  await expect(card).toContainText('Failed')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a command that is not on the machine fails the resume without a crash', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  await ok(
    human.patch(`/api/projects/${project.id}`, { data: { resumeCommand: 'no-such-agent-binary-e2e' } }),
  )
  const t = await askedTicket(api, human, agent)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  await decide(page)
  await expect(resumeCard(page)).toContainText('Failed')
  await expect(resumeCard(page).getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect.poll(async () => (await api.getTicket(t.id)).status).toBe('blocked')
})

test('with no resume command, the ticket says resuming is off and runs nothing', async ({
  page,
  api,
  human,
  agent,
  project,
}) => {
  const t = await askedTicket(api, human, agent)
  await page.goto(`/projects/${project.id}/features/${t.id}`)
  // Nothing was ever tried and resuming is off: no Resume card yet.
  await expect(page.getByRole('group', { name: 'Decision' })).toBeVisible()
  await expect(resumeCard(page)).toHaveCount(0)

  await decide(page)
  const card = resumeCard(page)
  await expect(card).toContainText('Not started')
  await expect(card).toContainText('resuming is off')
  await expect(card.getByRole('button')).toHaveCount(0)
  expect((await api.getTicket(t.id)).status).toBe('in_progress')
  // Silent: the board adds no words under the card.
  await expect(page.getByText(/The board did not resume the work/)).toHaveCount(0)
})
