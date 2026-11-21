import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

// Each test is its own person on the board (the test-mode actor), so the language one of them picks is
// never another test's: the language is kept per person.
let person = 0
let actor = ''
test.beforeEach(async ({ context }) => {
  person += 1
  actor = `human:lengua-${process.pid}-${person}`
  await context.setExtraHTTPHeaders({ 'x-test-actor': actor })
})

const picker = (page: Page, name: string) => page.getByRole('tablist', { name })
const html = (page: Page) => page.locator('html')

test('Settings has a Language selector with English and Spanish, and the whole page follows at once', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  // The Board tab's section, next to the theme.
  const language = picker(page, 'Language')
  await expect(language.getByRole('tab')).toHaveText(['English', 'Español'])
  await expect(language.getByRole('tab', { name: 'English' })).toHaveAttribute('aria-selected', 'true')

  // No reload: a mark on the window must survive the switch.
  await page.evaluate(() => Object.assign(window, { stillHere: true }))
  await language.getByRole('tab', { name: 'Español' }).click()
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tema' })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Tema' }).getByRole('tab')).toHaveText([
    'Sistema',
    'Claro',
    'Oscuro',
  ])
  // The top bar too.
  const bar = page.getByRole('banner')
  await expect(bar.getByRole('link', { name: 'Conectar', exact: true })).toBeVisible()
  await expect(bar.getByRole('link', { name: 'Ajustes', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true)

  // And back.
  await picker(page, 'Idioma').getByRole('tab', { name: 'English' }).click()
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('the choice is kept on the board for the person: a reload, and another device, show it', async ({
  page,
  browser,
}) => {
  await page.goto('/settings')
  await picker(page, 'Language').getByRole('tab', { name: 'Español' }).click()
  await expect(html(page)).toHaveAttribute('lang', 'es')
  const me = () => page.request.get('/api/me').then((r) => r.json())
  await expect.poll(async () => (await me()).language).toBe('es')

  await page.reload()
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible()

  // Another device: no cookie, no storage, a browser in English. The board says Spanish once it answers.
  const other = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'x-test-actor': actor },
  })
  try {
    const phone = await other.newPage()
    await phone.goto('/settings')
    await expect(html(phone)).toHaveAttribute('lang', 'es')
    await expect(phone.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible()
  } finally {
    await other.close()
  }
})

test.describe('before a choice is made, the browser decides between the supported languages', () => {
  test.describe('a browser in Spanish', () => {
    test.use({ locale: 'es-MX' })
    test('draws the page in Spanish from the first byte, and the selector shows it', async ({ page }) => {
      const first = await page.request.get('/settings', { headers: { 'accept-language': 'es-MX,es;q=0.9' } })
      expect(await first.text()).toContain('<html lang="es"')
      await page.goto('/settings')
      await expect(html(page)).toHaveAttribute('lang', 'es')
      await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible()
      await expect(picker(page, 'Idioma').getByRole('tab', { name: 'Español' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })
  })

  test.describe('a browser in a language the board has no translation for', () => {
    test.use({ locale: 'fr-FR' })
    test('is shown English', async ({ page }) => {
      await page.goto('/settings')
      await expect(html(page)).toHaveAttribute('lang', 'en')
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    })
  })
})

test('what people write is not translated: a ticket keeps the title it was given', async ({
  page,
  project,
  human,
}) => {
  const title = 'Shows the Settings page in English text'
  await human.post(`/api/projects/${project.id}/tickets`, { data: { title } })
  await page.goto('/settings')
  await picker(page, 'Language').getByRole('tab', { name: 'Español' }).click()
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByText(title).first()).toBeVisible()
})
