import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { db, schema } from '#/db'
import {
  AGENT_CLIENTS,
  type AgentClient,
  PREVIEW_LIMIT,
  readPreviewLimit,
  SKILLS_TRACKING,
  type SkillsTracking,
} from '#/lib/constants'
import { type DiffHunk, diffLines } from '#/lib/hunks'
import { config } from './config'
import { HttpError, notFound } from './http'
import { readyOpencodeConfig } from './opencodeConfig'
import { getProject, listProjects } from './projects'
import { getRepo } from './repos'
import rawTemplate from './skill/board.md?raw'
import rawSessionSkill from './skill/session.md?raw'
import boardMcpScript from '../../scripts/board-mcp.mjs?raw'
import boardBeatScript from '../../scripts/board-beat.mjs?raw'
import { restSection } from './skill/rest'

// Agents get the skill with LF line endings, also from a Windows checkout where the file has CRLF.
const template = rawTemplate.replace(/\r\n/g, '\n')
const sessionTemplate = rawSessionSkill.replace(/\r\n/g, '\n')

/**
 * The session skill (`/session`): the protocol for the agent in the human's conversation. One text for
 * every client, with no tokens to fill in, so it is served as it is.
 */
export const sessionSkill = () => sessionTemplate

// --- settings (board-wide preferences) ---

export interface Settings {
  /** The agent CLI the Connect an agent page opens on. */
  defaultAgent: AgentClient
  /** How many previews the board builds or runs at once, board-wide (`PREVIEW_LIMIT`). */
  previewLimit: number
  /** The copy of the review skills the Connect an agent page shows: `~/.claude` (global) or each repo's own. */
  skillsTracking: SkillsTracking
}

const DEFAULTS: Settings = {
  defaultAgent: 'claude',
  previewLimit: PREVIEW_LIMIT.default,
  skillsTracking: 'global',
}

