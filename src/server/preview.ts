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

export type PreviewState = { running: boolean; status?: number; checkedAt: string }

/**
 * Whether something answers at `url`: any HTTP response (an error page or a redirect too) means it is
 * running; a refused connection or no answer within `timeoutMs` means it is not. Redirects are not
 * followed, so the check never leaves the URL's host.
 */
export async function checkPreview(url: string, timeoutMs = 1500): Promise<PreviewState> {
  if (!isLocalUrl(url)) throw new HttpError(400, 'only previews on localhost are checked')
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    // Only the status matters; do not wait for the page.
    res.body?.cancel().catch(() => {})
    return { running: true, status: res.status, checkedAt: new Date().toISOString() }
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
