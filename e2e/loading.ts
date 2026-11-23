import type { Page, Response } from '@playwright/test'

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

/** One recorded answer of the board to a GET under /api/. */
interface Answer {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** What `warm` heard from the board, per page, by `/api/...?query`. */
const heard = new WeakMap<Page, Map<string, Answer>>()

/** Headers that describe the bytes the board sent, not the decoded body a recorded answer keeps. */
const ENCODING_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding']

/**
 * Opens each page once and lets its requests finish, so the board's own first-time work (a cold read,
 * a first build of an answer) is done before a load is judged "fast". It also keeps every GET answer
 * of /api/ it saw, for `watchLoading` to give back. Call it before `watchLoading`.
 */
export async function warm(page: Page, ...urls: string[]) {
  const answers = heard.get(page) ?? new Map<string, Answer>()
  heard.set(page, answers)
  const reading: Promise<void>[] = []
  const listen = (res: Response) => {
    const url = new URL(res.url())
    if (res.request().method() !== 'GET' || !url.pathname.startsWith('/api/') || res.status() !== 200) return
    reading.push(
      res.body().then(
        (body) => {
          const headers = Object.fromEntries(
            Object.entries(res.headers()).filter(([name]) => !ENCODING_HEADERS.includes(name)),
          )
          answers.set(url.pathname + url.search, { status: res.status(), headers, body })
        },
        // A response the page abandoned (a navigation) has no body to keep; it is simply not replayed.
        () => {},
      ),
    )
  }
  page.on('response', listen)
  try {
    for (const url of urls) {
      await page.goto(url)
      await page.waitForLoadState('networkidle')
    }
    await Promise.all(reading)
  } finally {
    page.off('response', listen)
  }
}

/**
 * How much of a millisecond of the page's time passes for each one `slowMotion` lets by, at most: the page
 * keeps its own clock, stopped, and the test lets it by 1 ms about every 8 ms of its own (a step, then a
 * short rest).
 */
const STEP_MS = 1
const REST_MS = 5

/**
 * Puts the page's clock in slow motion: its timers (the 150 ms a placeholder waits, among them) count
 * time that runs about eight times slower than the runner's. A busy runner that stalls the page or the
 * test for a few hundred ms then costs the page tens of its own, not more than the 150 ms a fast load has.
 * Only the page's own timers and `Date` are slowed: the board and the test run on real time.
 */
async function slowMotion(page: Page) {
  await page.clock.install({ time: new Date() })
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  let open = true
  page.once('close', () => (open = false))
  void (async () => {
    while (open) {
      await new Promise((r) => setTimeout(r, REST_MS))
      await page.clock.runFor(STEP_MS).catch(() => {})
    }
  })()
}

/**
 * Starts recording every loading placeholder the page draws (a `[role=status][aria-busy]` region or a
 * `[data-slot=skeleton]` block), in every document the tab loads from now on: a full navigation keeps
 * what the earlier pages saw (in `sessionStorage`), so each page visited is checked. `seen()` returns
 * what it saw, each as the region's label (or `skeleton`): empty for loads that flashed nothing.
 *
 * A "fast" load is one the board answers at once, and how soon a shared board answers is the runner's
 * and the other tests' business (a busy one took seconds, and the placeholder rightly came after its
 * 150 ms). So the GET answers `warm` kept are handed back from here, by the test, in place of asking the
 * board again: the page then waits on nothing but itself, and a placeholder drawn is the page drawing one
 * for a load that took no time. Whatever `warm` did not hear (a write, a route it never opened) still
 * goes to the board.
 */
export async function watchLoading(page: Page) {
  const answers = heard.get(page)
  if (answers?.size) {
    const key = (url: URL) => url.pathname + url.search
    await page.route(
      (url) => answers.has(key(url)),
      (route) => {
        const answer = answers.get(key(new URL(route.request().url())))
        if (route.request().method() !== 'GET' || !answer) return route.fallback()
        return route.fulfill(answer)
      },
    )
  }
  await slowMotion(page)
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
