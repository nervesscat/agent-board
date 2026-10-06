import path from 'node:path'

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
    expect(reviewSkillsInstall('bash', board, 'gate_abc', posix)).toBe(
      `mkdir -p '/home/me/my repo/.claude' && (cd '/home/me/my repo/.claude' && ` +
        `curl -fsS -H "Authorization: Bearer gate_abc" "${src}" | tar -x)`,
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
    // In bash the same folder is written with slashes, which Git Bash takes.
    expect(reviewSkillsInstall('bash', board, 'gate_abc', windows)).toBe(
      `mkdir -p 'F:/Code/my repo/.claude' && (cd 'F:/Code/my repo/.claude' && ` +
        `curl -fsS -H "Authorization: Bearer gate_abc" "${src}" | tar -x)`,
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
        `curl -fsS -H "Authorization: Bearer gate_…" "${src}" | tar -x)`,
    )
  })

  it("hands a repo's folder to mkdir and cd only: GNU tar would read escapes in it", () => {
    for (const repo of ['/tmp/x/a\\b', '/tmp/x/a\\101z', '/home/me/my repo', 'F:\\Code\\my repo']) {
      const line = reviewSkillsInstall('bash', board, '', repoClaudeDir(repo))
      const folder = line.match(/^mkdir -p ('(?:[^']|'\\'')*') && \(cd /)![1]!
      expect(line, repo).toBe(
        `mkdir -p ${folder} && (cd ${folder} && curl -fsS -H "Authorization: Bearer gate_…" "${src}" | tar -x)`,
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
