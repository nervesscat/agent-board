import type { TicketFull, WorkflowEffective, WorkflowOverview } from '#/lib/api'
import { expect, ok, test } from './fixtures'

/**
 * The tag map that picks a ticket's workflow: an agent sets it, the Workflow page shows it read-only, a ticket
 * with one of its tags and no workflow of its own follows the workflow the tag names, and the create dialog's
 * Workflow picker offers the workflows a ticket can pick, not Content.
 */

test('the create dialog offers the pickable workflows and not Content (A15)', async ({ page, project }) => {
  await page.goto(`/projects/${project.id}/features`)
  await page.getByRole('button', { name: 'New ticket' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Workflow' }).click()
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    "Project's workflow (Standard)",
    'Light',
    'Standard',
    'Thorough',
    'Maximum',
  ])
})

test('an agent maps tags to workflows, the Workflow page shows the map, and a tagged ticket follows its tag (A16, A17)', async ({
  page,
  project,
  human,
  agent,
  api,
}) => {
  await page.goto(`/projects/${project.id}/workflow`)
  await expect(page.locator('[data-graph]')).toBeVisible()
  await expect(page.locator('[data-tag-map-empty]')).toContainText('set this map through set_workflow_tags')

  // The agent sets two tags (a patch); the page shows them, and Content is one of its preset cards.
  const set = await agent.put(`/api/projects/${project.id}/workflow-tags`, {
    data: { tags: { Brand: 'content', Design: 'light' } },
  })
  expect(set.status()).toBe(200)
  await page.reload()
  await expect(page.locator('[data-tag-row="Brand"]')).toContainText('Content')
  await expect(page.locator('[data-tag-row="Design"]')).toContainText('Light')
  await expect(
    page.getByRole('group', { name: 'Workflow presets' }).locator('[data-preset="content"]'),
  ).toBeVisible()

  // A ticket with the tag (in any casing) and no workflow of its own follows the tag's workflow.
  const tagged = await api.ticket({ title: 'Launch caption', tags: ['Implementation', 'brand'] })
  const effective = await ok<WorkflowEffective>(
    human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${tagged.id}`),
  )
  expect([effective.preset, effective.source, effective.tag]).toEqual(['content', 'tag', 'brand'])
  expect(effective.text).toContain("matched tag `brand`; the project's workflow is Standard")

  // A ticket with no tag the map names follows the project's workflow, and its own pick still wins.
  const plain = await api.ticket({ title: 'Plain work', tags: ['Implementation'] })
  const owned = await ok<TicketFull>(
    human.post(`/api/projects/${project.id}/tickets`, {
      data: { title: 'Owned', tags: ['Brand'], workflowPreset: 'thorough' },
    }),
  )
  const read = (id: number) =>
    ok<WorkflowEffective>(human.get(`/api/projects/${project.id}/workflow/effective?ticketId=${id}`))
  expect([(await read(plain.id)).source, (await read(plain.id)).preset]).toEqual(['project', 'standard'])
  expect([(await read(owned.id)).source, (await read(owned.id)).preset]).toEqual(['own', 'thorough'])

  // The map is read back on the project and in the overview the page reads.
  const overview = await ok<WorkflowOverview>(human.get(`/api/projects/${project.id}/workflow`))
  expect(overview.tags).toEqual({ Brand: 'content', Design: 'light' })
})
