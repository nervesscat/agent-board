import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENT_TOKEN_NAME,
  mcpSetup,
  repoClaudeDir,
  reviewSkillsInstall,
  skillInstall,
  TOKEN_PLACEHOLDER,
} from './agents'
import { AGENT_CLIENTS } from './constants'

const board = 'http://localhost:47100'
const src = `${board}/api/agent-setup/review-skills`

describe('the review skills install line', () => {
  it('goes to ~/.claude when no folder is given, as it always has', () => {
    expect(reviewSkillsInstall('bash', board, '')).toBe(
      `mkdir -p ~/.claude && curl -fsS -H "Authorization: Bearer <token>" "${src}" | tar -x -C ~/.claude`,
    )
    expect(reviewSkillsInstall('powershell', board, 'Xy-9_tok')).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force "$HOME\\.claude" | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer Xy-9_tok' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C "$HOME\\.claude"; Remove-Item $t`,
    )
  })

  it('installs into the folder CLAUDE_HOME names, as given, in either shell', () => {
    // The folder itself is the target, not a checkout that holds one: nothing is added to it.
    expect(reviewSkillsInstall('bash', board, 'Xy-9_tok', '/srv/claude home')).toBe(
      `mkdir -p '/srv/claude home' && (cd '/srv/claude home' && ` +
        `curl -fsS -H "Authorization: Bearer Xy-9_tok" "${src}" | tar -x)`,
    )
    expect(reviewSkillsInstall('powershell', board, 'Xy-9_tok', '/srv/claude home')).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force '/srv/claude home' | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer Xy-9_tok' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C '/srv/claude home'; Remove-Item $t`,
    )
    const windows = 'D:\\Agents\\claude'
    expect(reviewSkillsInstall('powershell', board, '', windows)).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force 'D:\\Agents\\claude' | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer <token>' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C 'D:\\Agents\\claude'; Remove-Item $t`,
    )
    expect(reviewSkillsInstall('bash', board, '', windows)).toBe(
      `mkdir -p 'D:/Agents/claude' && (cd 'D:/Agents/claude' && ` +
        `curl -fsS -H "Authorization: Bearer <token>" "${src}" | tar -x)`,
    )
    for (const shell of ['bash', 'powershell'] as const)
      expect(reviewSkillsInstall(shell, board, '', windows), shell).not.toMatch(/~\/\.claude|\$HOME/)
  })

  it("finds the repo's .claude the board reads: a Windows path with its own separator, any other with /", () => {
    expect(repoClaudeDir('F:\\Code\\my repo')).toBe('F:\\Code\\my repo\\.claude')
    expect(repoClaudeDir('F:\\Code\\my repo\\')).toBe('F:\\Code\\my repo\\.claude')
    expect(repoClaudeDir('\\\\nas\\code\\repo')).toBe('\\\\nas\\code\\repo\\.claude')
    expect(repoClaudeDir('C:/a/b/')).toBe('C:/a/b/.claude')
    expect(repoClaudeDir('/home/me/repo/')).toBe('/home/me/repo/.claude')
    expect(repoClaudeDir('/home/me/repo')).toBe('/home/me/repo/.claude')
    // On a POSIX board a backslash is part of a folder's name, not a separator.
    expect(repoClaudeDir('/tmp/x/a\\b')).toBe('/tmp/x/a\\b/.claude')
    for (const p of ['/home/me/repo/', '/tmp/x/a\\b', '/tmp/x/a\\b\\'])
      expect(repoClaudeDir(p), p).toBe(path.posix.join(p, '.claude'))
    for (const p of ['F:\\Code\\my repo\\', '\\\\nas\\code\\repo', 'C:/a/b/'])
      expect(path.win32.normalize(repoClaudeDir(p)), p).toBe(path.win32.join(p, '.claude'))
  })

  it("installs into a repo's .claude, the folder one argument however it is spelled", () => {
    const posix = repoClaudeDir('/home/me/my repo/')
    expect(reviewSkillsInstall('bash', board, 'Xy-9_tok', posix)).toBe(
      `mkdir -p '/home/me/my repo/.claude' && (cd '/home/me/my repo/.claude' && ` +
        `curl -fsS -H "Authorization: Bearer Xy-9_tok" "${src}" | tar -x)`,
    )
    expect(reviewSkillsInstall('powershell', board, '', posix)).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force '/home/me/my repo/.claude' | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer <token>' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C '/home/me/my repo/.claude'; Remove-Item $t`,
    )

    const windows = repoClaudeDir('F:\\Code\\my repo')
    expect(reviewSkillsInstall('powershell', board, 'Xy-9_tok', windows)).toContain(
      `New-Item -ItemType Directory -Force 'F:\\Code\\my repo\\.claude' | Out-Null; `,
    )
    expect(reviewSkillsInstall('powershell', board, 'Xy-9_tok', windows)).toContain(
      `tar -xf $t -C 'F:\\Code\\my repo\\.claude'; Remove-Item $t`,
    )
    // In bash the same folder is written with slashes, which Git Bash takes.
    expect(reviewSkillsInstall('bash', board, 'Xy-9_tok', windows)).toBe(
      `mkdir -p 'F:/Code/my repo/.claude' && (cd 'F:/Code/my repo/.claude' && ` +
        `curl -fsS -H "Authorization: Bearer Xy-9_tok" "${src}" | tar -x)`,
    )
    expect(reviewSkillsInstall('bash', board, '', repoClaudeDir('\\\\nas\\code\\repo'))).toContain(
      `(cd '//nas/code/repo/.claude' && `,
    )
  })

  it('keeps quotes, dollars and backslashes in a folder literal in either shell', () => {
    expect(reviewSkillsInstall('bash', board, '', "/home/me/it's $HOME/.claude")).toContain(
      `(cd '/home/me/it'\\''s $HOME/.claude' && `,
    )
    expect(reviewSkillsInstall('bash', board, '', '/home/me/a\\b/.claude')).toContain(
      `(cd '/home/me/a\\b/.claude' && `,
    )
    expect(reviewSkillsInstall('powershell', board, '', "F:\\it's $HOME\\.claude")).toContain(
      `tar -xf $t -C 'F:\\it''s $HOME\\.claude'`,
    )
    const backslash = repoClaudeDir('/tmp/x/a\\b')
    expect(reviewSkillsInstall('bash', board, '', backslash)).toBe(
      `mkdir -p '/tmp/x/a\\b/.claude' && (cd '/tmp/x/a\\b/.claude' && ` +
        `curl -fsS -H "Authorization: Bearer <token>" "${src}" | tar -x)`,
    )
  })

  it("hands a repo's folder to mkdir and cd only: GNU tar would read escapes in it", () => {
    for (const repo of ['/tmp/x/a\\b', '/tmp/x/a\\101z', '/home/me/my repo', 'F:\\Code\\my repo']) {
      const line = reviewSkillsInstall('bash', board, '', repoClaudeDir(repo))
      const folder = line.match(/^mkdir -p ('(?:[^']|'\\'')*') && \(cd /)![1]!
      expect(line, repo).toBe(
        `mkdir -p ${folder} && (cd ${folder} && curl -fsS -H "Authorization: Bearer <token>" "${src}" | tar -x)`,
      )
      expect(line, repo).not.toContain('-C')
    }
  })

  /**
   * Reads one PowerShell single-quoted string at the start of `text` as PowerShell does: any of
   * ' ‘ ’ ‚ ‛ ends it, and two of them in a row stand for the first, literally. Answers the string's
   * value and what follows it.
   */
  const readPowershellString = (text: string) => {
    const quote = /['\u2018\u2019\u201A\u201B]/
    expect(text[0]).toMatch(quote)
    let value = ''
    for (let i = 1; i < text.length; i++) {
      if (!quote.test(text[i]!)) value += text[i]
      else if (quote.test(text[i + 1] ?? '')) value += text[i++]
      else return { value, rest: text.slice(i + 1) }
    }
    throw new Error(`unterminated string in ${text}`)
  }

  it('keeps a folder with typographic quotes one literal PowerShell argument', () => {
    for (const dir of [
      'C:\\Users\\me\\it’s repo\\.claude',
      'C:\\code\\x’; Write-Output INJECTED; ’\\.claude',
      "C:\\code\\‘a’ ‚b‛ 'c'\\.claude",
    ]) {
      const line = reviewSkillsInstall('powershell', board, '', dir)
      const made = readPowershellString(line.slice(line.indexOf('-Force ') + '-Force '.length))
      expect(made.value, dir).toBe(dir)
      expect(made.rest, dir).toMatch(/^ \| Out-Null; Invoke-WebRequest /)
      const extracted = readPowershellString(line.slice(line.indexOf(' -C ') + ' -C '.length))
      expect(extracted, dir).toEqual({ value: dir, rest: '; Remove-Item $t' })
    }
  })
})

