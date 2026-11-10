import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Whether this machine lets OpenCode run a subagent from inside a subagent. OpenCode allows it only when
 * its config sets `experimental.subagent_depth` above 1; without it every agent the board starts is a
 * dead end, and the Connect an agent page should say so.
 *
 * Read only: the global config (`~/.config/opencode/opencode.json` and `.jsonc`, under `XDG_CONFIG_HOME`
 * when set) and, when it is there, the project's own (`opencode.json(c)` and `.opencode/opencode.json(c)`
 * at the root of a repo). OpenCode merges those documents in that order and the *last* one that defines
 * an `experimental` block decides the depth (`findLast(...)?.info.experimental?.subagent_depth ?? 1`), so
 * a later project block without the key turns delegation off, and a later lower depth overrides an
 * earlier higher one. The deprecated top-level `subagent_depth` is only a fallback when no config defines
 * an `experimental` block. A file that cannot be read or parsed is reported, never a crash, and the
 * user's config is never written.
 */

/** The depth OpenCode uses when its config names none. */
export const DEFAULT_SUBAGENT_DEPTH = 1

export interface OpencodeConfig {
  /** The effective `subagent_depth`: the last `experimental` block's, 1 when none. */
  depth: number
  /** The document the depth came from, or (when none sets it) the config file to add it to. */
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

/** A depth OpenCode takes: a whole number of 0 or more. Fractions, negatives and strings are rejected. */
export function validDepth(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Whether a parsed document defines an `experimental` block at all (an empty or null one counts). */
export function hasExperimentalBlock(config: unknown): boolean {
  if (!isRecord(config)) return false
  return isRecord(config.experimental) || config.experimental === null
}

/**
 * The depth a document's `experimental` block sets, as OpenCode reads it: the block's own
 * `subagent_depth`, null when it names none (OpenCode then uses 1). Null too when the document has no
 * block, or the key is not a whole depth (OpenCode rejects such a document).
 */
export function experimentalDepth(config: unknown): number | null {
  if (!isRecord(config) || !isRecord(config.experimental)) return null
  return validDepth(config.experimental.subagent_depth)
}

/** The deprecated top-level `subagent_depth` a document sets, or null. */
export function deprecatedDepth(config: unknown): number | null {
  return isRecord(config) ? validDepth(config.subagent_depth) : null
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
  /** The first file that was there and read, even when it set no depth: the one to add the key to. */
  let read: string | null = null
  let error: string | null = null
  /**
   * The last document that defines an `experimental` block, and the last one that sets the deprecated
   * top-level key: OpenCode's own order, where the last document with a block wins whether or not its
   * block names a depth. The deprecated key is only used when no document has a block at all.
   */
  let block: { file: string; depth: number | null } | null = null
  let deprecated: { file: string; depth: number } | null = null
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
    const found = deprecatedDepth(config)
    if (found !== null) deprecated = { file, depth: found }
    if (hasExperimentalBlock(config)) {
      // A block whose depth is not a whole number is rejected with its document, so it does not count.
      const raw =
        isRecord(config) && isRecord(config.experimental) ? config.experimental.subagent_depth : undefined
      const depth = experimentalDepth(config)
      if (raw === undefined || depth !== null) block = { file, depth }
    }
  }
  let depth = DEFAULT_SUBAGENT_DEPTH
  let source = read ?? global[0]!
  if (block) {
    depth = block.depth ?? DEFAULT_SUBAGENT_DEPTH
    source = block.file
  } else if (deprecated) {
    depth = deprecated.depth
    source = deprecated.file
  }
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
