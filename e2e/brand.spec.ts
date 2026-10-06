import fs from 'node:fs'

import type { Locator, Page } from '@playwright/test'

import { expect, seededProject, test } from './fixtures'

/** The top bar's home link: the CrossBoard mark and wordmark. */
const homeLink = (page: Page) =>
  page.getByRole('banner').getByRole('link', { name: 'CrossBoard', exact: true })

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b, 'element has a box').not.toBeNull()
  return b!
}

/** A CSS colour as the sRGB pixel it paints, whatever notation the browser computes it in. */
const rgb = (page: Page, color: string) =>
  page.evaluate((c) => {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.fillStyle = c
    ctx.fillRect(0, 0, 1, 1)
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, color)

const near = (actual: number[], expected: number[], label: string) =>
  actual.forEach((v, i) =>
    expect(Math.abs(v - expected[i]), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(3),
  )

test('the tab is titled CrossBoard on every page', async ({ page, api, project }) => {
  const t = await api.ticket({ title: 'A ticket to open', status: 'todo' })
  for (const url of ['/', `/projects/${project.id}`, `/projects/${project.id}/features/${t.id}`]) {
    await page.goto(url)
    await expect(page, url).toHaveTitle('CrossBoard')
  }
})

test('the top bar links home with the CrossBoard lockup', async ({ page }) => {
  await page.goto('/repositories')
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible()
  const home = homeLink(page)
  await expect(home).toHaveCount(1)
  await expect(home).toHaveAttribute('href', '/')
  await expect(home).toHaveAttribute('title', 'Home')
  await expect(page.getByRole('banner')).not.toContainText('Agent Board')
  await home.click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
})

test('the lockup: a 22px mark, 8px from a 17px Bricolage Grotesque wordmark, centred in the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/projects/${seededProject().id}/prs`)
  await expect(page.getByRole('heading', { name: 'PR queue' })).toBeVisible()
  const home = homeLink(page)
  const mark = home.locator('svg')
  const word = home.getByText('CrossBoard', { exact: true })

  await expect(mark).toHaveAttribute('viewBox', '0 0 64 64')
  await expect(mark).toHaveAttribute('aria-hidden', 'true')
  const m = await box(mark)
  expect(m.width).toBeCloseTo(22, 0)
  expect(m.height).toBeCloseTo(22, 0)
  const w = await box(word)
  expect(Math.abs(w.x - (m.x + m.width) - 8)).toBeLessThanOrEqual(1)
  const bar = await box(page.getByRole('banner').locator('nav'))
  expect(bar.height).toBe(48)
  const middle = bar.y + bar.height / 2
  expect(Math.abs(m.y + m.height / 2 - middle)).toBeLessThanOrEqual(1.5)
  expect(Math.abs(w.y + w.height / 2 - middle)).toBeLessThanOrEqual(1.5)

  const font = await word.evaluate(async (el) => {
    await document.fonts.ready
    const s = getComputedStyle(el)
    return {
      family: s.fontFamily,
      weight: s.fontWeight,
      size: parseFloat(s.fontSize),
      spacing: parseFloat(s.letterSpacing),
      loaded: document.fonts.check(`700 ${s.fontSize} "Bricolage Grotesque Variable"`),
    }
  })
  expect(font.family).toMatch(/^"Bricolage Grotesque Variable"/)
  expect(font.weight).toBe('700')
  expect(font.size).toBe(17)
  expect(font.spacing).toBeCloseTo(-0.035 * 17, 2)
  expect(font.loaded).toBe(true)

  // Only the wordmark: the page and its headings stay in Geist.
  for (const el of [page.locator('body'), page.getByRole('heading', { name: 'PR queue' })])
    expect(await el.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"Geist Variable"/)
})

test('the mark draws its sockets in the text colour and its cable in the brand colour, light and dark', async ({
  page,
}) => {
  const themes = {
    light: { ink: [10, 10, 10], brand: [162, 61, 184] },
    dark: { ink: [250, 250, 250], brand: [210, 125, 230] },
  }
  for (const [colorScheme, want] of Object.entries(themes) as [keyof typeof themes, typeof themes.light][]) {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    const home = homeLink(page)
    const colors = await home.evaluate((link) => {
      const svg = link.querySelector('svg')!
      const style = (sel: string) => [...svg.querySelectorAll(sel)].map((e) => getComputedStyle(e))
      return {
        text: getComputedStyle(link).color,
        sockets: style('g circle').map((s) => s.stroke),
        cable: style('path').map((s) => s.stroke),
        plugs: style(':scope > circle').map((s) => s.fill),
      }
    })
    expect(colors.sockets).toHaveLength(6)
    for (const s of colors.sockets) expect(s, colorScheme).toBe(colors.text)
    near(await rgb(page, colors.text), want.ink, `${colorScheme} ink`)
    expect(colors.cable).toHaveLength(1)
    expect(colors.plugs).toHaveLength(2)
    for (const c of [...colors.cable, ...colors.plugs])
      near(await rgb(page, c), want.brand, `${colorScheme} cable`)
  }
})

test('the head links the favicons, and the board serves them as they are', async ({ page, human }) => {
  const html = await (await human.get('/')).text()
  expect(html).toContain('<title>CrossBoard</title>')
  expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg"/)
  expect(html).toMatch(/<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32.png"/)
  expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon.png"/)

  await page.goto('/')
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png')

  for (const [file, type] of [
    ['favicon.svg', 'image/svg+xml'],
    ['apple-touch-icon.png', 'image/png'],
    ['favicon-32.png', 'image/png'],
  ]) {
    // What a browser sends for a favicon, and a plain request.
    for (const headers of [{ 'Sec-Fetch-Dest': 'image' }, {}] as Record<string, string>[]) {
      const res = await page.request.get(`/${file}`, { headers })
      expect(res.status(), file).toBe(200)
      expect(res.headers()['content-type'], file).toContain(type)
      expect(Buffer.compare(await res.body(), fs.readFileSync(`public/${file}`)), file).toBe(0)
    }
  }
})

test('the favicon switches its own colours with the system theme', async ({ page }) => {
  // A page of its own: the fixture's goto waits for React, which an SVG file never loads.
  const svg = await page.context().newPage()
  for (const [colorScheme, ink, cable] of [
    ['light', [10, 10, 10], [162, 61, 184]],
    ['dark', [250, 250, 250], [210, 125, 230]],
  ] as const) {
    await svg.emulateMedia({ colorScheme })
    await svg.goto('/favicon.svg')
    const colors = await svg.evaluate(() => ({
      socket: getComputedStyle(document.querySelector('g circle')!).stroke,
      cable: getComputedStyle(document.querySelector('path')!).stroke,
      plug: getComputedStyle(document.querySelector('svg > circle')!).fill,
    }))
    near(await rgb(page, colors.socket), [...ink], `${colorScheme} socket`)
    near(await rgb(page, colors.cable), [...cable], `${colorScheme} cable`)
    near(await rgb(page, colors.plug), [...cable], `${colorScheme} plug`)
  }
  await svg.close()
})

test('with the test mode badge the top bar fits every width from 640 to 768px without sideways scroll', async ({
  page,
}) => {
  for (const width of [640, 676, 683, 700, 720, 727, 767, 768]) {
    await page.setViewportSize({ width, height: 800 })
    for (const url of ['/repositories', `/projects/${seededProject().id}/prs`]) {
      const at = `${width}px ${url}`
      await page.goto(url)
      await expect(page.getByRole('main').getByRole('heading').first(), at).toBeVisible()
      const bar = page.getByRole('banner')
      await expect(bar.getByText('test mode'), at).toBeVisible()
      // The last page link when the links are inline, the Pages menu when they are folded.
      const settings = bar.getByRole('link', { name: 'Settings' })
      const last = (await settings.isVisible()) ? settings : bar.getByRole('button', { name: 'Pages' })
      await expect(last, at).toBeVisible()
      await expect(last, at).toBeInViewport({ ratio: 1 })
      const b = await box(last)
      expect(b.x + b.width, at).toBeLessThanOrEqual(width)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        at,
      ).toBe(true)
    }
  }
})
