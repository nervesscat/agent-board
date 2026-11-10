/**
 * The proxied preview paths, with nothing imported: vite.config.ts loads devEntrance.ts, which may not load
 * the board's modules (its database is opened by the board itself, previewProxy.ts), so the path rules live
 * here, where both can read them.
 */

/** `/p/<workspaceId>/<runId>/` and whatever follows it: the proxied preview's own path starts with `/`. */
export const PREVIEW_PATH = /^\/p\/(\d+)\/(\d+)(\/.*)?$/

/**
 * The base this build serves at, read from the variable the board starts a preview run with (vite.config.ts
 * turns it into Vite's base). A preview of the board is itself a board, and it serves all of its own paths,
 * `/p/<w>/<r>/…` included, at that base: those are the app's, never a preview for it to proxy in turn.
 */
function atBase(value: string | undefined): string {
  const base = (value ?? '').trim()
  if (!base || base === '/') return '/'
  const rooted = base.startsWith('/') ? base : `/${base}`
  return rooted.endsWith('/') ? rooted : `${rooted}/`
}

let appBase = atBase(typeof process === 'undefined' ? undefined : process.env.BOARD_PREVIEW_BASE)

/** Tell the path rules the base this build serves at (Vite's `BASE_URL`, or the run's variable). */
export function useAppBase(base: string | undefined): void {
  appBase = atBase(base)
}

/** Whether a path is at or under the base this build serves at (never for the root base). */
const underAppBase = (pathname: string): boolean =>
  appBase !== '/' && (pathname === appBase.slice(0, -1) || pathname.startsWith(appBase))

export const isPreviewPath = (pathname: string) => !underAppBase(pathname) && PREVIEW_PATH.test(pathname)

/** The path of a run's preview on the board's origin, with its trailing slash. */
export const previewPathOf = (workspaceId: number, runId: number) => `/p/${workspaceId}/${runId}/`

/** The cookie a redeemed link sets: one per run, so two previews never share one. */
export const previewCookieName = (workspaceId: number, runId: number) =>
  `board_preview_${workspaceId}_${runId}`