describe('the commands Generate commands fills in', () => {
  const token = 'Xy-9_tok'

  it("carries the token in every CLI's MCP setup, and the placeholder until there is one", () => {
    const url = `${board}/api/mcp`
    expect(mcpSetup('claude', board, token)).toEqual({
      kind: 'command',
      text: `claude mcp add --transport http --scope user board ${url} --header "Authorization: Bearer ${token}"`,
    })
    expect(mcpSetup('codex', board, token).text).toBe(
      `[mcp_servers.board]
url = "${url}"
http_headers = { Authorization = "Bearer ${token}" }`,
    )
    expect(JSON.parse(mcpSetup('opencode', board, token).text).mcp.board).toEqual({
      type: 'remote',
      url,
      enabled: true,
      headers: { Authorization: `Bearer ${token}` },
    })
    for (const client of AGENT_CLIENTS)
      expect(mcpSetup(client, board, '').text, client).toContain(`Bearer ${TOKEN_PLACEHOLDER}`)
  })

  it("carries the token in each CLI's skill install line, in bash and PowerShell", () => {
    for (const client of AGENT_CLIENTS) {
      const src = `${board}/api/agent-setup/skill?client=${client}`
      expect(skillInstall(client, 'bash', board, token), client).toContain(
        `curl -fsS -H "Authorization: Bearer ${token}" "${src}" -o `,
      )
      expect(skillInstall(client, 'powershell', board, token), client).toContain(
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer ${token}' } '${src}'`,
      )
      for (const shell of ['bash', 'powershell'] as const)
        expect(skillInstall(client, shell, board, ''), client).toContain(`Bearer ${TOKEN_PLACEHOLDER}`)
    }
  })
})

describe("an agent token's name", () => {
  it('is the CLI by default, or any name an agent can go by on the board', () => {
    for (const name of [...AGENT_CLIENTS, 'review-bot', 'builder_2', 'a.b', 'x'.repeat(40)])
      expect(AGENT_TOKEN_NAME.test(name), name).toBe(true)
    for (const name of ['', ' claude', 'two words', '-x', '.x', 'a/b', 'é', 'x'.repeat(41)])
      expect(AGENT_TOKEN_NAME.test(name), name).toBe(false)
  })
})
