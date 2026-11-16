import { expect, test } from './fixtures'

test('the stage buttons sit in the header row and step the board one stage', async ({
  page,
  api,
  project,
}) => {
  await api.ticket({ title: 'Stage scroll ticket', status: 'todo' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.locator('[data-column]').first()).toBeVisible()

  // The subtitle is gone; the heading stays.
  await expect(page.getByText('Tickets in flight, by stage.')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Ongoing features' })).toBeVisible()

  // The buttons share the row of the view tabs and sit before New ticket.
  const next = page.getByRole('button', { name: 'Next stage' })
  const prev = page.getByRole('button', { name: 'Previous stage' })
  await expect(next).toBeVisible()
  const boardTab = await page.getByRole('tab', { name: 'Board' }).boundingBox()
  const nextBox = await next.boundingBox()
  const newTicket = await page
    .getByRole('button', { name: /New ticket/ })
    .first()
    .boundingBox()
  expect(boardTab && nextBox && newTicket).toBeTruthy()
  if (!boardTab || !nextBox || !newTicket) return
  expect(Math.abs(nextBox.y - boardTab.y)).toBeLessThan(boardTab.height)
  expect(nextBox.x).toBeLessThan(newTicket.x)

  // Previous is off at the first stage; Next steps the board right, then Previous steps back.
  const scroller = page.locator('[data-column="done"]').locator('xpath=..')
  await expect(prev).toBeDisabled()
  await expect(next).toBeEnabled()
  await next.click()
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await expect(prev).toBeEnabled()
  await prev.click()
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(0)
  await expect(prev).toBeDisabled()
})
