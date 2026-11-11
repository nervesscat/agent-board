/** The link fields a running preview's state carries (runs.ts `proxyUrl`, `remoteUrl`, and its loopback `url`). */
export interface PreviewLinkFields {
  url?: string | null
  proxyUrl?: string | null
  remoteUrl?: string | null
}

/** Whether the page is opened on this machine (localhost, 127.0.0.1 or [::1]); true when there is no page. */
export function openedHere(): boolean {
  if (typeof window === 'undefined') return true
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * The link a running preview is opened by, and the proxied one beside it. Opened on this machine: the
 * loopback URL, with the board's proxied path beside it. Opened on the tailnet name: the proxied path alone,
 * which answers on that origin (the loopback URL does not reach it from another device).
 */
export function previewOpenLinks(
  run: PreviewLinkFields,
  here = openedHere(),
): { open: string | null; through: string | null } {
  if (here) return { open: run.url ?? run.proxyUrl ?? null, through: run.proxyUrl ?? null }
  const path = run.proxyUrl ? run.proxyUrl.replace(/^https?:\/\/[^/]+/, '') : null
  return { open: path ?? run.remoteUrl ?? null, through: null }
}
