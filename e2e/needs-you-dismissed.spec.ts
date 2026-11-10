import type { Locator, Page } from '@playwright/test'

import { HUMAN } from './env'
import { expect, section, test } from './fixtures'

/**
 * An entry of Needs you is a thing the human has not seen yet: clicking it opens what it points at and
 * files it away, so the card stops asking. This browser remembers it per entry for the actor signed in,
 * across reloads and pages, and an entry whose fact changes (or a new one) still shows.
 */

const needsYou = (page: Page) => section(page, 'Needs you')
const entry = (scope: Page | Locator, t: { id: number; title: string }) =>
  scope.getByRole('link', { name: `#${t.id} ${t.title}` })
const count = (page: Page) => needsYou(page).locator('[data-slot="card-title"]')

test('clicking a Needs you entry opens it and it stops asking; a new one still shows', async ({
  page,
  project,
  api,
}) => {
  const read = await api.ticket({ title: 'Was looked at', status: 'review' })
  const waiting = await api.ticket({ title: 'Still waiting', status: 'review' })

  await page.goto(`/projects/${project.id}`)
  await expect(count(page)).toContainText('2')
  await expect(entry(needsYou(page), read)).toBeVisible()

  // Clicking it opens the ticket ...
  await entry(needsYou(page), read).click()
  await expect(page).toHaveURL(new RegExp(`/features/${read.id}(\\?|#|$)`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(read.title)

  // ... and back on the Overview only the one not opened still asks.
  await page.goBack()
  await expect(entry(needsYou(page), read)).toHaveCount(0)
  await expect(entry(needsYou(page), waiting)).toBeVisible()
  await expect(count(page)).toContainText('1')

  // Home counts what its Overview shows, and the filing away survives a reload.
  await page.goto('/')
  const block = page.getByRole('heading', { level: 2, name: project.name, exact: true })
  await expect(block.locator('xpath=ancestor::section[1]')).toContainText('1 waiting on you')
  await page.goto(`/projects/${project.id}`)
  await page.reload()
  await expect(entry(needsYou(page), read)).toHaveCount(0)
  await expect(entry(needsYou(page), waiting)).toBeVisible()

  // A new entry still shows: only what was clicked is filed away, and it stays away.
  const fresh = await api.ticket({ title: 'A new ask', status: 'review' })
  await page.reload()
  await expect(entry(needsYou(page), fresh)).toBeVisible()
  await expect(entry(needsYou(page), read)).toHaveCount(0)
  await expect(count(page)).toContainText('2')

  // It is this browser's, for this actor: kept under the actor's own key, never the other's.
  const keys = await page.evaluate(() => Object.keys(localStorage))
  expect(keys).toContain(`needs-you-dismissed:${HUMAN}`)
})
