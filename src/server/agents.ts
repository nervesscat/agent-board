import fs from 'node:fs/promises'
import path from 'node:path'

import { db, schema } from '#/db'
import { AGENT_CLIENTS, type AgentClient, SKILLS_TRACKING, type SkillsTracking } from '#/lib/constants'
import { config } from './config'
import { getProject, listProjects } from './projects'
import rawTemplate from './skill/board.md?raw'

// Agents get the skill with LF line endings, also from a Windows checkout where the file has CRLF.
const template = rawTemplate.replace(/\r\n/g, '\n')

// --- settings (board-wide preferences) ---

export interface Settings {
  /** The agent CLI the Connect agents page opens on. */
  defaultAgent: AgentClient
  /** The copy of the review skills the Agents pages show: `~/.claude` (global) or each repo's own. */
  skillsTracking: SkillsTracking
}

const DEFAULTS: Settings = { defaultAgent: 'claude', skillsTracking: 'global' }

export function getSettings(): Settings {
  const rows = db.select().from(schema.settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const agent = stored.defaultAgent
  const tracking = stored.skillsTracking
  return {
    defaultAgent: AGENT_CLIENTS.includes(agent as AgentClient)
      ? (agent as AgentClient)
      : DEFAULTS.defaultAgent,
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

/** Where each CLI finds the MCP server hint the skill gives when the board's tools are missing. */
const MCP_HINT: Record<AgentClient, (url: string) => string> = {
  claude: (url) =>
    `(Claude Code: \`claude mcp add --transport http --scope user board ${url}/api/mcp --header "Authorization: Bearer gate_…"\`.)`,
  codex: () => '(Codex: a `[mcp_servers.board]` entry in `~/.codex/config.toml`.)',
  opencode: () => '(OpenCode: an `mcp.board` entry in `~/.config/opencode/opencode.json`.)',
}

const cell = (s: string) => s.replace(/\|/g, '\\|')
const folderOf = (repoPath: string) =>
  repoPath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || repoPath

/** Every repo the board knows, with the ids an agent needs: the skill's lookup table. */
export function projectTable(): string {
  const rows = listProjects().flatMap((p) =>
    p.repos.map((r) => [
      `\`${cell(folderOf(r.repoPath))}\``,
      r.githubRepo ? `\`${cell(r.githubRepo)}\`` : '—',
      `\`${cell(r.repoPath)}\``,
      `\`${cell(p.name)}\``,
      String(p.id),
      String(r.id),
    ]),
  )
  if (!rows.length) return '_No repos on the board yet._'
  const head = ['Folder', 'GitHub', 'Checkout', 'Project', 'projectId', 'repoId']
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
}

/** The SKILL.md for `client`: the same instructions for every CLI, with today's projects and repos. */
export function renderSkill(client: AgentClient): string {
  const url = config.boardUrl
  return template
    .replaceAll('{{BOARD_URL}}', url)
    .replace('{{MCP_HINT}}', MCP_HINT[client](url))
    .replace('{{PROJECT_TABLE}}', projectTable())
}

/** What the Connect agents page builds its commands from. */
export function agentSetup() {
  return { boardUrl: config.boardUrl, gateUrl: config.gateUrl, settings: getSettings() }
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
  status: RepoSkillsStatus
  files: SkillFiles
}

const lf = (text: string) => text.replace(/\r\n/g, '\n')

async function fileStatus(file: string, want: string): Promise<SkillFileStatus> {
  try {
    return lf(await fs.readFile(file, 'utf8')) === lf(want) ? 'current' : 'outdated'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Anything else (a folder in its place, no permission) is there but not the bundle's file.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'outdated'
  }
}

/** The bundle as found in one `.claude` folder: only the bundle's paths are read, never a write. */
async function claudeSkills(claudeDir: string): Promise<{ status: RepoSkillsStatus; files: SkillFiles }> {
  const files = await Promise.all(
    reviewBundlePaths().map(async (p) => ({
      path: p,
      status: await fileStatus(path.join(claudeDir, ...p.split('/')), reviewFiles[`./skill/review/${p}`]!),
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
  const absent = await fs.stat(dir).then(
    () => false,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR',
  )
  if (!absent && !(await readableDir(dir))) return { path: dir, status: 'unreachable', files: [] }
  return { path: dir, ...(await claudeSkills(dir)) }
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
