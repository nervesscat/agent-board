import type { Page } from '@playwright/test'

/** How long `delayApi` holds a matching request back: well over the 150 ms a placeholder waits. */
export const SLOW_MS = 1500

/**
 * Holds every API request whose path and query match `match` back by `ms` before the board answers it,
 * so the page is seen while that data is on its way. `match` is tested against `/api/...?query`.
 */
export async function delayApi(page: Page, match: RegExp, ms = SLOW_MS) {
  await page.route(
    (url) => url.pathname.startsWith('/api/') && match.test(url.pathname + url.search),
    async (route) => {
      await new Promise((r) => setTimeout(r, ms))
      await route.continue().catch(() => {})
    },
  )
}

/**
 * Starts recording every loading placeholder the page draws (a `[role=status][aria-busy]` region or a
 * `[data-slot=skeleton]` block), in every document the tab loads from now on: a full navigation keeps
 * what the earlier pages saw (in `sessionStorage`), so each page visited is checked. `seen()` returns
 * what it saw, each as the region's label (or `skeleton`): empty for loads that flashed nothing.
 */
export async function watchLoading(page: Page) {
  await page.addInitScript(() => {
    const KEY = 'sawLoading'
    const scan = () => {
      const found = [...document.querySelectorAll('[role=status][aria-busy], [data-slot=skeleton]')].map(
        (e) => e.getAttribute('aria-label') ?? 'skeleton',
      )
      if (!found.length) return
      const before = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as string[]
      sessionStorage.setItem(KEY, JSON.stringify([...before, ...found]))
    }
    new MutationObserver(scan).observe(document, { childList: true, subtree: true })
  })
  return {
    seen: () => page.evaluate(() => JSON.parse(sessionStorage.getItem('sawLoading') ?? '[]') as string[]),
  }
}
