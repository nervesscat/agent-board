// What the browser sees, driven by Playwright's Chromium: the JS and CSS each route downloads, cold
// first loads, client-side navigations between screens, and the requests an idle page keeps making.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { chromium } from '@playwright/test'

import { median } from './report.mjs'

/**
 * Records, inside the page, when React has taken it over (the e2e fixtures' check) and when the
 * page's data is shown: the first element matching `selector` whose text contains `text`.
 */
const watchPage = ({ selector, text, re }) => {
  const w = window
  const timer = setInterval(() => {
    if (
      w.__benchHydrated === undefined &&
      document.body &&
      Object.keys(document.body).some((k) => k.startsWith('__reactFiber'))
    )
      w.__benchHydrated = performance.now()
    if (
      w.__benchContent === undefined &&
      [...document.querySelectorAll(selector)].some(
        (e) =>
          (!text || (e.textContent ?? '').includes(text)) &&
          (!re || new RegExp(re).test(e.textContent ?? '')),
      )
    )
      w.__benchContent = performance.now()
    if (w.__benchHydrated !== undefined && w.__benchContent !== undefined) clearInterval(timer)
  }, 10)
}

const isApi = (url) => new URL(url).pathname.startsWith('/api/')

export async function launch() {
  return chromium.launch({ headless: true })
}

async function settle(page, ms = 10_000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {})
}

/** One cold load of `url` in a fresh context: timings, requests and bytes, and the assets it fetched. */
async function coldLoad(browser, baseURL, { url, ready }) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await page.addInitScript(watchPage, ready)
  const requests = []
  page.on('requestfinished', (req) => requests.push(req))
  page.on('requestfailed', (req) => requests.push(req))
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
    const shown = await page
      .waitForFunction(
        () => window.__benchHydrated !== undefined && window.__benchContent !== undefined,
        null,
        {
          timeout: 30_000,
        },
      )
      .then(() => true)
      .catch(() => false)
    await settle(page)
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      return {
        ttfb: nav?.responseStart ?? null,
        dcl: nav?.domContentLoadedEventEnd ?? null,
        load: nav?.loadEventEnd ?? null,
        hydrated: window.__benchHydrated ?? null,
        content: window.__benchContent ?? null,
      }
    })
    let bytes = 0
    for (const req of requests) {
      const sizes = await req.sizes().catch(() => null)
      if (sizes) bytes += sizes.responseBodySize + sizes.responseHeadersSize
    }
    return {
      status: res?.status() ?? null,
      shown,
      ...t,
      requests: requests.length,
      apiRequests: requests.filter((r) => isApi(r.url())).length,
      bytes,
      assets: [
        ...new Set(requests.map((r) => new URL(r.url()).pathname).filter((p) => p.startsWith('/assets/'))),
      ],
    }
  } finally {
    await context.close()
  }
}

// --- bundle per route ---

const gzipSize = (buf) => zlib.gzipSync(buf, { level: 9 }).length

/** Sizes of a built asset, raw and gzipped, read from the build output (cached per path). */
function assetSizer(publicDir) {
  const cache = new Map()
  return (urlPath) => {
    if (!cache.has(urlPath)) {
      const file = path.join(publicDir, ...urlPath.split('/').filter(Boolean))
      const buf = fs.existsSync(file) ? fs.readFileSync(file) : null
      cache.set(urlPath, buf ? { raw: buf.length, gzip: gzipSize(buf) } : null)
    }
    return cache.get(urlPath)
  }
}

/** The JS and CSS (and fonts) a cold load of each route fetches, sized from the build output. */
export async function bundle(browser, baseURL, routes, buildDir) {
  const publicDir = path.join(buildDir, 'public')
  const size = assetSizer(publicDir)
  const out = {}
  for (const route of routes) {
    const load = await coldLoad(browser, baseURL, route)
    const sum = (re) =>
      load.assets
        .filter((a) => re.test(a))
        .reduce(
          (acc, a) => {
            const s = size(a)
            return s ? { raw: acc.raw + s.raw, gzip: acc.gzip + s.gzip, files: acc.files + 1 } : acc
          },
          { raw: 0, gzip: 0, files: 0 },
        )
    out[route.name] = {
      url: route.url,
      shown: load.shown,
      js: sum(/\.m?js$/),
      css: sum(/\.css$/),
      fonts: sum(/\.(woff2?|ttf|otf)$/),
    }
  }
  const total = { js: { raw: 0, gzip: 0 }, css: { raw: 0, gzip: 0 }, all: { raw: 0, files: 0 } }
  const assets = path.join(publicDir, 'assets')
  for (const name of fs.existsSync(assets) ? fs.readdirSync(assets) : []) {
    const s = size(`/assets/${name}`)
    if (!s) continue
    total.all.raw += s.raw
    total.all.files++
    const kind = /\.m?js$/.test(name) ? 'js' : /\.css$/.test(name) ? 'css' : null
    if (kind) {
      total[kind].raw += s.raw
      total[kind].gzip += s.gzip
    }
  }
  return { routes: out, total }
}

