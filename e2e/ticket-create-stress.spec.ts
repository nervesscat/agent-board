import type { Project, TicketFull, TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/**
 * The suite seeds by creating tickets from several Playwright workers at once, and a create that lost
 * SQLite's write lock to another writer used to answer a 500 and take the whole spec down in its
 * setup. A burst of creates has to land as if it were one: every one answered, every ticket once,
 * each with the project's default phases.
 */

const COUNT = 50
const BUILT_IN = ['Implementation', 'Pushed', 'PR', 'CI', 'Preview', 'Summary', 'Merged']

test('50 tickets created at once all land, once each, with the default phases', async ({
  human,
  project,
}) => {
  const titles = Array.from({ length: COUNT }, (_, i) => `Created at once ${i + 1}`)
  const answers = await Promise.all(
    titles.map((title) => human.post(`/api/projects/${project.id}/tickets`, { data: { title } })),
  )
  const failed: string[] = []
  for (const [i, r] of answers.entries()) {
    if (r.status() === 201) continue
    failed.push(`${titles[i]}: ${r.url()} answered ${r.status()}: ${await r.text()}`)
  }
  expect(failed, failed.join('\n')).toEqual([])

  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets`))
  expect(rows).toHaveLength(COUNT)
  expect(rows.map((t) => t.title).sort()).toEqual([...titles].sort())

  const phases = (await ok<Project>(human.get(`/api/projects/${project.id}`))).defaultPhases
  expect(phases).toEqual(BUILT_IN)
  for (const row of rows) {
    const ticket = await ok<TicketFull>(human.get(`/api/tickets/${row.id}`))
    // The project's phases, in order, each a top-level task: nothing missing, nothing written twice.
    expect(
      ticket.tasks.map((task) => task.text),
      ticket.title,
    ).toEqual(phases)
    expect(
      ticket.tasks.every((task) => task.parentId === null),
      ticket.title,
    ).toBe(true)
  }
})
