import fs from 'node:fs/promises'
import path from 'node:path'

import { db, schema } from '#/db'
import { AGENT_CLIENTS, type AgentClient } from '#/lib/constants'
import { config } from './config'
import { getProject, listProjects } from './projects'
import rawTemplate from './skill/board.md?raw'

// Agents get the skill with LF line endings, also from a Windows checkout where the file has CRLF.
const template = rawTemplate.replace(/\r\n/g, '\n')

// --- settings (board-wide preferences) ---

export interface Settings {
  /** The agent CLI the Connect agents page opens on. */
  defaultAgent: AgentClient
}

const DEFAULTS: Settings = { defaultAgent: 'claude' }

export function getSettings(): Settings {
  const rows = db.select().from(schema.settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const agent = stored.defaultAgent
  return {
    defaultAgent: AGENT_CLIENTS.includes(agent as AgentClient)
      ? (agent as AgentClient)
      : DEFAULTS.defaultAgent,
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

// --- the review skills in each repo: the copies under <repo>/.claude, compared with the bundle ---

/** A bundle file in a repo: the same as the bundle's (line endings aside), different, or not there. */
export type SkillFileStatus = 'current' | 'outdated' | 'missing'
/**
 * A repo's copy of the bundle: `none` when it has no bundle file (it relies on the user-wide install),
 * `current` when every file matches, `outdated` when some are there and any differs or is missing,
 * `unreachable` when its checkout cannot be read.
 */
export type RepoSkillsStatus = 'none' | 'current' | 'outdated' | 'unreachable'

export interface RepoSkills {
  repoId: number
  repoName: string
  projectId: number
  projectName: string
  repoPath: string
  status: RepoSkillsStatus
  files: { path: string; status: SkillFileStatus }[]
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

/** One repo's copy of the bundle, read from `<repoPath>/.claude`: only the bundle's paths, never a write. */
async function repoSkills(repoPath: string): Promise<Pick<RepoSkills, 'status' | 'files'>> {
  try {
    if (!(await fs.stat(repoPath)).isDirectory()) return { status: 'unreachable', files: [] }
    await fs.access(repoPath, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    return { status: 'unreachable', files: [] }
  }
  const files = await Promise.all(
    reviewBundlePaths().map(async (p) => ({
      path: p,
      status: await fileStatus(
        path.join(repoPath, '.claude', ...p.split('/')),
        reviewFiles[`./skill/review/${p}`]!,
      ),
    })),
  )
  const status = files.every((f) => f.status === 'missing')
    ? 'none'
    : files.every((f) => f.status === 'current')
      ? 'current'
      : 'outdated'
  return { status, files }
}

/**
 * Whether each repo on the board (or in one project) has the review bundle the board serves now, in
 * its own `.claude` folder. Read from the checkouts on this machine each time it is asked.
 */
export async function reviewSkillsStatus(projectId?: number) {
  if (projectId !== undefined) getProject(projectId)
  const repos = listProjects()
    .filter((p) => projectId === undefined || p.id === projectId)
    .flatMap((p) => p.repos.map((r) => ({ r, p })))
  return {
    files: reviewBundlePaths(),
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