export function getSettings(): Settings {
  const rows = db.select().from(schema.settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const agent = stored.defaultAgent
  const tracking = stored.skillsTracking
  return {
    defaultAgent: AGENT_CLIENTS.includes(agent as AgentClient)
      ? (agent as AgentClient)
      : DEFAULTS.defaultAgent,
    previewLimit: readPreviewLimit(stored.previewLimit),
    skillsTracking: SKILLS_TRACKING.includes(tracking as SkillsTracking)
      ? (tracking as SkillsTracking)
      : DEFAULTS.skillsTracking,
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    db.insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run()
  }
  return getSettings()
}

// --- the board skill, rendered for one agent CLI ---

/**
 * Where each CLI finds the MCP server hint the skill gives when the board's tools are missing. `<token>`
 * stays a placeholder: the skill is the same file for every agent, and Connect an agent's commands carry
 * the token itself.
 */
const MCP_HINT: Record<AgentClient, (url: string) => string> = {
  claude: (url) =>
    `(Claude Code: \`claude mcp add --transport http --scope user board ${url}/api/mcp --header "Authorization: Bearer <token>"\`.)`,
  codex: () => '(Codex: a `[mcp_servers.board]` entry in `~/.codex/config.toml`.)',
  opencode: () => '(OpenCode: an `mcp.board` entry in `~/.config/opencode/opencode.json`.)',
}

/**
 * The SKILL.md for `client`: the same instructions for every CLI. It carries no projects or repos: an
 * agent asks the board for its own (`find_project`), so a copy stays right as the board changes.
 */
export function renderSkill(
  client: AgentClient,
  transport: SkillTransport = 'mcp',
  url: string = config.boardUrl,
): string {
  if (transport === 'mcp')
    return template.replaceAll('{{BOARD_URL}}', url).replace('{{MCP_HINT}}', MCP_HINT[client](url))
  // The same skill for a session without the MCP tools: each tool named stays, its route is in the table.
  const rest = template
    .replace('MCP server "board")', 'REST API, no MCP tools)')
    .replace(
      /Its tools come from the `board` MCP\nserver\.[^]*?If they are missing, or the board answers 401/,
      "This copy is for a session without the `board` MCP\ntools: wherever it names a tool, call that tool's REST route (Without the board's MCP tools: REST,\nbelow). If the board answers 401",
    )
    .replace(' {{MCP_HINT}}', '')
    .replace(
      '\n## Keep the board out of the repo\n',
      () => `\n${restSection('{{BOARD_URL}}')}\n## Keep the board out of the repo\n`,
    )
  return rest.replaceAll('{{BOARD_URL}}', url)
}

export const SKILL_TRANSPORTS = ['mcp', 'rest'] as const
export type SkillTransport = (typeof SKILL_TRANSPORTS)[number]

/** `scripts/board-mcp.mjs`: the board's MCP tools over stdio, for a client that reaches the board through a proxy. */
export const boardMcpBridge = (): string => boardMcpScript.replace(/\r\n/g, '\n')

/** `scripts/board-beat.mjs`: the runtime beater that keeps a long tool call's lease alive. */
export const boardBeat = (): string => boardBeatScript.replace(/\r\n/g, '\n')

/** What the Connect an agent page builds its commands from, and OpenCode's subagent depth. */
export function agentSetup(projectDirs: string[] = []) {
  return { boardUrl: config.boardUrl, settings: getSettings(), opencode: readyOpencodeConfig(projectDirs) }
}

// --- the review skills: feature-review, review-queue, todo-review and their agents, installed as one tar ---

const reviewFiles = import.meta.glob<string>('./skill/review/{skills,agents}/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Paths under ~/.claude, as the tar lays them out. */
export const reviewBundlePaths = () =>
  Object.keys(reviewFiles)
    .map((k) => k.replace('./skill/review/', ''))
    .sort()

/** A ustar archive of the review bundle, to extract into ~/.claude (tar ships with Windows too). */
export function reviewBundle(): Buffer {
  const blocks: Buffer[] = []
  const now = Math.floor(Date.now() / 1000)
  for (const [key, text] of Object.entries(reviewFiles).sort(([a], [b]) => a.localeCompare(b))) {
    const name = key.replace('./skill/review/', '')
    const body = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(512)
    const put = (value: string, at: number, len: number) => header.write(value, at, len, 'ascii')
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0'
    put(name, 0, 100)
    put(octal(name.endsWith('.py') ? 0o755 : 0o644, 8), 100, 8)
    put(octal(0, 8), 108, 8)
    put(octal(0, 8), 116, 8)
    put(octal(body.length, 12), 124, 12)
    put(octal(now, 12), 136, 12)
    put('        ', 148, 8)
    put('0', 156, 1)
    put('ustar\0', 257, 6)
    put('00', 263, 2)
    let sum = 0
    for (const b of header) sum += b
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

// --- the review skills as installed: the user-wide ~/.claude and each repo's own .claude ---

/** A bundle file in a .claude folder: the same as the bundle's (line endings aside), different, or not there. */
export type SkillFileStatus = 'current' | 'outdated' | 'missing'
/**
 * A copy of the bundle: `none` when its .claude has no bundle file (a repo then relies on the user-wide
 * install), `current` when every file matches, `outdated` when some are there and any differs or is
 * missing, `unreachable` when the checkout (or the user-wide folder) cannot be read.
 */
export type RepoSkillsStatus = 'none' | 'current' | 'outdated' | 'unreachable'

type SkillFiles = { path: string; status: SkillFileStatus }[]

export interface RepoSkills {
  repoId: number
  repoName: string
  projectId: number
  projectName: string
  repoPath: string
  status: RepoSkillsStatus
  files: SkillFiles
}

/** The user-wide copy: the `.claude` folder in the home of the machine the board runs on. */
export interface GlobalSkills {
  path: string
  /**
   * The folder its install line puts the bundle in: `path` when CLAUDE_HOME names another folder than
   * `~/.claude`, null when it is `~/.claude` (the line then says `~/.claude`).
   */
  installTo: string | null
  status: RepoSkillsStatus
  files: SkillFiles
}

const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** The bundle's own copy of one of its paths, as the board serves it. */
const served = (p: string) => reviewFiles[`./skill/review/${p}`]!

/** A bundle file in a .claude folder: its text, not there, or there but not readable as text (and why). */
type Installed = { text: string } | { missing: true } | { unreadable: string }

async function readInstalled(file: string): Promise<Installed> {
  try {
    return { text: await fs.readFile(file, 'utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true }
    if (code === 'EISDIR') return { unreadable: 'a folder is in its place' }
    if (code === 'EACCES' || code === 'EPERM') return { unreadable: 'no permission to read it' }
    return { unreadable: code ?? (err as Error).message }
  }
}

function statusOf(installed: Installed, want: string): SkillFileStatus {
  if ('missing' in installed) return 'missing'
  // Anything there that cannot be read (a folder in its place, no permission) is not the bundle's file.
  if ('unreadable' in installed) return 'outdated'
  return lf(installed.text) === lf(want) ? 'current' : 'outdated'
}

async function fileStatus(file: string, want: string): Promise<SkillFileStatus> {
  return statusOf(await readInstalled(file), want)
}

/** The bundle as found in one `.claude` folder: only the bundle's paths are read, never a write. */
async function claudeSkills(claudeDir: string): Promise<{ status: RepoSkillsStatus; files: SkillFiles }> {
  const files = await Promise.all(
    reviewBundlePaths().map(async (p) => ({
      path: p,
      status: await fileStatus(path.join(claudeDir, ...p.split('/')), served(p)),
    })),
  )
  const status = files.every((f) => f.status === 'missing')
    ? 'none'
    : files.every((f) => f.status === 'current')
      ? 'current'
      : 'outdated'
  return { status, files }
}

/** A folder that is there and can be listed. */
async function readableDir(dir: string) {
  try {
    if (!(await fs.stat(dir)).isDirectory()) return false
    await fs.access(dir, fs.constants.R_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** One repo's copy of the bundle, read from `<repoPath>/.claude`. */
async function repoSkills(repoPath: string): Promise<Pick<RepoSkills, 'status' | 'files'>> {
  if (!(await readableDir(repoPath))) return { status: 'unreachable', files: [] }
  return claudeSkills(path.join(repoPath, '.claude'))
}

/**
 * The user-wide copy, read from `config.claudeHome` (`~/.claude` unless CLAUDE_HOME says otherwise). No
 * folder at all is `none`, as is a folder without the bundle; one that is there but cannot be read is
 * `unreachable`.
 */
async function globalSkills(): Promise<GlobalSkills> {
  const dir = config.claudeHome
  // `~/.claude` of the user the board runs as (Windows compares the two without case).
  const installTo = path.relative(dir, path.join(os.homedir(), '.claude')) === '' ? null : dir
  if (!(await globalReadable())) return { path: dir, installTo, status: 'unreachable', files: [] }
  return { path: dir, installTo, ...(await claudeSkills(dir)) }
}

/** Whether the user-wide folder can be read: there and listable, or not there at all. */
async function globalReadable() {
  const dir = config.claudeHome
  const absent = await fs.stat(dir).then(
    () => false,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR',
  )
  return absent || readableDir(dir)
}

/**
 * Whether the review bundle the board serves now is installed: in the user-wide `~/.claude` of this
 * machine (`global`), and in each repo's own `.claude` folder (every repo on the board, or one
 * project's). Read from disk each time it is asked.
 */
export async function reviewSkillsStatus(projectId?: number) {
  if (projectId !== undefined) getProject(projectId)
  const repos = listProjects()
    .filter((p) => projectId === undefined || p.id === projectId)
    .flatMap((p) => p.repos.map((r) => ({ r, p })))
  return {
    files: reviewBundlePaths(),
    global: await globalSkills(),
    repos: await Promise.all(
      repos.map(
        async ({ r, p }): Promise<RepoSkills> => ({
          repoId: r.id,
          repoName: r.name,
          projectId: p.id,
          projectName: p.name,
          repoPath: r.repoPath,
          ...(await repoSkills(r.repoPath)),
        }),
      ),
    ),
  }
}

export type ReviewSkillsStatus = Awaited<ReturnType<typeof reviewSkillsStatus>>

/** One bundle file as installed against the copy the board serves now, as `git diff` shows it. */
export interface SkillFileDiff {
  /** The bundle path. */
  path: string
  /** The same as the status gives this file. */
  status: SkillFileStatus
  /** Where the installed copy is, or would be: the old side. */
  installed: string
  /** Why the installed copy can't be read as text (a folder in its place, no permission), else null. */
  unreadable: string | null
  /** The old side and the new: `--- a/<installed>` (`--- /dev/null` when missing) and `+++ b/<path>`. */
  header: [string, string]
  /** What installing the bundle would change in the file, line endings aside: none when current or unreadable. */
  hunks: DiffHunk[]
}

/**
 * One file of the review bundle (`file`: exactly one of `reviewBundlePaths()`) as installed in `~/.claude`
 * (`config.claudeHome`) or in the repo `repoId`'s own `.claude`, against the copy the board serves: what
 * the install line would change in it. Compared as the status compares it, read from disk each time, never
 * a write.
 */
export async function reviewSkillDiff(file: string, repoId?: number): Promise<SkillFileDiff> {
  // Only the bundle's own paths: any other string is refused before anything is read.
  if (!reviewBundlePaths().includes(file)) throw notFound('review skills file')
  let claudeDir: string
  if (repoId === undefined) {
    if (!(await globalReadable())) throw new HttpError(409, `can't read the folder ${config.claudeHome}`)
    claudeDir = config.claudeHome
  } else {
    const repo = getRepo(repoId)
    if (!(await readableDir(repo.repoPath)))
      throw new HttpError(409, `can't read the checkout at ${repo.repoPath}`)
    claudeDir = path.join(repo.repoPath, '.claude')
  }
  const installedPath = path.join(claudeDir, ...file.split('/'))
  const installed = await readInstalled(installedPath)
  const want = served(file)
  const status = statusOf(installed, want)
  return {
    path: file,
    status,
    installed: installedPath,
    unreadable: 'unreadable' in installed ? installed.unreadable : null,
    header: [
      'missing' in installed ? '--- /dev/null' : `--- a/${installedPath.replace(/^\/+/, '')}`,
      `+++ b/${file} (served by the board)`,
    ],
    hunks:
      status !== 'current' && !('unreadable' in installed)
        ? diffLines('text' in installed ? lf(installed.text) : '', lf(want))
        : [],
  }
}

// --- installing them on this machine: the board skill under the home it runs as, the bundle in CLAUDE_HOME ---

/** What an install did to one file: made it, wrote it over, or found it as served already. */
export type InstallAction = 'created' | 'updated' | 'unchanged'

export interface InstalledFile {
  /** Where the file is: absolute, under the home the board runs as or CLAUDE_HOME. */
  path: string
  action: InstallAction
}

/** What one install wrote: when it ran, and every file with what it did. */
export interface InstallResult {
  at: string
  files: InstalledFile[]
}

/** Where each CLI keeps its user-wide skills, under its home. */
const SKILL_FOLDERS: Record<AgentClient, string[]> = {
  claude: ['.claude', 'skills', 'board'],
  codex: ['.agents', 'skills', 'board'],
  opencode: ['.config', 'opencode', 'skills', 'board'],
}

/** A Windows home (drive letter or UNC share), whose folders keep their backslashes. */
const windowsHome = /^[A-Za-z]:[\\/]|^\\\\/

/**
 * The folder a CLI's SKILL.md goes in on this machine, from its home (`os.homedir`, never the `~` the
 * page shows): `/home/me/.claude/skills/board`, or `C:\Users\me\.claude\skills\board` for a Windows home.
 */
export function skillDir(client: AgentClient, home = os.homedir()): string {
  const folders = SKILL_FOLDERS[client]
  if (!windowsHome.test(home)) return path.join(home, ...folders)
  const sep = home.includes('\\') ? '\\' : '/'
  return `${home.replace(/[\\/]+$/, '')}${sep}${folders.join(sep)}`
}

let tempFiles = 0
/** A name beside `target` for the text on its way to it, so it is renamed over whole, never half written. */
const tempName = (target: string) =>
  path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${++tempFiles}.tmp`)

/**
 * Writes one file as the board serves it: its folder made when it is missing, the text to a temporary name
 * beside it and renamed over the target (a reader never sees half a file), and no shell anywhere. A file
 * already holding that text (line endings aside) is left as it is. A folder that cannot be made or written
 * is a 500 naming the file it was writing, and leaves the earlier copy as it was.
 */
async function installFile(target: string, text: string): Promise<InstallAction> {
  let installed: string | null = null
  try {
    installed = await fs.readFile(target, 'utf8')
  } catch {
    // Not a file that can be read (missing, a folder in its place, no permission): write it, and let the
    // write below say why if it cannot.
  }
  if (installed !== null && lf(installed) === lf(text)) return 'unchanged'
  const temp = tempName(target)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, text, 'utf8')
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    const code = (err as NodeJS.ErrnoException).code
    throw new HttpError(500, `could not install ${target}: ${code ?? (err as Error).message}`)
  }
  return installed === null ? 'created' : 'updated'
}

/** Writes the board skill for `client` into its own folder under `home` on this machine, as served. */
export async function installSkill(client: AgentClient, home = os.homedir()): Promise<InstallResult> {
  const at = new Date().toISOString()
  const file = path.join(skillDir(client, home), 'SKILL.md')
  return { at, files: [{ path: file, action: await installFile(file, renderSkill(client)) }] }
}

/**
 * Writes the review bundle into `config.claudeHome` (`CLAUDE_HOME`, `~/.claude` unless it names another
 * folder), every path of `reviewBundlePaths()` with the bytes the tar holds, replacing files of the same name.
 */
export async function installReviewSkills(): Promise<InstallResult> {
  const at = new Date().toISOString()
  const files: InstalledFile[] = []
  for (const p of reviewBundlePaths()) {
    const file = path.join(config.claudeHome, ...p.split('/'))
    files.push({ path: file, action: await installFile(file, served(p)) })
  }
  return { at, files }
}
