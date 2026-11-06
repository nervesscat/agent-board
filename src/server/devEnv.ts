import { loadEnv } from 'vite'

/**
 * The keys of `.env` that decide who signs in and whether the board answers through the tailnet entrance:
 * what the startup checks refuse and what the request guard reads.
 */
export const CHECKED_KEYS = ['BOARD_ENV', 'AUTH', 'PUBLIC_ORIGIN'] as const

const ADOPTED = Symbol.for('agent-board.adoptedEnv')
type Registry = Map<string, string>
const registry = () => ((globalThis as { [ADOPTED]?: Registry })[ADOPTED] ??= new Map<string, string>())

/**
 * Under `vite dev` two loaders read `.env`: Vite's loadEnv and Nitro's (c12), which writes its values
 * into process.env for the keys not already set there, for vite.config.ts's checks, src/server/startup.ts
 * and the board's runtime (config.ts, entrance.ts). They expand references differently: for an undefined
 * X, loadEnv reads `${X}` as '' and `${X:-default}` as the default, c12 keeps both as written. So, before
 * Nitro loads `.env`, this sets CHECKED_KEYS in process.env as loadEnv(mode, root, '') gives them, and
 * Nitro leaves them alone: the checks, the guard and the hosts Vite answers for (vite.config.ts
 * `allowedHosts`) all see one value. The shell's values win, as in both loaders. Every other key of
 * `.env` is still Nitro's. The built server (previews, e2e, the desktop app) reads no `.env` at all: it
 * has the environment it is started with.
 *
 * What it set is remembered for the process (`adopted`), so that when Vite restarts on an edited `.env`
 * the new values are read, not kept as if the shell had set them.
 */
export function adoptCheckedEnv(mode: string, root: string, adopted: Registry = registry()) {
  for (const [key, value] of adopted) if (process.env[key] === value) delete process.env[key]
  adopted.clear()
  const loaded = loadEnv(mode, root, '')
  for (const key of CHECKED_KEYS) {
    const value = loaded[key]
    if (value === undefined || process.env[key] !== undefined) continue
    process.env[key] = value
    adopted.set(key, value)
  }
}
