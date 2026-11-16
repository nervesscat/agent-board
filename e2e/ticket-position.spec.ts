import type { TicketRow } from '#/lib/api'
import { expect, ok, test } from './fixtures'

// Instructions long enough that the ticket page is taller than the window.
const LONG = Array.from(
  { length: 60 },
  (_, i) => `Paragraph ${i + 1} of the instructions, long enough to take a line of its own.`,
).join('\n\n')

test('a ticket left by a step is where the reader left it when they step back', async ({
  page,
  api,
  human,
  project,
}) => {
  await api.ticket({ title: 'First long one', status: 'in_progress', body: LONG })
  await api.ticket({ title: 'Second long one', status: 'in_progress', body: LONG })
  const rows = await ok<TicketRow[]>(human.get(`/api/projects/${project.id}/tickets?parent=root`))
  const first = rows.find((r) => r.title === 'First long one')!
  const second = rows.find((r) => r.title === 'Second long one')!
  const url = (id: number) => new RegExp(`/projects/${project.id}/features/${id}$`)
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY))
  const tab = () =>
    page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim())

  await page.goto(`/projects/${project.id}/features/${first.id}`)
  await expect(page.getByRole('heading', { name: 'First long one' })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 900))
  await expect.poll(scrollY).toBeGreaterThan(800)
  const left = await scrollY()
  const leftTab = await tab()

  // Two tickets in a column: each one's only step goes to the other.
  await page.getByRole('link', { name: /^(Next|Previous) ticket in/ }).click()
  await expect(page).toHaveURL(url(second.id))
  await expect(page.getByRole('heading', { name: 'Second long one' })).toBeVisible()

  await page.getByRole('link', { name: /^(Next|Previous) ticket in/ }).click()
  await expect(page).toHaveURL(url(first.id))
  await expect(page.getByRole('heading', { name: 'First long one' })).toBeVisible()
  await expect.poll(scrollY).toBe(left)
  await expect.poll(tab).toBe(leftTab)
})
