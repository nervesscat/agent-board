import fs from 'node:fs'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { LANGUAGES, LANGUAGE_NAME, type Language } from '../src/i18n/languages'
import { expect, ok, test } from './fixtures'

/** A language's own file: what its pages must say, whatever the words are. */
const textsOf = (language: Language) =>
  JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../src/i18n/locales', `${language}.json`), 'utf8'),
  ) as { settings: { title: string; board: { language: { title: string; search: string } } } }

// Each test is its own person on the board (the test-mode actor), so the language one of them picks is
// never another test's: the language is kept per person.
let person = 0
let actor = ''
test.beforeEach(async ({ context }) => {
  person += 1
  actor = `human:lengua-${process.pid}-${person}`
  await context.setExtraHTTPHeaders({ 'x-test-actor': actor })
})

const picker = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true })
/** Opens the language dropdown (named `name` in the language shown) and picks `option`, in its own words. */
async function choose(page: Page, name: string, option: string) {
  await picker(page, name).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
const html = (page: Page) => page.locator('html')

test('Settings has a Language selector with English and Spanish among its twenty, and the whole page follows at once', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  // The Board tab's section, next to the theme.
  await expect(picker(page, 'Language')).toContainText('English')

  // No reload: a mark on the window must survive the switch.
  await page.evaluate(() => Object.assign(window, { stillHere: true }))
  await choose(page, 'Language', 'Español')
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible()
  // The confirmation is in the language just picked, not the one just left.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Guardado' })).toBeVisible()
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
  await choose(page, 'Idioma', 'English')
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('the choice is kept on the board for the person: a reload, and another device, show it', async ({
  page,
  browser,
}) => {
  await page.goto('/settings')
  await choose(page, 'Language', 'Español')
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
      await expect(picker(page, 'Idioma')).toContainText('Español')
    })
  })

  test.describe('a browser in a language the board has no translation for', () => {
    test.use({ locale: 'ar-EG' })
    test('is shown English', async ({ page }) => {
      await page.goto('/settings')
      await expect(html(page)).toHaveAttribute('lang', 'en')
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    })
  })
})

test('the Daily page in Spanish draws without a hydration error, with a calendar in Spanish', async ({
  page,
  project,
  human,
}) => {
  // The report calendar is there once the project has a cadence.
  await ok(human.patch(`/api/projects/${project.id}/report-settings`, { data: { cadence: 'daily' } }))
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/settings')
  await choose(page, 'Language', 'Español')
  await expect(html(page)).toHaveAttribute('lang', 'es')
  // A fresh load: the server draws the page in Spanish, the browser hydrates it.
  await page.goto(`/projects/${project.id}/daily`)
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('heading', { level: 1, name: 'Diario' })).toBeVisible()
  // The calendar: the month's name and the weekdays are Spanish, the labels read out too.
  const month = new Date().toLocaleDateString('es', { month: 'long' })
  await expect(page.getByRole('region', { name: 'Calendario de informes' })).toBeVisible()
  await expect(page.getByText(new RegExp(month, 'i')).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Ir al mes anterior|mes anterior/i }).first()).toBeVisible()
  expect(errors.filter((e) => /#418|Hydration/i.test(e))).toEqual([])
})

test('what people write is not translated: a ticket keeps the title it was given', async ({
  page,
  project,
  human,
}) => {
  const title = 'Shows the Settings page in English text'
  await human.post(`/api/projects/${project.id}/tickets`, { data: { title } })
  await page.goto('/settings')
  await choose(page, 'Language', 'Español')
  await expect(html(page)).toHaveAttribute('lang', 'es')
  await page.goto(`/projects/${project.id}/features`)
  await expect(page.getByText(title).first()).toBeVisible()
})