// --- first loads ---

/** `loads` cold loads of each page; per page the median of each field. */
export async function firstLoads(browser, baseURL, pages, loads) {
  const out = {}
  for (const p of pages) {
    const samples = []
    for (let i = 0; i < loads; i++) samples.push(await coldLoad(browser, baseURL, p))
    const pick = (k) => median(samples.map((s) => s[k]).filter((x) => x !== null))
    out[p.name] = {
      url: p.url,
      shown: samples.every((s) => s.shown),
      statuses: samples.map((s) => s.status),
      ttfb: pick('ttfb'),
      dcl: pick('dcl'),
      load: pick('load'),
      hydrated: pick('hydrated'),
      content: samples.every((s) => s.shown) ? pick('content') : null,
      requests: pick('requests'),
      apiRequests: pick('apiRequests'),
      bytes: pick('bytes'),
    }
  }
  return out
}

// --- navigation ---

/**
 * A client-side navigation: load `from`, then click `link` inside the page and time, in the page's
 * own clock, until `to` is shown; with the API requests it caused.
 */
async function navigateOnce(browser, baseURL, nav) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  try {
    await page.addInitScript(watchPage, nav.from.ready)
    await page.goto(nav.from.url, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(
      () => window.__benchHydrated !== undefined && window.__benchContent !== undefined,
      null,
      {
        timeout: 30_000,
      },
    )
    await settle(page)
    const link = page.locator(nav.link).first()
    if (!(await link.count()))
      return { ms: null, apiRequests: null, reason: `no ${nav.link} on ${nav.from.url}` }
    await link.scrollIntoViewIfNeeded()
    let counting = true
    let api = 0
    page.on('request', (req) => {
      if (counting && isApi(req.url())) api++
    })
    const ms = await page.evaluate(
      ({ link, to }) =>
        new Promise((resolve) => {
          const start = performance.now()
          const timer = setInterval(() => {
            const shown = [...document.querySelectorAll(to.selector)].some(
              (e) =>
                (!to.text || (e.textContent ?? '').includes(to.text)) &&
                (!to.re || new RegExp(to.re).test(e.textContent ?? '')),
            )
            if (shown) {
              clearInterval(timer)
              resolve(performance.now() - start)
            } else if (performance.now() - start > 30_000) {
              clearInterval(timer)
              resolve(null)
            }
          }, 5)
          document.querySelector(link).click()
        }),
      { link: nav.link, to: nav.to },
    )
    await settle(page)
    counting = false
    return { ms, apiRequests: api, url: new URL(page.url()).pathname }
  } finally {
    await context.close()
  }
}

export async function navigations(browser, baseURL, navs, loads) {
  const out = {}
  for (const nav of navs) {
    const samples = []
    for (let i = 0; i < loads; i++) samples.push(await navigateOnce(browser, baseURL, nav))
    const ok = samples.filter((s) => s.ms !== null)
    out[nav.name] = {
      ms: ok.length === samples.length ? median(ok.map((s) => s.ms)) : null,
      apiRequests: ok.length ? median(ok.map((s) => s.apiRequests)) : null,
      reason: samples.find((s) => s.reason)?.reason,
      landed: samples.map((s) => s.url),
    }
  }
  return out
}

// --- idle pages ---

/**
 * Opens every page side by side, each in its own window (so each is visible), lets them settle, then
 * counts what each requests over `seconds` without touching it.
 */
export async function idle(browser, baseURL, pages, seconds) {
  const opened = await Promise.all(
    pages.map(async (p) => {
      const context = await browser.newContext({ baseURL })
      const page = await context.newPage()
      await page.addInitScript(watchPage, p.ready)
      await page.goto(p.url, { waitUntil: 'load', timeout: 60_000 })
      await page
        .waitForFunction(
          () => window.__benchHydrated !== undefined && window.__benchContent !== undefined,
          null,
          {
            timeout: 30_000,
          },
        )
        .catch(() => {})
      await settle(page)
      return { p, context, page, seen: [] }
    }),
  )
  await new Promise((r) => setTimeout(r, 2000))
  for (const o of opened) o.page.on('request', (req) => o.seen.push(req.url()))
  await new Promise((r) => setTimeout(r, seconds * 1000))
  const out = {}
  for (const o of opened) {
    const urls = [...o.seen]
    const perPath = {}
    for (const u of urls) {
      const url = new URL(u)
      const key = url.pathname.startsWith('/api/') ? url.pathname + url.search : '(not /api)'
      perPath[key] = Math.round(((perPath[key] ?? 0) + 60 / seconds) * 100) / 100
    }
    out[o.p.name] = {
      url: o.p.url,
      visibility: await o.page.evaluate(() => document.visibilityState),
      perMin: Math.round((urls.length / seconds) * 60 * 100) / 100,
      perPath,
    }
    await o.context.close()
  }
  return out
}
