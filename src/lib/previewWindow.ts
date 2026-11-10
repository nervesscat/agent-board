/**
 * The embedded preview window: a preview shown inside the board, in a window of its own over the
 * board's pages, so the ticket, its tasks and its conversation stay where they were. A web build shows
 * the preview in an iframe of its path on the board's own origin (`/p/<workspaceId>/<runId>/`, the
 * proxy in previewProxy.ts, so no X-Frame-Options of the preview's own and no mixed content); the
 * desktop app shows it in a real embedded browser view (`<webview>`), which PreviewWindow.tsx picks.
 *
 * One window per preview: opening one that is already open switches to its tab, another adds one. A
 * window never starts or stops a run: it only loads what the run already serves, and says when it is
 * not running. This module is the window's state and its link rules, kept apart from the UI so both
 * are unit-tested.
 */

/** The link fields a running preview's state carries (runs.ts `proxyUrl`, `remoteUrl`, and its loopback `url`). */
export interface PreviewLinks {
  url?: string | null
  proxyUrl?: string | null
  remoteUrl?: string | null
}

/** One preview in the window: the tab it opens, and the links it loads and offers. */
export interface PreviewTab {
  /** One window per preview: a run of a workspace, or an agent's link on one. */
  key: string
  /** The ticket's title, over the workspace and run it shows. */
  title: string
  subtitle: string
  /** What the window loads: a path on the board's own origin, or the loopback link on this machine. */
  src: string
  /** Where Open in browser goes: the proxy link, or the loopback link on this machine. Null when none. */
  browser: string | null
  workspaceId: number
  ticketId: number | null
  runId: number | null
  /** Whether it loads through the board's proxy, so its run's state says whether it still runs. */
  through: boolean
}

/** The window: its tabs, the one showing, whether it is maximized, and how often each tab reloaded. */
export interface PreviewWindowsState {
  tabs: PreviewTab[]
  active: string | null
  maximized: boolean
  /** Per tab, the reload it is at: a new one makes the frame load again. */
  loads: Record<string, number>
}

export const NO_PREVIEW_WINDOW: PreviewWindowsState = {
  tabs: [],
  active: null,
  maximized: false,
  loads: {},
}

