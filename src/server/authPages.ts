import { callerOf, onThisMachine, redirectTo } from './auth'
import { config } from './config'
import { LOCAL_RP_ID, localSite, type SignInSite } from './entrance'
import { getAccount, hasAccount } from './passkeys'
import { lastHuman } from './actors'

/**
 * The sign-in pages: /setup (first boot, on the host), /login and /enroll (a new device, from a one-time
 * link). README: "Signing in".
 *
 * Each is one HTML document with its style and script inline, rendered here before the app: nothing of
 * the app, and under `vite dev` none of Vite's files, is served before sign-in (devEntrance.ts). The
 * script talks WebAuthn with the browser and calls /api/auth/* (authApi.ts).
 *
 * WebAuthn takes no IP address for an RP ID: on this machine the pages live on localhost, so a browser
 * on 127.0.0.1 or [::1] is sent there.
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// `next` is resolved against this stand-in origin: what stays on it is a path of the board's own.
const HERE = 'http://board.invalid'

/**
 * Where to go after signing in: a path on this origin, never another site (`//host`, `/\host`, `/.//host`)
 * as the browser reads it. No control character or whitespace either: a URL parser drops tabs and line breaks
 * (`/<tab>/host` is `//host`), and a Location header cannot carry them. What comes back is the path,
 * query and fragment the URL parser makes of it, percent-encoded, so a header takes it too.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || /[\s\p{Cc}]/u.test(raw)) return '/'
  let url: URL
  try {
    url = new URL(raw, HERE)
  } catch {
    return '/'
  }
  // A path that resolves to `//host` (`/.//host`, `/..//host`) would be another site once in a Location.
  if (url.origin !== HERE || url.pathname.startsWith('//')) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #fff;
  --border: #e4e4e7; --primary: #18181b; --on-primary: #fafafa; --error: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa;
  --card: #18181b; --border: #27272a; --primary: #fafafa; --on-primary: #18181b; --error: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
  background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border);
  border-radius: 12px; padding: 24px; }
h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.02em; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; margin: 12px 0 4px; font-size: 13px; font-weight: 500; }
input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: inherit; font: inherit; }
button { width: 100%; margin-top: 16px; padding: 9px 12px; border: 0; border-radius: 8px;
  background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
code { font-size: 13px; }
#message { min-height: 1.5em; margin: 12px 0 0; color: var(--error); }
`

// The browser half of each ceremony: options from the board, the passkey prompt, the response back.
const SCRIPT = `
const toBuf = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer
}
const fromBuf = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
const ids = (list) => (list || []).map((c) => ({ ...c, id: toBuf(c.id) }))
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.status + ' ' + res.statusText)
  return json
}
const common = (c) => ({
  id: c.id,
  rawId: fromBuf(c.rawId),
  type: c.type,
  authenticatorAttachment: c.authenticatorAttachment || undefined,
  clientExtensionResults: c.getClientExtensionResults(),
})
async function create(o) {
  const publicKey = { ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: ids(o.excludeCredentials) }
  const c = await navigator.credentials.create({ publicKey })
  return { ...common(c), response: {
    clientDataJSON: fromBuf(c.response.clientDataJSON),
    attestationObject: fromBuf(c.response.attestationObject),
    transports: c.response.getTransports ? c.response.getTransports() : [],
  } }
}
async function get(o) {
  const publicKey = { ...o, challenge: toBuf(o.challenge), allowCredentials: ids(o.allowCredentials) }
  const c = await navigator.credentials.get({ publicKey })
  return { ...common(c), response: {
    clientDataJSON: fromBuf(c.response.clientDataJSON),
    authenticatorData: fromBuf(c.response.authenticatorData),
    signature: fromBuf(c.response.signature),
    userHandle: c.response.userHandle ? fromBuf(c.response.userHandle) : undefined,
  } }
}
const form = document.getElementById('form')
const message = document.getElementById('message')
form?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = form.querySelector('button')
  button.disabled = true
  message.textContent = ''
  try {
    if (!window.PublicKeyCredential) throw new Error('This browser cannot use passkeys here.')
    const field = (name) => form.elements.namedItem(name)?.value
    const flow = form.dataset.flow
    if (flow === 'setup') {
      const options = await post('/api/auth/setup/options', { name: field('name') })
      await post('/api/auth/setup/verify', { device: field('device'), response: await create(options) })
    } else if (flow === 'login') {
      const options = await post('/api/auth/login/options')
      await post('/api/auth/login/verify', { response: await get(options) })
    } else {
      const code = form.dataset.code
      const options = await post('/api/auth/enrol/options', { code })
      await post('/api/auth/enrol/verify', { code, device: field('device'), response: await create(options) })
    }
    location.replace(form.dataset.next || '/')
  } catch (err) {
    message.textContent =
      err && err.name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out. Try again.'
      : (err && err.message) || String(err)
    button.disabled = false
  }
})
`

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · CrossBoard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<script type="module">${SCRIPT}</script>
</body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Never inside another site's frame: a passkey prompt there would be theirs to dress up.
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    },
  })
}

const hostName = (request: Request) => {
  try {
    return new URL(`http://${request.headers.get('host') ?? ''}`).hostname
  } catch {
    return ''
  }
}

/** On this machine but not on localhost (127.0.0.1, [::1]): the same page on localhost, where passkeys work. */
function onLocalhost(request: Request, site: SignInSite): Response | null {
  if (site.rpId !== LOCAL_RP_ID || hostName(request) === LOCAL_RP_ID) return null
  const url = new URL(request.url)
  return Response.redirect(`${localSite(config.port).origin}${url.pathname}${url.search}`, 302)
}

