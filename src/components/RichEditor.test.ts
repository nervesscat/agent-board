import { Editor, getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { Node } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { richExtensions, tidy, toggleBlock } from './RichEditor'

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
      'The board runs from the main checkout (`C:\\code\\agent-board`) on port 47100, built (`pnpm start`). Never switch branches there.',
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
    const md = 'Plain C:\\code\\x, snake_case and 1 < 2 & more: https://example.com/x'
    const once = roundTrip(md)
    expect(once).toBe(
      'Plain C:\\\\code\\\\x, snake\\_case and 1 &lt; 2 &amp; more: [https://example.com/x](https://example.com/x)',
    )
    expect(markdown.parse(once)).toEqual(markdown.parse(md))
    expect(roundTrip(once)).toBe(once)
  })

  it('keeps lines typed with Enter as paragraphs, one apiece, with nothing empty between them', () => {
    const md = 'line 1\n\nline 2\n\nline 3'
    expect(roundTrip(md)).toBe(md)
    const doc = markdown.parse(md)
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(doc.content?.map((n) => n.content?.map((c) => c.text))).toEqual([
      ['line 1'],
      ['line 2'],
      ['line 3'],
    ])
  })

  it('keeps a line broken with Shift+Enter as a hard break inside one paragraph', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('line 1'),
        schema.node('hardBreak'),
        schema.text('line 2'),
      ]),
    ])
    const md = tidy(markdown.serialize(doc.toJSON()))
    expect(md).toBe('line 1  \nline 2')
    expect(roundTrip(md)).toBe(md)
    const [p, ...rest] = markdown.parse(md).content ?? []
    expect(rest).toEqual([])
    expect(p?.type).toBe('paragraph')
    expect(p?.content?.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text'])
  })

  it('collapses blank lines outside code blocks only', () => {
    expect(tidy('a\n\n\n\nb\n```\nc\n\n\n\nd\n```\n\n')).toBe('a\n\nb\n```\nc\n\n\n\nd\n```')
  })
})

/** An editor with `md` loaded and the text from `from` to `to` selected (positions as the editor counts them). */
function editorWith(md: string, from: number, to: number): Editor {
  const editor = new Editor({ extensions, content: md, contentType: 'markdown' })
  editor.commands.setTextSelection({ from, to })
  return editor
}