/** Whether the page is opened on this machine (localhost, 127.0.0.1 or [::1]); true when there is no page. */
export function openedHere(): boolean {
  if (typeof window === 'undefined') return true
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** A URL that only answers on the machine the board runs on. */
export function loopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/**
 * The path on the board's own origin the window can load, or null when it cannot be embedded safely.
 * The proxy path always can: it carries the board's sign-in and never shows a loopback port to another
 * device. On this machine a loopback link can too, as it is (`http`, the board's page an `http` one
 * here; a proxy path is still preferred, so an `https` board never mixes content). Anything else — a
 * hosted page, a link off this machine — stays in the browser: its own origin decides whether it may
 * be framed.
 */
export function previewEmbedPath(run: PreviewLinks, here = openedHere()): string | null {
  const proxied = previewPath(run.proxyUrl)
  if (proxied) return proxied
  if (here && loopbackUrl(run.url)) return run.url!
  return null
}

/** `/p/<w>/<r>/` and its query, off a proxy URL; null for a link that is not the board's proxy path. */
function previewPath(proxyUrl: string | null | undefined): string | null {
  if (!proxyUrl) return null
  try {
    const url = new URL(proxyUrl, 'http://board.invalid')
    return /^\/p\/\d+\/\d+\/?$/.test(url.pathname) ? `${url.pathname}${url.search}` : null
  } catch {
    return null
  }
}

/**
 * The link Open in browser opens: the proxy link when there is one (it works on this machine as from
 * another device, and is the same preview), else the loopback link on this machine, or a hosted link
 * wherever it is opened. Null when the only link is a loopback one off this machine.
 */
export function previewBrowserUrl(run: PreviewLinks, here = openedHere()): string | null {
  if (run.proxyUrl) return run.proxyUrl
  if (here) return run.url ?? run.remoteUrl ?? null
  if (!loopbackUrl(run.url)) return run.url ?? null
  return run.remoteUrl ?? null
}

/** What to call a preview: the run of a workspace, or the link an agent set. */
export function previewTab(input: {
  ticketId: number | null
  title: string
  workspaceId: number
  runId: number | null
  /** The workspace and the run (or "link") under the title. */
  label: string
  run: PreviewLinks
  here?: boolean
}): PreviewTab | null {
  const here = input.here ?? openedHere()
  const src = previewEmbedPath(input.run, here)
  if (!src) return null
  const runPart = input.runId === null ? 'link' : String(input.runId)
  return {
    key: `ws:${input.workspaceId}:${runPart}`,
    title: input.ticketId === null ? input.title : `#${input.ticketId} ${input.title}`,
    subtitle: input.label,
    src,
    browser: previewBrowserUrl(input.run, here),
    workspaceId: input.workspaceId,
    ticketId: input.ticketId,
    runId: input.runId,
    through: previewPath(src) !== null,
  }
}

/** The window with a tab opened, or switched to when it is already there (its links as they are now). */
export function openTab(state: PreviewWindowsState, tab: PreviewTab): PreviewWindowsState {
  const there = state.tabs.some((t) => t.key === tab.key)
  return {
    ...state,
    tabs: there ? state.tabs.map((t) => (t.key === tab.key ? tab : t)) : [...state.tabs, tab],
    active: tab.key,
  }
}

/** The tab that shows, or null. */
export function activeTab(state: PreviewWindowsState): PreviewTab | null {
  return state.tabs.find((t) => t.key === state.active) ?? null
}

/** The window with that tab closed: the one before it shows, the next when it was the first, none when it was the last. */
export function closeTab(state: PreviewWindowsState, key: string): PreviewWindowsState {
  const at = state.tabs.findIndex((t) => t.key === key)
  if (at < 0) return state
  const tabs = state.tabs.filter((t) => t.key !== key)
  const loads = { ...state.loads }
  delete loads[key]
  if (state.active !== key) return { ...state, tabs, loads }
  const next = tabs[Math.min(at, tabs.length - 1)] ?? null
  return { ...state, tabs, loads, active: next?.key ?? null }
}

/** The window with that tab showing, if it is open. */
export function showTab(state: PreviewWindowsState, key: string): PreviewWindowsState {
  if (!state.tabs.some((t) => t.key === key)) return state
  return { ...state, active: key }
}

/** The window with that tab reloaded, or every one when no key is given. */
export function reloadTabs(state: PreviewWindowsState, key?: string): PreviewWindowsState {
  const loads = { ...state.loads }
  for (const t of state.tabs) if (!key || t.key === key) loads[t.key] = (loads[t.key] ?? 0) + 1
  return { ...state, loads }
}

/** The window maximized, or back to its floating size. */
export function toggleMaximized(state: PreviewWindowsState): PreviewWindowsState {
  return { ...state, maximized: !state.maximized }
}

/** Everything the window asked the board about a preview: whether it still runs, and why not. */
export interface PreviewStateLike {
  running: boolean
  managed?: { status: string; reason?: string | null } | null
}

export type PreviewHealth = 'unknown' | 'running' | 'building' | 'stopped' | 'failed'

/** Whether a tab's preview still runs, from the board's answer for its workspace. */
export function previewHealth(
  tab: Pick<PreviewTab, 'through'>,
  state: PreviewStateLike | null | undefined,
): PreviewHealth {
  if (!state) return 'unknown'
  if (tab.through) {
    const status = state.managed?.status
    if (status === 'running') return 'running'
    if (status === 'building' || status === 'starting') return 'building'
    if (status === 'failed') return 'failed'
    return 'stopped'
  }
  return state.running ? 'running' : 'stopped'
}

/**
 * What the window says over a preview that is not running. It never starts or stops a run itself:
 * it says where the Start is.
 */
export function previewNotice(
  health: PreviewHealth,
  tab: Pick<PreviewTab, 'through'>,
  reason?: string | null,
): string | null {
  if (health === 'building') return 'Building… it shows here once it runs.'
  if (health === 'failed')
    return `The preview failed${reason ? `: ${reason}` : ''}. See its log on the ticket.`
  if (health === 'stopped')
    return tab.through
      ? "This preview is stopped. Start it from the ticket's Runs card or the Previews page."
      : 'The preview does not answer on this machine. Start its server again where it runs.'
  return null
}
