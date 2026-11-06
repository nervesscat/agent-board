import type { Project, TicketFull } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/**
 * Where work starts: the project's Stages settings choose the active stage claiming a ticket puts it in,
 * the first active stage until then.
 */
test('the human chooses the stage work starts in, and claims land there', async ({
  page,
  project,
  human,
  agent,
}) => {
  // An active "Bug Found" stage before In progress.
  const bug = await ok<{ id: number }>(
    human.post(`/api/projects/${project.id}/stages`, { data: { name: 'Bug Found', kind: 'active' } }),
  )
  const stages = await ok<{ id: number; key: string }[]>(human.get(`/api/projects/${project.id}/stages`))
  const ids = stages.map((s) => s.id).filter((id) => id !== bug.id)
  ids.splice(ids.indexOf(stages.find((s) => s.key === 'in_progress')!.id), 0, bug.id)
  await ok(human.put(`/api/projects/${project.id}/stages/order`, { data: { ids } }))
  const claim = async (title: string) => {
    const t = await ok<TicketFull>(
      human.post(`/api/projects/${project.id}/tickets`, { data: { title, defaultPhases: false } }),
    )
    return (await ok<TicketFull>(agent.post(`/api/tickets/${t.id}/claim`, { data: { branch: 'fix' } })))
      .status
  }
  const saved = async () => (await ok<Project>(human.get(`/api/projects/${project.id}`))).workStage

  // Until the human chooses, the first active stage, as before.
  expect(await claim('before')).toBe('bug_found')
  await page.goto(`/projects/${project.id}/settings`)
  const section = page.getByRole('region', { name: 'Stages' })
  const select = section.getByRole('combobox', { name: 'Work starts in' })
  await expect(select).toContainText('First active stage (Bug Found)')

  await select.click()
  // Only the active stages are offered.
  await expect(page.getByRole('option')).toHaveText([
    'First active stage (Bug Found)',
    'Bug Found',
    'In progress',
  ])
  await page.getByRole('option', { name: 'In progress' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await expect.poll(saved).toBe('in_progress')
  await page.reload()
  await expect(select).toContainText('In progress')
  await section.screenshot({ path: test.info().outputPath('work-stage-setting.png') })
  expect(await claim('after')).toBe('in_progress')

  // An agent cannot change it.
  expect(
    (await agent.patch(`/api/projects/${project.id}`, { data: { workStage: 'bug_found' } })).status(),
  ).toBe(403)

  // Back to the default.
  await select.click()
  await page.getByRole('option', { name: 'First active stage (Bug Found)' }).click()
  await expect.poll(saved).toBeNull()
  expect(await claim('default again')).toBe('bug_found')
})
