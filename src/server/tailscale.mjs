// The Tailscale CLI, as the board and `pnpm tailnet` read it (README: "Using it from other devices"). Only
// reads run here, and only these: no `serve`, no `funnel`, no `up`. The board shows the `tailscale serve`
// command and never runs it, and this module has no way to. TAILSCALE_BIN names the CLI (default
// `tailscale`; a .mjs or .js file runs with node), which the tests stand in for.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'

/** Everything this module asks Tailscale, and nothing else. */
export const READS = Object.freeze([
  'version',
  'status --json',
  'serve status --json',
  'funnel status --json',
])

const TIMEOUT_MS = 20_000

export function tailscaleBin() {
  return process.env.TAILSCALE_BIN || 'tailscale'
}

/**
 * The program and arguments that run `tailscale <args>`. Throws unless `args` is one of READS. A script
 * (.mjs or .js) that is not there fails as a missing program does: code ENOENT, as spawn gives it.
 */
export function tailscaleCommand(args) {
  if (!READS.includes(args.join(' '))) throw new Error(`tailscale ${args.join(' ')} is not a read: refused`)
  const bin = tailscaleBin()
  if (!/\.[cm]?js$/i.test(bin)) return [bin, args]
  if (!fs.existsSync(bin)) throw Object.assign(new Error(`${bin}: no such file`), { code: 'ENOENT' })
  return [process.execPath, [bin, ...args]]
}

/** What `tailscale <args>` prints, run now; throws (with `code` and `stderr`) when it fails. */
export function tailscaleSync(...args) {
  const [file, argv] = tailscaleCommand(args)
  return execFileSync(file, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    windowsHide: true,
  })
}

/** The same, asynchronously. A missing CLI fails with `code` ENOENT. */
export function tailscaleAsync(...args) {
  return new Promise((resolve, reject) => {
    let command
    try {
      command = tailscaleCommand(args)
    } catch (err) {
      reject(err)
      return
    }
    const [file, argv] = command
    execFile(
      file,
      argv,
      { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }))
        else resolve(stdout)
      },
    )
  })
}

/** A JSON answer parsed (an empty one is an empty object, as an empty serve config is); throws when it is not JSON. */
export function parseTailscaleJson(out, args) {
  const text = out.trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`tailscale ${args.join(' ')} did not print JSON:\n${text.slice(0, 400)}`)
  }
}

/** Every host:port a serve config lets Funnel put on the internet, its foreground sessions included. */
export function funnelled(config) {
  const on = []
  const scan = (part, where) => {
    for (const [hostPort, allowed] of Object.entries(part?.AllowFunnel ?? {}))
      if (allowed === true) on.push({ hostPort, where })
  }
  scan(config, null)
  for (const [session, part] of Object.entries(config?.Foreground ?? {})) scan(part, session)
  return on
}

/** What a serve config already sends https://<name>:<port>/ to, if anything. */
export function servedAt(config, name, port) {
  const handler = config?.Web?.[`${name}:${port}`]?.Handlers?.['/']
  return handler?.Proxy ?? handler?.Path ?? handler?.Text ?? null
}
