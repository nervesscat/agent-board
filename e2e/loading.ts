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
 * `[data-slot=skeleton]` block), from the next load of the page on. `seen()` returns what it saw, each
 * as the region's label (or `skeleton`): empty for a load that was fast enough to flash nothing.
 */
export async function watchLoading(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { sawLoading: string[] }
    w.sawLoading = []
    const scan = () => {
      for (const e of document.querySelectorAll('[role=status][aria-busy], [data-slot=skeleton]'))
        w.sawLoading.push(e.getAttribute('aria-label') ?? 'skeleton')
    }
    new MutationObserver(scan).observe(document, { childList: true, subtree: true })
  })
  return {
    seen: () => page.evaluate(() => (window as unknown as { sawLoading: string[] }).sawLoading),
  }
}
