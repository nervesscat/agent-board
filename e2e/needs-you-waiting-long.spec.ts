import type { Project } from '#/lib/api'
import type { Page } from '@playwright/test'

import { expect, ok, section, test } from './fixtures'
import { age } from './workTimeline'

/**
 * Work that has waited too long is listed in Needs you again: a ticket in a review stage, or in To do, longer
 * than the project's setting (3 days by default, only the human sets it), with how long it has waited and its
 * last summary line. Clicking it files it away, as the other entries are.
 */

const DAY_MINUTES = 1440
const needsYou = (page: Page) => section(page, 'Needs you')
/** The waiting-long row of a ticket: its link goes to the ticket's tasks (a thread on it links to a post). */
const entry = (page: Page, t: { id: number; title: string }) =>
  needsYou(page)
    .getByRole('link', { name: `#${t.id} ${t.title}` })
    .and(page.locator('a[href$="#tasks"]'))
const count = (page: Page) => needsYou(page).locator('[data-slot="card-title"]')
const settings = (page: Page) => page.getByRole('region', { name: 'Waiting too long' })

test('a new project waits 3 days, and only the human can set how long', async ({ project, human, agent }) => {
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).waitingLongDays).toBe(3)

  await ok(human.patch(`/api/projects/${project.id}`, { data: { waitingLongDays: 2 } }))
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).waitingLongDays).toBe(2)
  // An agent cannot change it, and out of range is refused for the human too: the value stays 2.
  const refused = await agent.patch(`/api/projects/${project.id}`, { data: { waitingLongDays: 5 } })
  expect(refused.status()).toBe(403)
  expect((await human.patch(`/api/projects/${project.id}`, { data: { waitingLongDays: 0 } })).status()).toBe(
    400,
  )
  expect(
    (await human.patch(`/api/projects/${project.id}`, { data: { waitingLongDays: 366 } })).status(),
  ).toBe(400)
  expect((await ok<Project>(human.get(`/api/projects/${project.id}`))).waitingLongDays).toBe(2)
})

test('a review ticket waiting 4 days is listed in Needs you with its link, its wait and its summary line', async ({
  page,
  project,
  api,
  agent,
}) => {
  const waited = await api.ticket({ title: 'Importer retry', status: 'review' })
  await ok(
    agent.put(`/api/tickets/${waited.id}/summary`, {
      data: { body: 'Fix the importer retry\n\nWhat changed, and how to try it.' },
    }),
  )
  age(waited.id, 4 * DAY_MINUTES + 5)

  await page.goto(`/projects/${project.id}`)
  const row = entry(page, waited)
  await expect(row).toBeVisible()
  await expect(needsYou(page)).toContainText('waiting 4 days')
  await expect(needsYou(page)).toContainText('Fix the importer retry')
  // The summary the agent wrote is also a post the human has not answered: a thread, the second entry.
  await expect(count(page)).toContainText('2')
  await expect(row).toHaveAttribute('href', new RegExp(`/features/${waited.id}`))
})

test('the human sets the days on the settings page, and the Overview lists work past them', async ({
  page,
  project,
  api,
  agent,
}) => {
  // Waiting 2.5 days: under the default 3, so it is only in the review list, not waiting long.
  const review = await api.ticket({ title: 'Two and a half days', status: 'review' })
  age(review.id, 2 * DAY_MINUTES + 720)
  await page.goto(`/projects/${project.id}`)
  await expect(entry(page, review)).toBeVisible()
  await expect(needsYou(page)).not.toContainText('waiting 2 days')

  await page.goto(`/projects/${project.id}/settings`)
  const days = settings(page).getByLabel('Listed after (days)')
  await expect(days).toHaveValue('3')
  await days.fill('2')
  await settings(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await expect(settings(page).getByLabel('Listed after (days)')).toHaveValue('2')
  expect((await ok<Project>(agent.get(`/api/projects/${project.id}`))).waitingLongDays).toBe(2)

  await page.goto(`/projects/${project.id}`)
  await expect(needsYou(page)).toContainText('waiting 2 days')
  await expect(entry(page, review)).toBeVisible()
})

test('clicking a waiting entry files it away, and it shows again once it has waited in a new stage', async ({
  page,
  project,
  api,
  human,
}) => {
  const waited = await api.ticket({ title: 'Filed away when opened', status: 'review' })
  age(waited.id, 4 * DAY_MINUTES + 5)
  const other = await api.ticket({ title: 'Still waiting', status: 'review' })
  age(other.id, 4 * DAY_MINUTES + 5)

  await page.goto(`/projects/${project.id}`)
  await expect(entry(page, waited)).toBeVisible()
  await expect(count(page)).toContainText('2')

  await entry(page, waited).click()
  await expect(page).toHaveURL(new RegExp(`/features/${waited.id}(\\?|#|$)`))
  await page.goBack()
  await expect(entry(page, waited)).toHaveCount(0)
  await expect(entry(page, other)).toBeVisible()
  await page.reload()
  await expect(entry(page, waited)).toHaveCount(0)
  await expect(entry(page, other)).toBeVisible()

  // Back into review after a move out: a new stage entry, which waits 4 days again, shows again.
  await ok(human.patch(`/api/tickets/${waited.id}`, { data: { status: 'in_progress' } }))
  await ok(human.patch(`/api/tickets/${waited.id}`, { data: { status: 'review' } }))
  age(waited.id, 4 * DAY_MINUTES + 5)
  await page.reload()
  await expect(entry(page, waited)).toBeVisible()
})
