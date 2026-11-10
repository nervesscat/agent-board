import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Whether this machine lets OpenCode run a subagent from inside a subagent. OpenCode allows it only when
 * its config sets `experimental.subagent_depth` above 1 (the top-level `subagent_depth` key is deprecated
 * but still read); without it every agent the board starts is a dead end, and the Connect an agent page
 * should say so.
 *
 * Read only: the global config (`~/.config/opencode/opencode.json` and `.jsonc`, under `XDG_CONFIG_HOME`
 * when set) and, when it is there, the project's own (`opencode.json(c)` and `.opencode/opencode.json(c)`
 * at the root of a repo). The effective depth is the highest one found, 1 when none is. A file that
 * cannot be read or parsed is reported, never a crash, and the user's config is never written.
 */

/** The depth OpenCode uses when its config names none. */
export const DEFAULT_SUBAGENT_DEPTH = 1

export interface OpencodeConfig {
  /** The effective `subagent_depth`: the highest found, 1 when none. */
  depth: number
  /** The file the depth came from, or (when none sets it) the global file to add it to. */
  source: string
  /** Whether a subagent can start another: `depth` above 1. */
  set: boolean
  /** When the check ran. */
  checkedAt: string
  /** The first config file that could not be read or parsed, or null when every one there was readable. */
  error: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The depth a parsed config sets: `experimental.subagent_depth`, else the deprecated top-level
 * `subagent_depth`. Null when it sets neither (or sets something that is not a whole depth).
 */
export function subagentDepth(config: unknown): number | null {
  if (!isRecord(config)) return null
  const experimental = isRecord(config.experimental) ? config.experimental : null
  const value = experimental?.subagent_depth ?? config.subagent_depth
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

/**
 * JSONC as JSON: `//` and block comments and trailing commas are dropped, inside strings never. A file
 * OpenCode accepts this way parses here too.
 */
export function parseJsonc(text: string): unknown {
  const source = text.replace(/^\uFEFF/, '')
  let out = ''
  let i = 0
  const n = source.length
  /** Where a comma or a comment's end really leads: the next character that is neither blank nor comment. */
  const meaningful = (start: number): number => {
    let j = start
    while (j < n) {
      const c = source[j]!
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        j++
      } else if (c === '/' && source[j + 1] === '/') {
        j += 2
        while (j < n && source[j] !== '\n') j++
      } else if (c === '/' && source[j + 1] === '*') {
        const end = source.indexOf('*/', j + 2)
        j = end === -1 ? n : end + 2
      } else {
        return j
      }
    }
    return n
  }
  while (i < n) {
    const c = source[i]!
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') j += 2
        else if (source[j] === '"') {
          j++
          break
        } else j++
      }
      out += source.slice(i, j)
      i = j
    } else if (c === '/' && source[i + 1] === '/') {
      i += 2
      while (i < n && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (c === ',') {
      // A comma whose next real character closes the object or array is trailing: JSON rejects it.
      const next = meaningful(i + 1)
      if (source[next] === '}' || source[next] === ']') i++
      else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out)
}

/** The global OpenCode config files, in the order they are read. */
export function globalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const configHome = env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config')
  const dir = path.join(configHome, 'opencode')
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')]
}

/** The project config files of a checkout: OpenCode reads both the root and `.opencode`. */
export function projectConfigFiles(repoDir: string): string[] {
  return [
    path.join(repoDir, 'opencode.json'),
    path.join(repoDir, 'opencode.jsonc'),
    path.join(repoDir, '.opencode', 'opencode.json'),
    path.join(repoDir, '.opencode', 'opencode.jsonc'),
  ]
}

export interface ReadOptions {
  env?: NodeJS.ProcessEnv
  /** The checkouts to read a project config from (the board's repos). */
  projectDirs?: string[]
}

/** Reads the config files and answers the effective depth. Never throws on a file. */
export function readOpencodeConfig({
  env = process.env,
  projectDirs = [],
}: ReadOptions = {}): OpencodeConfig {
  const global = globalConfigFiles(env)
  const files = [...global, ...projectDirs.flatMap(projectConfigFiles)]
  let depth = DEFAULT_SUBAGENT_DEPTH
  let source = global[0]!
  /** The first file that was there and read, even when it set no depth: the one to add the key to. */
  let read: string | null = null
  let error: string | null = null
  for (const file of files) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // Missing is the normal state of a config nobody wrote; anything else is worth saying.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && error === null)
        error = `Could not read ${file}: ${(err as Error).message}`
      continue
    }
    read ??= file
    let config: unknown
    try {
      config = parseJsonc(text)
    } catch (err) {
      if (error === null) error = `Could not parse ${file}: ${(err as Error).message}`
      continue
    }
    const found = subagentDepth(config)
    if (found !== null && found > depth) {
      depth = found
      source = file
    }
  }
  // Nothing sets a depth above 1: name the config it read, else the global file to create.
  if (depth === DEFAULT_SUBAGENT_DEPTH && read !== null) source = read
  return {
    depth,
    source,
    set: depth > 1,
    checkedAt: new Date().toISOString(),
    error,
  }
}

// --- the last check, while the server runs ---

interface Kept {
  last: OpencodeConfig | null
  /** The checkouts the last check read, reused when a check is asked for without any. */
  projectDirs: string[]
}

/** Outside the module, like the host tools: a hot reload must not forget the check the server started with. */
const KEPT = Symbol.for('agent-board.opencodeConfig')
const kept = ((globalThis as { [KEPT]?: Kept })[KEPT] ??= { last: null, projectDirs: [] })

/** The last check, or null before the first one. */
export const opencodeConfig = (): OpencodeConfig | null => kept.last

/** Reads the config again and keeps the result. */
export function checkOpencodeConfig(projectDirs: string[] = kept.projectDirs): OpencodeConfig {
  const next = readOpencodeConfig({ projectDirs })
  kept.last = next
  kept.projectDirs = projectDirs
  return next
}

/** The last check, or a new one when none ran yet. */
export const readyOpencodeConfig = (projectDirs: string[] = kept.projectDirs): OpencodeConfig =>
  kept.last ?? checkOpencodeConfig(projectDirs)

/** Tests: set the kept result (null forgets it). */
export function setOpencodeConfig(config: OpencodeConfig | null) {
  kept.last = config
}
