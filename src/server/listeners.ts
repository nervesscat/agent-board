import { execFile } from 'node:child_process'

/**
 * Where this machine's TCP listeners are: the lookup the board uses to tell whether a port (a preview's)
 * is reached from its loopback only. Moved here from linkPreview.ts, which re-exports it; linkPreview
 * imports runs.ts, so runs.ts and the preview proxy take the lookup from here instead.
 */

export const WIN = process.platform === 'win32'

export const exec = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      // lsof exits 1 when nothing matches: what it printed is still the answer.
      err && !stdout ? reject(err) : resolve(stdout),
    ),
  )

// --- who listens on a port ---

/** A process listening on a port of this machine; pid null when the OS would not say whose it is. */
export interface Listener {
  port: number
  pid: number | null
  address: string
}

// Reached from this machine's loopback: a loopback address, or every address.
const REACHED = /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|::|\*|::ffff:127\.\d+\.\d+\.\d+|::ffff:0\.0\.0\.0)$/i

export function hostPort(local: string): { host: string; port: number } | null {
  const i = local.lastIndexOf(':')
  if (i < 0) return null
  const host = local
    .slice(0, i)
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  const port = Number(local.slice(i + 1))
  return Number.isInteger(port) && port > 0 ? { host, port } : null
}

/** `netstat -ano` (IPv4 and IPv6) on Windows, as `scripts/start.mjs` reads it. */
export function parseNetstat(out: string, all = false): Listener[] {
  const found: Listener[] = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'TCP' || cols.length < 5) continue
    // The state is translated on some systems; a listening socket has no foreign end either way.
    if (cols[3] !== 'LISTENING' && !/^(0\.0\.0\.0|\[::\]):0$/.test(cols[2]!)) continue
    const at = hostPort(cols[1]!)
    const pid = Number(cols.at(-1))
    if (at && (all || REACHED.test(at.host)) && Number.isInteger(pid))
      found.push({ port: at.port, pid: pid || null, address: cols[1]! })
  }
  return found
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:8150 0.0.0.0:* users:(("node",pid=12,fd=20))`. */
export function parseSs(out: string, all = false): Listener[] {
  const found: Listener[] = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const at = hostPort(cols[3]!)
    if (!at || (!all && !REACHED.test(at.host))) continue
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    if (!pids.length) found.push({ port: at.port, pid: null, address: cols[3]! })
    for (const pid of new Set(pids)) found.push({ port: at.port, pid, address: cols[3]! })
  }
  return found
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then an `n<address>` line per socket. */
export function parseLsof(out: string, all = false): Listener[] {
  const found: Listener[] = []
  let pid: number | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null
    else if (line.startsWith('n')) {
      const at = hostPort(line.slice(1))
      if (at && (all || REACHED.test(at.host))) found.push({ port: at.port, pid, address: line.slice(1) })
    }
  }
  return found
}

/**
 * Every socket this machine listens on: those reached from its loopback (`all` false), or all of them,
 * whatever address they are bound to (`all` true: what the preview proxy checks, previewProxy.ts).
 */
async function listeningSockets(all: boolean): Promise<Listener[]> {
  if (WIN) {
    const [v4, v6] = await Promise.all([
      exec('netstat', ['-ano', '-p', 'tcp']),
      exec('netstat', ['-ano', '-p', 'tcpv6']),
    ])
    return parseNetstat(`${v4}\n${v6}`, all)
  }
  try {
    return parseSs(await exec('ss', ['-ltnpH']), all)
  } catch {
    return parseLsof(await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']).catch(() => ''), all)
  }
}

/** Every process listening on these ports, by port: one look at the whole machine. */
export async function listenersOn(ports: number[]): Promise<Map<number, Listener[]>> {
  const wanted = new Set(ports)
  const byPort = new Map<number, Listener[]>()
  if (!wanted.size) return byPort
  for (const l of await listeningSockets(false)) {
    if (!wanted.has(l.port)) continue
    const list = byPort.get(l.port) ?? []
    if (!list.some((x) => x.pid === l.pid)) list.push(l)
    byPort.set(l.port, list)
  }
  return byPort
}

/** Every address the machine listens on at this port, loopback or not (its `address`: host and port). */
export async function listeningAddresses(port: number): Promise<string[]> {
  return (await listeningSockets(true)).filter((l) => l.port === port).map((l) => l.address)
}

// --- where a port listens ---

export type Loopback = 'loopback' | 'beyond' | 'unknown'

/** Where a port listens, from the addresses the OS reports: loopback only, something beyond it, or unknown. */
export function loopbackOf(addresses: string[]): Loopback {
  if (!addresses.length) return 'unknown'
  for (const address of addresses) {
    const at = hostPort(address)
    if (!at || !isLoopbackHost(at.host)) return 'beyond'
  }
  return 'loopback'
}

export function isLoopbackHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  return h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h)
}
