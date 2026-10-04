import type { AgentClient } from './constants'

/** How each agent CLI is named, and where it keeps its user-wide skills and MCP servers. */
export const AGENTS: Record<
  AgentClient,
  { label: string; skillDir: { unix: string; windows: string }; mcpFile: string | null }
> = {
  claude: {
    label: 'Claude Code',
    skillDir: { unix: '~/.claude/skills/board', windows: '$HOME\\.claude\\skills\\board' },
    mcpFile: null,
  },
  codex: {
    label: 'Codex',
    skillDir: { unix: '~/.agents/skills/board', windows: '$HOME\\.agents\\skills\\board' },
    mcpFile: '~/.codex/config.toml',
  },
  opencode: {
    label: 'OpenCode',
    skillDir: {
      unix: '~/.config/opencode/skills/board',
      windows: '$HOME\\.config\\opencode\\skills\\board',
    },
    mcpFile: '~/.config/opencode/opencode.json',
  },
}

export type Shell = 'bash' | 'powershell'

// The shell picked last is remembered in this browser; storage can be unavailable, so bash is the fallback.
const SHELL_KEY = 'agents.shell'
export function savedShell(): Shell {
  try {
    return localStorage.getItem(SHELL_KEY) === 'powershell' ? 'powershell' : 'bash'
  } catch {
    return 'bash'
  }
}
export function saveShell(shell: Shell) {
  try {
    localStorage.setItem(SHELL_KEY, shell)
  } catch {}
}

/** Stands in for the token until one is pasted on the page. */
export const TOKEN_PLACEHOLDER = 'gate_…'

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

/**
 * One line that installs feature-review, review-queue and their agents into ~/.claude (Claude Code's
 * skills and agents; OpenCode reads ~/.claude/skills too), replacing the files of the same name.
 */
export function reviewSkillsInstall(shell: Shell, boardUrl: string, token: string) {
  const src = `${boardUrl}/api/agent-setup/review-skills`
  const auth = `Bearer ${token || TOKEN_PLACEHOLDER}`
  return shell === 'bash'
    ? `mkdir -p ~/.claude && curl -fsS -H "Authorization: ${auth}" "${src}" | tar -x -C ~/.claude`
    : `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force "$HOME\\.claude" | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = '${auth}' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C "$HOME\\.claude"; Remove-Item $t`
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
