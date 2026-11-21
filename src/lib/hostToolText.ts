import type { TFunction } from 'i18next'

import { shared } from '#/i18n'
import type { HostTool } from '#/lib/api'

/**
 * The missing-tools banner's three texts (what is wrong, what it breaks, the fix) in the interface's language.
 * The server writes them in English (agents read the same lines through `get_project`), so each known line is
 * recognised here and drawn from the translation files; a line it does not know shows as the server wrote it.
 * `hostToolText.test.ts` checks every line the server can write is recognised.
 */
export function hostToolText(tool: HostTool, t: TFunction): { problem: string; breaks: string; fix: string } {
  return {
    problem: tool.problem === null ? '' : problemText(tool.problem, t),
    breaks: breaksText(tool, t),
    fix: tool.fix === null ? '' : fixText(tool.fix, t),
  }
}

const NOT_FOUND = /^(git|gh|node|pnpm) was not found on the board's PATH$/
const CLAUDE_NOT_FOUND = /^claude was not found: CLAUDE_BIN is (.*)$/
const TOO_OLD = /^(gh(?: \S+)?) is too old for this check: it does not know --active$/
const NO_CONFIG_WHERE = /^gh cannot find its config: no (.+), so it looked for (.+)$/

function problemText(problem: string, t: TFunction): string {
  let m: RegExpExecArray | null
  if ((m = NOT_FOUND.exec(problem))) return t('hostTools.text.problem.notFound', { name: m[1] })
  if ((m = CLAUDE_NOT_FOUND.exec(problem))) return t('hostTools.text.problem.claudeNotFound', { bin: m[1] })
  if ((m = TOO_OLD.exec(problem))) return t('hostTools.text.problem.tooOld', { gh: m[1] })
  if ((m = NO_CONFIG_WHERE.exec(problem)))
    return t('hostTools.text.problem.noConfigWhere', { needs: m[1], file: m[2] })
  if (problem === 'gh cannot find its config: no HOME or GH_CONFIG_DIR')
    return t('hostTools.text.problem.noConfig')
  if (problem === 'gh is not signed in') return t('hostTools.text.problem.signedOut')
  return problem
}

/** The server's own (English) wording of each line: the translation files' English texts. */
const english = () => shared.getFixedT('en')

function breaksText(tool: HostTool, t: TFunction): string {
  const en = english()
  if (tool.breaks === en('hostTools.text.breaks.ghTooOld')) return t('hostTools.text.breaks.ghTooOld')
  const wrote = {
    git: en('hostTools.text.breaks.git'),
    gh: en('hostTools.text.breaks.gh'),
    claude: en('hostTools.text.breaks.claude'),
    node: en('hostTools.text.breaks.node'),
    pnpm: en('hostTools.text.breaks.pnpm'),
  }
  if (tool.name === 'git' && tool.breaks === wrote.git) return t('hostTools.text.breaks.git')
  if (tool.name === 'gh' && tool.breaks === wrote.gh) return t('hostTools.text.breaks.gh')
  if (tool.name === 'claude' && tool.breaks === wrote.claude) return t('hostTools.text.breaks.claude')
  if (tool.name === 'node' && tool.breaks === wrote.node) return t('hostTools.text.breaks.node')
  if (tool.name === 'pnpm' && tool.breaks === wrote.pnpm) return t('hostTools.text.breaks.pnpm')
  return tool.breaks
}

function fixText(fix: string, t: TFunction): string {
  const en = english()
  const then = t('hostTools.text.fix.then')
  const enThen = en('hostTools.text.fix.then')
  if (fix === en('hostTools.text.fix.installGit', { after: enThen }))
    return t('hostTools.text.fix.installGit', { after: then })
  if (fix === en('hostTools.text.fix.installGh', { after: enThen }))
    return t('hostTools.text.fix.installGh', { after: then })
  if (fix === en('hostTools.text.fix.installClaude')) return t('hostTools.text.fix.installClaude')
  if (fix === en('hostTools.text.fix.installNode', { after: enThen }))
    return t('hostTools.text.fix.installNode', { after: then })
  if (fix === en('hostTools.text.fix.installPnpm', { after: enThen }))
    return t('hostTools.text.fix.installPnpm', { after: then })
  if (fix === en('hostTools.text.fix.upgradeGh')) return t('hostTools.text.fix.upgradeGh')
  if (fix === en('hostTools.text.fix.noConfig')) return t('hostTools.text.fix.noConfig')
  if (fix === en('hostTools.text.fix.signedOut')) return t('hostTools.text.fix.signedOut')
  return fix
}
