import { expect, test } from './fixtures'

const step = (page: import('@playwright/test').Page) => page.getByRole('link', { name: /^(Next|Previous) / })

test('stepping to a ticket that loads slowly shows a skeleton, not the previous ticket', async ({
  page,
  api,
  project,
}) => {
  const first = await api.ticket({ title: 'Alpha loading ticket' })
  const second = await api.ticket({ title: 'Bravo loading ticket' })

  await page.goto(`/projects/${project.id}/features/${first.id}`)
  await expect(page.getByRole('heading', { name: /Alpha loading ticket/ })).toBeVisible()
  await expect(step(page)).toBeVisible()

  await page.route(`**/api/tickets/${second.id}`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await step(page).click()

  await expect(page).toHaveURL(new RegExp(`/features/${second.id}$`))
  await expect(page.getByRole('status', { name: 'Loading ticket…' })).toBeVisible()
  await expect(page.getByText('Alpha loading ticket')).toHaveCount(0)

  await expect(page.getByRole('heading', { name: /Bravo loading ticket/ })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Loading ticket…' })).toHaveCount(0)
})

test('a fast load never shows the skeleton', async ({ page, api, project }) => {
  const first = await api.ticket({ title: 'Alpha loading ticket' })
  const second = await api.ticket({ title: 'Bravo loading ticket' })

  await page.goto(`/projects/${project.id}/features/${first.id}`)
  await expect(page.getByRole('heading', { name: /Alpha loading ticket/ })).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { sawLoading: string[] }
    w.sawLoading = []
    new MutationObserver(() => {
      for (const e of document.querySelectorAll('[role=status][aria-label="Loading ticket…"]'))
        w.sawLoading.push(e.getAttribute('aria-label') ?? '')
    }).observe(document.body, { childList: true, subtree: true })
  })
  await step(page).click()

  await expect(page).toHaveURL(new RegExp(`/features/${second.id}$`))
  await expect(page.getByRole('heading', { name: /Bravo loading ticket/ })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { sawLoading: string[] }).sawLoading)).toEqual([])
})
