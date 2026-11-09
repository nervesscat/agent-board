/**
 * The proxied preview paths, with nothing imported: vite.config.ts loads devEntrance.ts, which may not load
 * the board's modules (its database is opened by the board itself, previewProxy.ts), so the path rules live
 * here, where both can read them.
 */

/** `/p/<workspaceId>/<runId>/` and whatever follows it: the proxied preview's own path starts with `/`. */
export const PREVIEW_PATH = /^\/p\/(\d+)\/(\d+)(\/.*)?$/

export const isPreviewPath = (pathname: string) => PREVIEW_PATH.test(pathname)

/** The path of a run's preview on the board's origin, with its trailing slash. */
export const previewPathOf = (workspaceId: number, runId: number) => `/p/${workspaceId}/${runId}/`

/** The cookie a redeemed link sets: one per run, so two previews never share one. */
export const previewCookieName = (workspaceId: number, runId: number) =>
  `board_preview_${workspaceId}_${runId}`
