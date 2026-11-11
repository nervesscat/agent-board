import { HttpError } from './http'

/**
 * Previews: a branch an agent runs from its worktree for the human to try before it is merged. The
 * agent registers the link on its workspace; the ticket page shows it and whether it answers.
 */

/** A workspace's preview link as given, trimmed: '' (or null) clears it, anything else must be http(s). */
export function previewUrl(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'previewUrl must be a full URL such as http://localhost:47101')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new HttpError(400, 'previewUrl must be an http:// or https:// URL')
  return raw
}

// What the board checks: this machine only, so it cannot be pointed at other hosts.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isLocalUrl = (value: string) => {
  try {
    return LOOPBACK.has(new URL(value).hostname)
  } catch {
    return false
  }
}

export type PreviewState = {
  running: boolean
  status?: number
  checkedAt: string
  /**
   * Why the page cannot be shown in a frame (its X-Frame-Options or Content-Security-Policy
   * `frame-ancestors`), null when it may; only a check of a link has it, never the board's own proxy.
   */
  frameBlocked?: string | null
}

/**
 * Why a page's own headers refuse to be framed by the board, in a few words, or null when they do not.
 * The board frames a link as it is on this machine (PreviewWindow.tsx): that is another origin (another
 * port), so any X-Frame-Options refuses it, and a frame-ancestors that does not name `*` does too.
 */
export function frameBlockedBy(headers: Headers): string | null {
  const xfo = headers.get('x-frame-options')?.trim()
  if (xfo) return `it sends X-Frame-Options: ${xfo.toLowerCase()}`
  const csp = headers.get('content-security-policy')
  if (!csp) return null
  // Directives, across the policies a preview sends (a second header is joined with a comma): a
  // frame-ancestors source list is space-separated, so a comma or a semicolon ends the one looked at.
  for (const directive of csp.split(/[;,]/)) {
    const [name, ...sources] = directive.trim().split(/\s+/)
    if (name?.toLowerCase() !== 'frame-ancestors') continue
    if (sources.includes('*')) continue
    return `it sends a Content-Security-Policy frame-ancestors ${sources.join(' ') || '(none)'}`
  }
  return null
}

/**
 * Whether something answers at `url`: any HTTP response (an error page or a redirect too) means it is
 * running; a refused connection or no answer within `timeoutMs` means it is not. Redirects are not
 * followed, so the check never leaves the URL's host. A page that refuses to be framed says why.
 */
export async function checkPreview(url: string, timeoutMs = 1500): Promise<PreviewState> {
  if (!isLocalUrl(url)) throw new HttpError(400, 'only previews on localhost are checked')
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    const frameBlocked = frameBlockedBy(res.headers)
    // Only the status and the framing policy matter; do not wait for the page.
    res.body?.cancel().catch(() => {})
    return { running: true, status: res.status, checkedAt: new Date().toISOString(), frameBlocked }
  } catch {
    return { running: false, checkedAt: new Date().toISOString() }
  }
}

// The ticket page asks every few seconds per viewer; one check per URL serves them all for a while.
const TTL = 5000
const cache = new Map<string, { at: number; state: Promise<PreviewState> }>()

export function previewState(url: string): Promise<PreviewState> {
  if (!isLocalUrl(url)) throw new HttpError(400, 'only previews on localhost are checked')
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < TTL) return hit.state
  for (const [k, v] of cache) if (Date.now() - v.at >= TTL) cache.delete(k)
  const state = checkPreview(url)
  cache.set(url, { at: Date.now(), state })
  return state
}

/** Forget what the check said about `url`: its server was just stopped, the next look asks again. */
export function forgetPreviewState(url: string) {
  cache.delete(url)
}
