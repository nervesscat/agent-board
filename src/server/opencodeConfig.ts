import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Whether this machine lets OpenCode run a subagent from inside a subagent. OpenCode allows it only when
 * its config sets `experimental.subagent_depth` above 1; without it every agent the board starts is a
 * dead end, and the Connect an agent page should say so.
 *
 * Read only, in OpenCode v2.2.5's order: the global config (`~/.config/opencode/opencode.json(c)`, under
 * `XDG_CONFIG_HOME` when set), then `$OPENCODE_CONFIG` when set, then every project directory from the
 * filesystem root down to each repo (`opencode.json(c)`, then `.opencode/opencode.json(c)`), then the
 * system-wide config (`/etc/opencode`, `%ProgramData%\opencode` on Windows, `/Library/Application
 * Support/opencode` on macOS). The *last* document that defines an `experimental` block decides the
 * depth (`findLast(...)?.info.experimental?.subagent_depth ?? 1`), so a later block without the key
 * turns delegation off, and a later lower depth overrides an earlier higher one; the system-wide config
 * therefore outranks global and project files. The deprecated top-level `subagent_depth` is no longer
 * read by OpenCode (v2.2.5 drops it as an unsupported legacy setting), so it never turns delegation on;
 * the check reports the document that still sets it, so the human can move it where OpenCode reads it. A
 * file that cannot be read or parsed is reported, never a crash, and the user's config is never written.
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
  /**
   * The last document that sets the deprecated top-level `subagent_depth`, which OpenCode no longer reads;
   * null when none does. The card says so, since the key looks like configuration but has no effect.
   */
  ignoredDeprecated: string | null
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

/** Whether a document still sets the deprecated top-level `subagent_depth` (OpenCode ignores it). */
export function hasDeprecatedKey(config: unknown): boolean {
  return isRecord(config) && 'subagent_depth' in config
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

/** The global OpenCode config files, in the order they are read (lowest precedence). */
export function globalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const configHome = env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config')
  const dir = path.join(configHome, 'opencode')
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')]
}

/**
 * OpenCode's system-wide config directory, which outranks global and project config. Windows reads it
 * from `%ProgramData%\opencode` (`C:\ProgramData` when that variable is not set); macOS from
 * `/Library/Application Support/opencode`; everything else from `/etc/opencode`.
 */
export function systemConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32')
    return path.win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'opencode')
  if (platform === 'darwin') return '/Library/Application Support/opencode'
  return '/etc/opencode'
}

/** The files a config directory holds, in OpenCode's order: `.json` then `.jsonc`. */
const configDirFiles = (dir: string): string[] => [
  path.join(dir, 'opencode.json'),
  path.join(dir, 'opencode.jsonc'),
]

export const systemConfigFiles = (systemDir: string): string[] => configDirFiles(systemDir)

/**
 * A checkout and every directory above it, from the filesystem root down to the checkout. OpenCode
 * walks up from the directory it runs in, so a config farther up is read first and a closer one wins.
 */
export function ancestorDirs(start: string): string[] {
  const dirs: string[] = []
  let dir = path.resolve(start)
  for (;;) {
    dirs.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs.reverse()
}

/**
 * The config files OpenCode reads for a checkout, in its order: every ancestor's `opencode.json` then
 * `.jsonc` (farthest to closest first), then every ancestor's `.opencode/opencode.json` then `.jsonc`.
 * A file config of any ancestor comes before the `.opencode` directory configs.
 */
export function projectConfigFiles(repoDir: string): string[] {
  const dirs = ancestorDirs(repoDir)
  return [
    ...dirs.flatMap((dir) => configDirFiles(dir)),
    ...dirs.flatMap((dir) => configDirFiles(path.join(dir, '.opencode'))),
  ]
}

export interface ReadOptions {
  env?: NodeJS.ProcessEnv
  /** The checkouts to read project configs for (the board's repos). */
  projectDirs?: string[]
  /** The platform the system config path is built for (tests stub it); the running one by default. */
  platform?: NodeJS.Platform
  /**
   * The system-wide config directory; the platform's by default. Tests pass a folder of their own (or
   * null to skip it) so they never read the machine's `/etc/opencode`.
   */
  systemDir?: string | null
}

/** Reads the config files and answers the effective depth. Never throws on a file. */
export function readOpencodeConfig({
  env = process.env,
  projectDirs = [],
  platform = process.platform,
  systemDir,
}: ReadOptions = {}): OpencodeConfig {
  const global = globalConfigFiles(env)
  // OpenCode loads $OPENCODE_CONFIG (a file) right after the global user config and before any project
  // config (Config.load: global, explicit, project direct files, project .opencode dirs, then system).
  const explicit = env.OPENCODE_CONFIG?.trim() ? path.resolve(env.OPENCODE_CONFIG.trim()) : null
  const system = systemDir === undefined ? systemConfigDir(platform, env) : systemDir
  // System-wide config is read last: it outranks global and project config.
  const files = [
    ...new Set([
      ...global,
      ...(explicit ? [explicit] : []),
      ...projectDirs.flatMap(projectConfigFiles),
      ...(system ? systemConfigFiles(system) : []),
    ]),
  ]
  /** The first file that was there and read, even when it set no depth: the one to add the key to. */
  let read: string | null = null
  let error: string | null = null
  /**
   * The last document that defines an `experimental` block: OpenCode's own order, where the last document
   * with a block wins whether or not its block names a depth. The deprecated top-level key is ignored
   * (`ignoredDeprecated` keeps where it was set, to say so on the card).
   */
  let block: { file: string; depth: number | null } | null = null
  let ignoredDeprecated: string | null = null
  for (const file of files) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // Missing is the normal state of a config nobody wrote; so is a config folder that is not there,
      // or a file where a folder should be (OpenCode skips both). Anything else is worth saying.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && error === null)
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
    if (hasDeprecatedKey(config)) ignoredDeprecated = file
    if (hasExperimentalBlock(config)) {
      // A block whose depth is not a whole number is rejected with its document, so it does not count.
      const raw =
        isRecord(config) && isRecord(config.experimental) ? config.experimental.subagent_depth : undefined
      const depth = experimentalDepth(config)
      if (raw === undefined || depth !== null) block = { file, depth }
    }
  }
  // OpenCode no longer reads the deprecated top-level key, so only a block can turn delegation on.
  const depth = block ? (block.depth ?? DEFAULT_SUBAGENT_DEPTH) : DEFAULT_SUBAGENT_DEPTH
  const source = block ? block.file : (read ?? global[0]!)
  return {
    depth,
    source,
    set: depth > 1,
    checkedAt: new Date().toISOString(),
    error,
    ignoredDeprecated,
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
export function checkOpencodeConfig(
  projectDirs: string[] = kept.projectDirs,
  options: Omit<ReadOptions, 'projectDirs'> = {},
): OpencodeConfig {
  const next = readOpencodeConfig({ projectDirs, ...options })
  kept.last = next
  kept.projectDirs = projectDirs
  return next
}

/** The last check, or a new one when none ran yet. */
export const readyOpencodeConfig = (
  projectDirs: string[] = kept.projectDirs,
  options: Omit<ReadOptions, 'projectDirs'> = {},
): OpencodeConfig => kept.last ?? checkOpencodeConfig(projectDirs, options)

/** Tests: set the kept result (null forgets it). */
export function setOpencodeConfig(config: OpencodeConfig | null) {
  kept.last = config
}
