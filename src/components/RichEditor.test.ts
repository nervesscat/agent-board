import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { Node } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { richExtensions, tidy } from './RichEditor'

const extensions = richExtensions()
const schema = getSchema(extensions)
const markdown = new MarkdownManager({ extensions })

/** What the editor stores for `md` once it has loaded it: markdown → document → markdown. */
function roundTrip(md: string): string {
  const doc = Node.fromJSON(schema, markdown.parse(md))
  return tidy(markdown.serialize(doc.toJSON()))
}

const lines = (...l: string[]) => l.join('\n')

describe('RichEditor markdown', () => {
  it('keeps project instructions as they are written', () => {
    const md = lines(
      '## The live board',
      '',
      'The board runs from the main checkout (`F:\\Programming\\WebDev\\agent-board`) on port 47100, built (`pnpm start`). Never switch branches there.',
      '',
      '## Work and previews',
      '',
      '- Work in a worktree: `git worktree add ../agent-board-<branch> <branch>`, then `pnpm install` in it. Register it with `add_workspace`.',
      '- Preview: `pnpm dev` prints `Preview: http://localhost:<port>`. Post that link on the ticket.',
      '  - Keep it running while the ticket is in review.',
      '- Checks: `pnpm exec prettier --check --end-of-line auto <changed files>`.',
      '',
      '1. Read the [README](https://github.com/nervesscat/agent-board#readme) first.',
      '2. Then *the* **rest**.',
      '',
      '> Never merge; the human does.',
      '',
      '```sh',
      'pnpm typecheck',
      '',
      'pnpm test',
      '```',
      '',
      '- [ ] open',
      '- [x] done',
      '',
      '`CLAUDE.md` in the repo has the details.',
    )
    expect(roundTrip(md)).toBe(md)
  })

  it('escapes markdown characters in plain text so it reads back the same, and stays put after that', () => {
    const md = 'Plain F:\\Programming\\x, snake_case and 1 < 2 & more: https://example.com/x'
    const once = roundTrip(md)
    expect(once).toBe(
      'Plain F:\\\\Programming\\\\x, snake\\_case and 1 &lt; 2 &amp; more: [https://example.com/x](https://example.com/x)',
    )
    expect(markdown.parse(once)).toEqual(markdown.parse(md))
    expect(roundTrip(once)).toBe(once)
  })

  it('collapses blank lines outside code blocks only', () => {
    expect(tidy('a\n\n\n\nb\n```\nc\n\n\n\nd\n```\n\n')).toBe('a\n\nb\n```\nc\n\n\n\nd\n```')
  })
})
