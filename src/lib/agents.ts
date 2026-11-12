import type { AgentClient } from './constants'

/** How each agent CLI is named, and where it keeps its user-wide skills and MCP servers. */
export const AGENTS: Record<
  AgentClient,
  {
    label: string
    skillDir: { unix: string; windows: string }
    /** Where the session skill (`/session`) goes: its own folder, beside the board skill's. */
    sessionSkillDir: { unix: string; windows: string }
    mcpFile: string | null
  }
> = {
  claude: {
    label: 'Claude Code',
    skillDir: { unix: '~/.claude/skills/board', windows: '$HOME\\.claude\\skills\\board' },
    sessionSkillDir: {
      unix: '~/.claude/skills/session',
      windows: '$HOME\\.claude\\skills\\session',
    },
    mcpFile: null,
  },
  codex: {
    label: 'Codex',
    skillDir: { unix: '~/.agents/skills/board', windows: '$HOME\\.agents\\skills\\board' },
    sessionSkillDir: {
      unix: '~/.agents/skills/session',
      windows: '$HOME\\.agents\\skills\\session',
    },
    mcpFile: '~/.codex/config.toml',
  },
  opencode: {
    label: 'OpenCode',
    skillDir: {
      unix: '~/.config/opencode/skills/board',
      windows: '$HOME\\.config\\opencode\\skills\\board',
    },
    sessionSkillDir: {
      unix: '~/.config/opencode/skills/session',
      windows: '$HOME\\.config\\opencode\\skills\\session',
    },
    mcpFile: '~/.config/opencode/opencode.json',
  },
}

/** The shells the install lines are written for; bash unless one is picked. */
export const SHELLS = ['bash', 'powershell'] as const
export type Shell = (typeof SHELLS)[number]
/** The shell picked last, remembered in this browser (`useShell` in ReviewSkills). */
export const SHELL_KEY = 'agents.shell'

/** Stands in for the token until "Generate commands" makes one on the page. */
export const TOKEN_PLACEHOLDER = '<token>'

/** How long an agent token the board issues signs in: a year from when it is made. */
export const AGENT_TOKEN_DAYS = 365

/**
 * An agent token's name, which is the agent's name on the board: a letter or digit, then letters,
 * digits, `.`, `_` or `-`, 40 at most (as a project agent's name).
 */
export const AGENT_TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** How the CLI learns about the board's MCP server: a command to run, or config to add to a file. */
export function mcpSetup(client: AgentClient, boardUrl: string, token: string) {
  const url = `${boardUrl}/api/mcp`
  const auth = `Bearer ${token || TOKEN_PLACEHOLDER}`
  switch (client) {
    case 'claude':
      return {
        kind: 'command' as const,
        text: `claude mcp add --transport http --scope user board ${url} --header "Authorization: ${auth}"`,
      }
    case 'codex':
      return {
        kind: 'config' as const,
        text: `[mcp_servers.board]\nurl = "${url}"\nhttp_headers = { Authorization = "${auth}" }`,
      }
    case 'opencode':
      return {
        kind: 'config' as const,
        text: JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: { board: { type: 'remote', url, enabled: true, headers: { Authorization: auth } } },
          },
          null,
          2,
        ),
      }
  }
}

/** A Windows path (drive letter or UNC share), which the bash line writes with forward slashes. */
const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/

/**
 * A repo's own `.claude` folder, the one the board reads its copy from. A Windows path joins with the
 * separator it uses; any other path with `/`, since a backslash there is part of a folder's name.
 */
export function repoClaudeDir(repoPath: string) {
  if (!windowsPath.test(repoPath)) return `${repoPath.replace(/\/+$/, '')}/.claude`
  const sep = repoPath.includes('\\') ? '\\' : '/'
  return `${repoPath.replace(/[\\/]+$/, '')}${sep}.claude`
}

/** `dir` as one bash argument, taken literally. */
const bashArg = (dir: string) =>
  `'${(windowsPath.test(dir) ? dir.replace(/\\/g, '/') : dir).replace(/'/g, `'\\''`)}'`

/**
 * `dir` as one PowerShell argument, taken literally. PowerShell ends a single-quoted string at the
 * typographic quotes too (‘ ’ ‚ ‛), and escapes any of them by doubling it.
 */
const powershellArg = (dir: string) => `'${dir.replace(/['‘’‚‛]/g, '$&$&')}'`

/**
 * One line that installs feature-review, review-queue and their agents into ~/.claude (Claude Code's
 * skills and agents; OpenCode reads ~/.claude/skills too), or into `dir` (a repo's own `.claude`, see
 * `repoClaudeDir`, or the folder CLAUDE_HOME names), replacing the files of the same name.
 */
export function reviewSkillsInstall(shell: Shell, boardUrl: string, token: string, dir?: string) {
  const src = `${boardUrl}/api/agent-setup/review-skills`
  const auth = `Bearer ${token || TOKEN_PLACEHOLDER}`
  if (shell === 'bash') {
    const get = `curl -fsS -H "Authorization: ${auth}" "${src}"`
    if (dir === undefined) return `mkdir -p ~/.claude && ${get} | tar -x -C ~/.claude`
    // GNU tar reads escapes in -C's folder (a\b, a\101z), so tar extracts where cd has taken it.
    const to = bashArg(dir)
    return `mkdir -p ${to} && (cd ${to} && ${get} | tar -x)`
  }
  const to = dir === undefined ? '"$HOME\\.claude"' : powershellArg(dir)
  return (
    `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force ${to} | Out-Null; ` +
    `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = '${auth}' } '${src}' -OutFile $t; ` +
    `tar -xf $t -C ${to}; Remove-Item $t`
  )
}

/** One line that downloads the board's current skill into the CLI's skills folder. */
export function skillInstall(client: AgentClient, shell: Shell, boardUrl: string, token: string) {
  const src = `${boardUrl}/api/agent-setup/skill?client=${client}`
  const auth = `Bearer ${token || TOKEN_PLACEHOLDER}`
  const dir = AGENTS[client].skillDir
  return shell === 'bash'
    ? `mkdir -p ${dir.unix} && curl -fsS -H "Authorization: ${auth}" "${src}" -o ${dir.unix}/SKILL.md`
    : `New-Item -ItemType Directory -Force "${dir.windows}" | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = '${auth}' } '${src}' -OutFile "${dir.windows}\\SKILL.md"`
}

/** One line that downloads the session skill (`/session`) into the CLI's skills folder. */
export function sessionSkillInstall(client: AgentClient, shell: Shell, boardUrl: string, token: string) {
  const src = `${boardUrl}/api/agent-setup/session-skill`
  const auth = `Bearer ${token || TOKEN_PLACEHOLDER}`
  const dir = AGENTS[client].sessionSkillDir
  return shell === 'bash'
    ? `mkdir -p ${dir.unix} && curl -fsS -H "Authorization: ${auth}" "${src}" -o ${dir.unix}/SKILL.md`
    : `New-Item -ItemType Directory -Force "${dir.windows}" | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = '${auth}' } '${src}' -OutFile "${dir.windows}\\SKILL.md"`
}