function setupPage(request: Request, site: SignInSite): Response {
  if (hasAccount()) return redirectTo('/login')
  if (!onThisMachine(request) || site.rpId !== LOCAL_RP_ID)
    return page(
      'Finish setup on the host',
      `<h1>Finish setup on the host</h1>
<p>This board has no account yet. It is created on the machine the board runs on: open
<code>${escape(localSite(config.port).origin)}/setup</code> there. Then come back here to add this device
with a link from the board.</p>`,
    )
  const elsewhere = onLocalhost(request, site)
  if (elsewhere) return elsewhere
  return page(
    'Set up',
    `<h1>Set up CrossBoard</h1>
<p>Create the board's account and its first passkey, on this machine. Other devices are added later from
Settings, with a one-time link.</p>
<form id="form" data-flow="setup" data-next="/">
<label for="name">Your name on the board</label>
<input id="name" name="name" required maxlength="80" value="${escape(lastHuman() ?? '')}" autocomplete="off">
<label for="device">This device</label>
<input id="device" name="device" required maxlength="60" value="This computer" autocomplete="off">
<button type="submit">Create passkey</button>
<p id="message" role="alert"></p>
</form>`,
  )
}

async function loginPage(request: Request, site: SignInSite): Promise<Response> {
  if (!hasAccount()) return redirectTo('/setup')
  const next = safeNext(new URL(request.url).searchParams.get('next'))
  if (await callerOf(request, undefined, site)) return redirectTo(next)
  const elsewhere = onLocalhost(request, site)
  if (elsewhere) return elsewhere
  return page(
    'Sign in',
    `<h1>Sign in</h1>
<p>Welcome back, ${escape(getAccount()!.name)}. Sign in with a passkey of this ${site.rpId === LOCAL_RP_ID ? 'machine' : 'device'}.</p>
<form id="form" data-flow="login" data-next="${escape(next)}">
<button type="submit" autofocus>Sign in with a passkey</button>
<p id="message" role="alert"></p>
</form>`,
  )
}

function enrollPage(request: Request, site: SignInSite): Response {
  if (!hasAccount()) return redirectTo('/setup')
  const elsewhere = onLocalhost(request, site)
  if (elsewhere) return elsewhere
  const code = new URL(request.url).searchParams.get('code')
  if (!code)
    return page(
      'Add a device',
      `<h1>Add a device</h1>
<p>This page needs a link from the board: on a device that is signed in, open Settings, Devices, and
press Add a device.</p>`,
    )
  return page(
    'Add a device',
    `<h1>Add this device</h1>
<p>Create a passkey for ${escape(getAccount()!.name)} on this device. The link works once, for 15 minutes.</p>
<form id="form" data-flow="enrol" data-code="${escape(code)}" data-next="/">
<label for="device">This device</label>
<input id="device" name="device" required maxlength="60" placeholder="Phone, laptop…" autocomplete="off">
<button type="submit">Create passkey</button>
<p id="message" role="alert"></p>
</form>`,
  )
}

/** The sign-in page at `pathname` (one of entrance.ts SIGN_IN_PAGES) on `site`'s origin. */
export async function signInPage(request: Request, pathname: string, site: SignInSite): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  if (pathname === '/setup') return setupPage(request, site)
  if (pathname === '/login') return loginPage(request, site)
  return enrollPage(request, site)
}