/** The markdown the editor holds after `apply` ran on it. */
function after(md: string, from: number, to: number, apply: (e: Editor) => void): string {
  const editor = editorWith(md, from, to)
  try {
    apply(editor)
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

// "Hello brave world": positions 7 to 12 select "brave".
const sentence = 'Hello brave world'

describe('RichEditor styles on a partial selection', () => {
  it('applies inline marks to the selected word only', () => {
    expect(after(sentence, 7, 12, (e) => e.chain().toggleBold().run())).toBe('Hello **brave** world')
    expect(after(sentence, 7, 12, (e) => e.chain().toggleItalic().run())).toBe('Hello *brave* world')
    expect(after(sentence, 7, 12, (e) => e.chain().toggleStrike().run())).toBe('Hello ~~brave~~ world')
    expect(after(sentence, 7, 12, (e) => e.chain().toggleCode().run())).toBe('Hello `brave` world')
  })

  it('applies a link to the selected word only', () => {
    const md = after(sentence, 7, 12, (e) =>
      e.chain().extendMarkRange('link').setLink({ href: 'https://example.com' }).run(),
    )
    expect(md).toBe('Hello [brave](https://example.com) world')
  })

  it('applies a heading to the selected words only', () => {
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 })))).toBe(
      'Hello \n\n## brave\n\n world',
    )
  })

  it('applies a bullet, numbered or checklist item to the selected words only', () => {
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleBulletList()))).toBe(
      'Hello \n\n- brave\n\n world',
    )
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleOrderedList()))).toBe(
      'Hello \n\n1. brave\n\n world',
    )
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleTaskList()))).toBe(
      'Hello \n\n- [ ] brave\n\n world',
    )
  })

  it('applies a quote to the selected words only', () => {
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleBlockquote()))).toBe(
      'Hello \n\n> brave\n\n world',
    )
  })

  it('applies a code block to the selected words only', () => {
    expect(after(sentence, 7, 12, (e) => toggleBlock(e, (c) => c.toggleCodeBlock()))).toBe(
      'Hello \n\n```\nbrave\n```\n\n world',
    )
  })

  it('does not take a selection that only touches the start of the next paragraph into the style', () => {
    expect(
      after('one two\n\nthree four', 5, 10, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('one \n\n## two\n\nthree four')
  })

  it('applies a heading to a selection inside a list item, and keeps the rest of the item in its list', () => {
    // "three" is the selected word of the second item; " four" stays a list item.
    expect(
      after('- one two\n- three four', 14, 19, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('- one two\n\n## three\n\n-  four')
  })

  it('applies a heading across two list items to the selected text of both', () => {
    expect(
      after('- one two\n- three four', 5, 17, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('- on\n\n## e two\n\n## thr\n\n- ee four')
  })

  it('takes a selected word out of its bullet list, and leaves the rest of the item in the list', () => {
    expect(
      after('- Hello brave world', 9, 14, (e) => toggleBlock(e, (c) => c.toggleBulletList(), 'bulletList')),
    ).toBe('- Hello \n\nbrave\n\n-  world')
  })

  it('takes a selected word out of its checklist, and leaves the rest of the item in the list', () => {
    expect(
      after('- [ ] Hello brave world', 9, 14, (e) => toggleBlock(e, (c) => c.toggleTaskList(), 'taskList')),
    ).toBe('- [ ] Hello \n\nbrave\n\n- [ ]  world')
  })

  it('turns a selected word of a bullet item into a numbered item, and leaves the rest as bullets', () => {
    expect(
      after('- a\n- Hello brave world\n- c', 14, 19, (e) =>
        toggleBlock(e, (c) => c.toggleOrderedList(), 'orderedList'),
      ),
    ).toBe('- a\n- Hello \n\n1. brave\n\n-  world\n- c')
  })

  it('takes the whole text of a bullet item that has a nested list out of its list, and keeps the nested list', () => {
    expect(
      after('- one\n  - nested', 3, 6, (e) => toggleBlock(e, (c) => c.toggleBulletList(), 'bulletList')),
    ).toBe('one\n\n- nested')
  })

  it('takes the whole text of a checklist item that has a nested list out of its list, and keeps the nested list', () => {
    expect(
      after('- [ ] one\n  - nested', 3, 6, (e) => toggleBlock(e, (c) => c.toggleTaskList(), 'taskList')),
    ).toBe('one\n\n- nested')
  })

  it('applies a heading to a selected word of a bullet item that has a nested list, outside the item', () => {
    // "two" is selected; the nested list stays a list of its own.
    expect(
      after('- one two\n  - nested', 7, 10, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('- one \n\n## two\n\n- nested')
  })

  it('takes a selected word of a bullet item that has a nested list out of its list', () => {
    expect(
      after('- one two\n  - nested', 7, 10, (e) => toggleBlock(e, (c) => c.toggleBulletList(), 'bulletList')),
    ).toBe('- one \n\ntwo\n\n- nested')
  })

  it('turns a selected word of a bullet item nested in a numbered item into a numbered item', () => {
    expect(
      after('1. a\n   - Hello brave world', 14, 19, (e) =>
        toggleBlock(e, (c) => c.toggleOrderedList(), 'orderedList'),
      ),
    ).toBe('1. a\n   - Hello \n   1. brave\n   -  world')
  })

  it('applies a heading across a list item and its nested list to both texts, outside the lists', () => {
    // From the start of "one" to the end of "nested".
    expect(
      after('- one\n  - nested', 3, 16, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('## one\n\n## nested')
  })

  it('applies a heading to a selection that runs from a numbered item into its nested bullet item', () => {
    // From the start of "a" to the end of "brave"; " world" stays a bullet item, outside the numbered one.
    expect(
      after('1. a\n   - Hello brave world', 3, 19, (e) =>
        toggleBlock(e, (c) => c.toggleHeading({ level: 2 })),
      ),
    ).toBe('## a\n\n## Hello brave\n\n-  world')
  })

  it('keeps a nested list in its item when a numbered item is turned into a bullet item', () => {
    // The whole text of "a" is selected: the item becomes a bullet item and "- b" stays nested in it.
    expect(
      after('1. a\n   - b', 3, 4, (e) => toggleBlock(e, (c) => c.toggleBulletList(), 'bulletList')),
    ).toBe('- a\n  - b')
  })

  it('takes the block of a toggle-off out of the item and no further, when the selection runs into the nested item', () => {
    expect(
      after('- one two\n  - nested three\n- last', 3, 22, (e) =>
        toggleBlock(e, (c) => c.toggleBulletList(), 'bulletList'),
      ),
    ).toBe('one two\n\nnested t\n\n- hree\n\n- last')
  })

  it('applies a heading to the paragraph a selection across a paragraph break starts in, and no other', () => {
    expect(
      after('one two\n\nthree', 8, 10, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('## one two\n\nthree')
  })

  it('leaves a collapsed caret on its whole paragraph, as before', () => {
    expect(after(sentence, 7, 7, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 })))).toBe(
      '## Hello brave world',
    )
  })

  it('applies a block style across two paragraphs to the blocks the selection touches only', () => {
    expect(
      after('one two\n\nthree four', 5, 12, (e) => toggleBlock(e, (c) => c.toggleHeading({ level: 2 }))),
    ).toBe('one \n\n## two\n\n## th\n\nree four')
  })
})
