import { describe, expect, it } from 'vitest'

import { repoClaudeDir, reviewSkillsInstall } from './agents'

const board = 'http://localhost:47100'
const src = `${board}/api/agent-setup/review-skills`

describe('the review skills install line', () => {
  it('goes to ~/.claude when no folder is given, as it always has', () => {
    expect(reviewSkillsInstall('bash', board, '')).toBe(
      `mkdir -p ~/.claude && curl -fsS -H "Authorization: Bearer gate_…" "${src}" | tar -x -C ~/.claude`,
    )
    expect(reviewSkillsInstall('powershell', board, 'gate_abc')).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force "$HOME\\.claude" | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer gate_abc' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C "$HOME\\.claude"; Remove-Item $t`,
    )
  })

  it("finds a repo's .claude with the separator its path uses", () => {
    expect(repoClaudeDir('F:\\Code\\my repo')).toBe('F:\\Code\\my repo\\.claude')
    expect(repoClaudeDir('F:\\Code\\my repo\\')).toBe('F:\\Code\\my repo\\.claude')
    expect(repoClaudeDir('/home/me/repo/')).toBe('/home/me/repo/.claude')
    expect(repoClaudeDir('/home/me/repo')).toBe('/home/me/repo/.claude')
  })

  it("installs into a repo's .claude, the folder one argument however it is spelled", () => {
    const posix = repoClaudeDir('/home/me/my repo/')
    expect(reviewSkillsInstall('bash', board, 'gate_abc', posix)).toBe(
      `mkdir -p '/home/me/my repo/.claude' && curl -fsS -H "Authorization: Bearer gate_abc" "${src}" | ` +
        `tar -x -C '/home/me/my repo/.claude'`,
    )
    expect(reviewSkillsInstall('powershell', board, '', posix)).toBe(
      `$t = Join-Path $env:TEMP 'review-skills.tar'; New-Item -ItemType Directory -Force '/home/me/my repo/.claude' | Out-Null; ` +
        `Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer gate_…' } '${src}' -OutFile $t; ` +
        `tar -xf $t -C '/home/me/my repo/.claude'; Remove-Item $t`,
    )

    const windows = repoClaudeDir('F:\\Code\\my repo')
    expect(reviewSkillsInstall('powershell', board, 'gate_abc', windows)).toContain(
      `New-Item -ItemType Directory -Force 'F:\\Code\\my repo\\.claude' | Out-Null; `,
    )
    expect(reviewSkillsInstall('powershell', board, 'gate_abc', windows)).toContain(
      `tar -xf $t -C 'F:\\Code\\my repo\\.claude'; Remove-Item $t`,
    )
    // Git Bash's tar reads backslashes as escapes: there the same folder is written with slashes.
    expect(reviewSkillsInstall('bash', board, 'gate_abc', windows)).toBe(
      `mkdir -p 'F:/Code/my repo/.claude' && curl -fsS -H "Authorization: Bearer gate_abc" "${src}" | ` +
        `tar -x -C 'F:/Code/my repo/.claude'`,
    )
    expect(reviewSkillsInstall('bash', board, '', repoClaudeDir('\\\\nas\\code\\repo'))).toContain(
      `tar -x -C '//nas/code/repo/.claude'`,
    )
  })

  it('keeps quotes, dollars and backslashes in a folder literal in either shell', () => {
    expect(reviewSkillsInstall('bash', board, '', "/home/me/it's $HOME/.claude")).toContain(
      `tar -x -C '/home/me/it'\\''s $HOME/.claude'`,
    )
    expect(reviewSkillsInstall('bash', board, '', '/home/me/a\\b/.claude')).toContain(
      `tar -x -C '/home/me/a\\b/.claude'`,
    )
    expect(reviewSkillsInstall('powershell', board, '', "F:\\it's $HOME\\.claude")).toContain(
      `tar -xf $t -C 'F:\\it''s $HOME\\.claude'`,
    )
  })
})
