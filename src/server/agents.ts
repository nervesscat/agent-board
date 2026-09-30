import { db, schema } from '#/db'
import { AGENT_CLIENTS, type AgentClient } from '#/lib/constants'
import { config } from './config'
import { listProjects } from './projects'
import template from './skill/board.md?raw'

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