test('the dropdown lists the twenty languages in their own words, and a search finds one by either name', async ({
  page,
}) => {
  await page.goto('/settings')
  await picker(page, 'Language').click()
  await expect(page.getByRole('option')).toHaveText(LANGUAGES.map((l) => LANGUAGE_NAME[l]))
  await expect(page.getByRole('option')).toHaveCount(20)
  const search = page.getByRole('combobox', { name: 'Search languages', exact: true })
  await search.fill('german')
  await expect(page.getByRole('option')).toHaveText(['Deutsch'])
  await search.fill('日本')
  await expect(page.getByRole('option')).toHaveText(['日本語'])
  await search.fill('zzz')
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByText('No language matches')).toBeVisible()
  await page.keyboard.press('Escape')
  // Closed, the search is gone: the full list is back.
  await picker(page, 'Language').click()
  await expect(page.getByRole('option')).toHaveCount(20)
})

test('every one of the twenty works when picked: the page, the selector and <html lang> follow', async ({
  page,
}) => {
  test.slow()
  await page.goto('/settings')
  let name = 'Language'
  for (const language of LANGUAGES.filter((l) => l !== 'en')) {
    await choose(page, name, LANGUAGE_NAME[language])
    const texts = textsOf(language)
    await expect(html(page)).toHaveAttribute('lang', language)
    await expect(page.getByRole('heading', { level: 1, name: texts.settings.title })).toBeVisible()
    name = texts.settings.board.language.title
    await expect(picker(page, name)).toContainText(LANGUAGE_NAME[language])
  }
  await choose(page, name, 'English')
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test.describe('before a choice is made, the browser picks any of the twenty', () => {
  for (const [locale, language] of [
    ['pt-BR', 'pt'],
    ['ja-JP', 'ja'],
    ['zh-TW', 'zh'],
    ['uk-UA', 'uk'],
    ['ta-IN', 'ta'],
  ] as const) {
    test.describe(`a browser in ${locale}`, () => {
      test.use({ locale })
      test(`draws the page in ${language}`, async ({ page }) => {
        await page.goto('/settings')
        await expect(html(page)).toHaveAttribute('lang', language)
        const texts = textsOf(language)
        await expect(page.getByRole('heading', { level: 1, name: texts.settings.title })).toBeVisible()
        await expect(picker(page, texts.settings.board.language.title)).toContainText(LANGUAGE_NAME[language])
      })
    })
  }
})

test('two quick picks: the last one wins, even the language that was showing', async ({ page }) => {
  await page.goto('/settings')
  // The Russian file arrives late; English is picked again before it does.
  await page.route('**/assets/ru-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await route.continue()
  })
  await choose(page, 'Language', 'Русский')
  await choose(page, 'Language', 'English')
  await expect(html(page)).toHaveAttribute('lang', 'en')
  // Long after the Russian file has come in, the page is still English and English is what is kept.
  await page.waitForTimeout(3500)
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  const me = await page.request.get('/api/me').then((r) => r.json())
  expect(me.language).toBe('en')
})

test('a language whose file cannot be fetched changes nothing, and says so', async ({ page }) => {
  await page.goto('/settings')
  await page.route('**/assets/de-*.js', (route) => route.abort())
  await choose(page, 'Language', 'Deutsch')
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Could not load that language' }),
  ).toBeVisible()
  // The page, the dropdown, <html lang> and what is kept on the board all stay as they were.
  await expect(html(page)).toHaveAttribute('lang', 'en')
  await expect(picker(page, 'Language')).toContainText('English')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  const me = await page.request.get('/api/me').then((r) => r.json())
  expect(me.language).not.toBe('de')
  // Back on line, after a reload (a browser keeps a failed module's failure until then), the same pick works.
  await page.unroute('**/assets/de-*.js')
  await page.reload()
  await choose(page, 'Language', 'Deutsch')
  await expect(html(page)).toHaveAttribute('lang', 'de')
})

test.describe('long translations keep the phone layout', () => {
  for (const [locale, language] of [
    ['ru-RU', 'ru'],
    ['pt-BR', 'pt'],
    ['pl-PL', 'pl'],
    ['ta-IN', 'ta'],
  ] as const) {
    test.describe(`a phone in ${language}`, () => {
      test.use({ locale, viewport: { width: 390, height: 800 } })
      test("the Roadmap's filter tabs do not widen the page", async ({ page, project }) => {
        await page.goto(`/projects/${project.id}/roadmap`)
        await expect(html(page)).toHaveAttribute('lang', language)
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          )
          .toBeLessThanOrEqual(0)
      })
    })
  }
})
