import { Editor, getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { Node } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { type BlockStyle, richExtensions, tidy, toggleBlock } from './RichEditor'

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

/**
 * Block styles on a selection, one row per case. The selection is the text between «» in `md` (a caret is «» with nothing
 * between). `expected` is the markdown the editor holds after the style ran. The rules behind the rows:
 * - a caret keeps the editor's own toggle of the whole paragraph or item (the first rows);
 * - the selected text is what changes: it is split off from the text around it, which keeps its block and its list;
 * - a list style on a block that is in that list toggles it off (the block leaves the list, in the item it was in); any
 *   other selected block becomes an item of the list at its own level, with the nested lists, quotes and code blocks
 *   that follow it in its item;
 * - a heading, code block or quote changes its block in place; a first paragraph of a list item leaves the list, and
 *   the paragraph after it becomes the first of the item. A first paragraph followed by a list, quote or code block
 *   stays as it is: markdown cannot write an empty paragraph in front of that rest, so the item would not read back;
 * - a toggle (the selection starts in the style) takes off only the selected blocks of that style;
 * - an ordered item that the style does not touch keeps its number; two ordered lists written next to each other read
 *   back as one, so a list that a paragraph joins numbers on from it;
 * - a selection that covers only line breaks changes nothing; one that covers only empty lines takes the editor's
 *   whole-block toggle, as a caret does (`EMPTY_LINE_CASES`).
 * The rows marked `true` also check that the saved markdown reads back to itself.
 */
const CASES: [name: string, md: string, style: BlockStyle, expected: string, reload?: true][] = [
  ['caret | heading', 'Hello «»brave world', 'heading', '## Hello brave world'],
  ['caret | bulletList', 'Hello «»brave world', 'bulletList', '- Hello brave world'],
  ['caret | orderedList', 'Hello «»brave world', 'orderedList', '1. Hello brave world'],
  ['caret | taskList', 'Hello «»brave world', 'taskList', '- [ ] Hello brave world'],
  ['caret | quote', 'Hello «»brave world', 'quote', '> Hello brave world'],
  ['caret | code', 'Hello «»brave world', 'code', '```\nHello brave world\n```'],
  ['one paragraph | heading', 'Hello «brave» world', 'heading', 'Hello \n\n## brave\n\n world'],
  ['one paragraph | bulletList', 'Hello «brave» world', 'bulletList', 'Hello \n\n- brave\n\n world'],
  ['one paragraph | orderedList', 'Hello «brave» world', 'orderedList', 'Hello \n\n1. brave\n\n world'],
  ['one paragraph | taskList', 'Hello «brave» world', 'taskList', 'Hello \n\n- [ ] brave\n\n&#32;world'],
  [
    'one paragraph | taskList reads back with the text after it',
    'Hello «brave» world',
    'taskList',
    'Hello \n\n- [ ] brave\n\n&#32;world',
    true,
  ],
  ['one paragraph | quote', 'Hello «brave» world', 'quote', 'Hello \n\n> brave\n\n world'],
  ['one paragraph | code', 'Hello «brave» world', 'code', 'Hello \n\n```\nbrave\n```\n\n world'],
  [
    'several paragraphs | heading',
    'one «two\n\nthree» four',
    'heading',
    'one \n\n## two\n\n## three\n\n four',
  ],
  [
    'several paragraphs | bulletList',
    'one «two\n\nthree» four',
    'bulletList',
    'one \n\n- two\n- three\n\n four',
  ],
  [
    'several paragraphs | orderedList',
    'one «two\n\nthree» four',
    'orderedList',
    'one \n\n1. two\n2. three\n\n four',
  ],
  [
    'several paragraphs | taskList',
    'one «two\n\nthree» four',
    'taskList',
    'one \n\n- [ ] two\n- [ ] three\n\n&#32;four',
  ],
  ['several paragraphs | quote', 'one «two\n\nthree» four', 'quote', 'one \n\n> two\n>\n> three\n\n four'],
  [
    'several paragraphs | code',
    'one «two\n\nthree» four',
    'code',
    'one \n\n```\ntwo\n```\n\n```\nthree\n```\n\n four',
  ],
  [
    'part of one item | heading',
    '- one «two» three\n- four',
    'heading',
    '- one \n  ## two\n\n   three\n- four',
  ],
  [
    'part of one item | bulletList',
    '- one «two» three\n- four',
    'bulletList',
    '- one \n\ntwo\n\n-  three\n- four',
  ],
  [
    'part of one item | orderedList',
    '- one «two» three\n- four',
    'orderedList',
    '- one \n\n1. two\n\n-  three\n- four',
  ],
  [
    'part of one item | taskList',
    '- one «two» three\n- four',
    'taskList',
    '- one \n\n- [ ] two\n\n-  three\n- four',
  ],
  ['part of one item | quote', '- one «two» three\n- four', 'quote', '- one \n  > two\n\n   three\n- four'],
  [
    'part of one item | code',
    '- one «two» three\n- four',
    'code',
    '- one \n  ```\n  two\n  ```\n\n   three\n- four',
  ],
  [
    'part of one numbered item | heading',
    '1. one «two» three\n2. four',
    'heading',
    '1. one \n   ## two\n\n    three\n2. four',
  ],
  [
    'part of one numbered item | bulletList',
    '1. one «two» three\n2. four',
    'bulletList',
    '1. one \n\n- two\n\n1.  three\n2. four',
  ],
  [
    'part of one numbered item | orderedList',
    '1. one «two» three\n2. four',
    'orderedList',
    '1. one \n\ntwo\n\n1.  three\n2. four',
  ],
  [
    'part of one numbered item | taskList',
    '1. one «two» three\n2. four',
    'taskList',
    '1. one \n\n- [ ] two\n\n1.  three\n2. four',
  ],
  [
    'part of one numbered item | quote',
    '1. one «two» three\n2. four',
    'quote',
    '1. one \n   > two\n\n    three\n2. four',
  ],
  [
    'part of one numbered item | code',
    '1. one «two» three\n2. four',
    'code',
    '1. one \n   ```\n   two\n   ```\n\n    three\n2. four',
  ],
  [
    'across items | heading',
    '- one «two\n- three» four',
    'heading',
    '- one \n  ## two\n\n## three\n\n-  four',
  ],
  [
    'across items | bulletList',
    '- one «two\n- three» four',
    'bulletList',
    '- one \n\ntwo\n\nthree\n\n-  four',
  ],
  [
    'across items | orderedList',
    '- one «two\n- three» four',
    'orderedList',
    '- one \n\n1. two\n2. three\n\n-  four',
  ],
  [
    'across items | taskList',
    '- one «two\n- three» four',
    'taskList',
    '- one \n\n- [ ] two\n- [ ] three\n\n-  four',
  ],
  ['across items | quote', '- one «two\n- three» four', 'quote', '- one \n  > two\n\n> three\n\n-  four'],
  [
    'across items | code',
    '- one «two\n- three» four',
    'code',
    '- one \n  ```\n  two\n  ```\n\n```\nthree\n```\n\n-  four',
  ],
  [
    'across numbered items | heading',
    '1. one «two\n2. three» four',
    'heading',
    '1. one \n   ## two\n\n## three\n\n2.  four',
  ],
  [
    'across numbered items | bulletList',
    '1. one «two\n2. three» four',
    'bulletList',
    '1. one \n\n- two\n- three\n\n2.  four',
  ],
  [
    'across numbered items | orderedList',
    '1. one «two\n2. three» four',
    'orderedList',
    '1. one \n\ntwo\n\nthree\n\n2.  four',
  ],
  [
    'across numbered items | taskList',
    '1. one «two\n2. three» four',
    'taskList',
    '1. one \n\n- [ ] two\n- [ ] three\n\n2.  four',
  ],
  [
    'across numbered items | quote',
    '1. one «two\n2. three» four',
    'quote',
    '1. one \n   > two\n\n> three\n\n2.  four',
  ],
  [
    'across numbered items | code',
    '1. one «two\n2. three» four',
    'code',
    '1. one \n   ```\n   two\n   ```\n\n```\nthree\n```\n\n2.  four',
  ],
  [
    'inside nested item | heading',
    '- one\n  - nest «ed» item\n- x',
    'heading',
    '- one\n  - nest \n    ## ed\n  \n     item\n- x',
  ],
  [
    'inside nested item | bulletList',
    '- one\n  - nest «ed» item\n- x',
    'bulletList',
    '- one\n  - nest \n\n  ed\n  -  item\n- x',
  ],
  [
    'inside nested item | orderedList',
    '- one\n  - nest «ed» item\n- x',
    'orderedList',
    '- one\n  - nest \n  1. ed\n  -  item\n- x',
  ],
  [
    'inside nested item | taskList',
    '- one\n  - nest «ed» item\n- x',
    'taskList',
    '- one\n  - nest \n  - [ ] ed\n  -  item\n- x',
  ],
  [
    'inside nested item | quote',
    '- one\n  - nest «ed» item\n- x',
    'quote',
    '- one\n  - nest \n    > ed\n  \n     item\n- x',
  ],
  [
    'inside nested item | code',
    '- one\n  - nest «ed» item\n- x',
    'code',
    '- one\n  - nest \n    ```\n    ed\n    ```\n  \n     item\n- x',
  ],
  [
    'inside nested numbered item | heading',
    '1. one\n   - nest «ed» item\n2. x',
    'heading',
    '1. one\n   - nest \n     ## ed\n   \n      item\n2. x',
  ],
  [
    'inside nested numbered item | bulletList',
    '1. one\n   - nest «ed» item\n2. x',
    'bulletList',
    '1. one\n   - nest \n\n   ed\n   -  item\n2. x',
  ],
  [
    'inside nested numbered item | orderedList',
    '1. one\n   - nest «ed» item\n2. x',
    'orderedList',
    '1. one\n   - nest \n   1. ed\n   -  item\n2. x',
  ],
  [
    'inside nested numbered item | taskList',
    '1. one\n   - nest «ed» item\n2. x',
    'taskList',
    '1. one\n   - nest \n   - [ ] ed\n   -  item\n2. x',
  ],
  [
    'inside nested numbered item | quote',
    '1. one\n   - nest «ed» item\n2. x',
    'quote',
    '1. one\n   - nest \n     > ed\n   \n      item\n2. x',
  ],
  [
    'inside nested numbered item | code',
    '1. one\n   - nest «ed» item\n2. x',
    'code',
    '1. one\n   - nest \n     ```\n     ed\n     ```\n   \n      item\n2. x',
  ],
  [
    'across levels | heading',
    '- one\n  - tw«o\n- th»ree',
    'heading',
    '- one\n  - tw\n    ## o\n\n## th\n\n- ree',
  ],
  [
    'across levels | bulletList',
    '- one\n  - tw«o\n- th»ree',
    'bulletList',
    '- one\n  - tw\n\n  o\n\nth\n\n- ree',
  ],
  [
    'across levels | orderedList',
    '- one\n  - tw«o\n- th»ree',
    'orderedList',
    '- one\n  - tw\n  1. o\n\n1. th\n\n- ree',
  ],
  [
    'across levels | taskList',
    '- one\n  - tw«o\n- th»ree',
    'taskList',
    '- one\n  - tw\n  - [ ] o\n\n- [ ] th\n\n- ree',
  ],
  ['across levels | quote', '- one\n  - tw«o\n- th»ree', 'quote', '- one\n  - tw\n    > o\n\n> th\n\n- ree'],
  [
    'across levels | code',
    '- one\n  - tw«o\n- th»ree',
    'code',
    '- one\n  - tw\n    ```\n    o\n    ```\n\n```\nth\n```\n\n- ree',
  ],
  [
    'across numbered levels | heading',
    '1. one\n   - tw«o\n2. th»ree',
    'heading',
    '1. one\n   - tw\n     ## o\n\n## th\n\n2. ree',
  ],
  [
    'across numbered levels | bulletList',
    '1. one\n   - tw«o\n2. th»ree',
    'bulletList',
    '1. one\n   - tw\n\n   o\n2. th\n\n   ree',
  ],
  [
    'across numbered levels | orderedList',
    '1. one\n   - tw«o\n2. th»ree',
    'orderedList',
    '1. one\n   - tw\n   1. o\n2. th\n\n   ree',
  ],
  [
    'across numbered levels | taskList',
    '1. one\n   - tw«o\n2. th»ree',
    'taskList',
    '1. one\n   - tw\n   - [ ] o\n\n- [ ] th\n\n2. ree',
  ],
  [
    'across numbered levels | quote',
    '1. one\n   - tw«o\n2. th»ree',
    'quote',
    '1. one\n   - tw\n     > o\n\n> th\n\n2. ree',
  ],
  [
    'quote over a whole list item and the item after it',
    '- \u00abone\n- two\n- three\u00bb',
    'quote',
    '> one\n>\n> two\n>\n> three',
  ],
  [
    'quote from the middle of a list, not running past the selection',
    '- one\n- \u00abtwo\n- three\n- four\u00bb five',
    'quote',
    '- one\n\n> two\n>\n> three\n>\n> four\n\n-  five',
  ],
  [
    'quote across the last two items of a list',
    '- one\n- \u00abtwo\n- three\u00bb',
    'quote',
    '- one\n\n> two\n>\n> three',
  ],
  [
    'across numbered levels | code',
    '1. one\n   - tw«o\n2. th»ree',
    'code',
    '1. one\n   - tw\n     ```\n     o\n     ```\n\n```\nth\n```\n\n2. ree',
  ],
  [
    'heading on a selection inside a list item (it threw before)',
    '- one two\n- three «four»',
    'heading',
    '- one two\n- three \n  ## four',
  ],
  [
    'bullet on the whole text of an item with a nested list keeps the nested list',
    '- «one»\n  - nested',
    'bulletList',
    'one\n\n- nested',
  ],
  [
    'heading on part of an item that has a nested list keeps the nested list',
    '- one «two» three\n  - nested',
    'heading',
    '- one \n  ## two\n\n   three\n  - nested',
  ],
  [
    'numbered over two nested bullets of a numbered item keeps the later numbers',
    '1. x\n   - «a\n   - b»\n2. y\n3. z',
    'orderedList',
    '1. x\n   1. a\n   2. b\n2. y\n3. z',
  ],
  [
    'numbered on a word of a nested bullet keeps the item and its text',
    '- a\n  - bc «d»',
    'orderedList',
    '- a\n  - bc \n  1. d',
  ],
  [
    'heading across a numbered item and its nested item',
    '1. «a\n   - Hello brave» world',
    'heading',
    '1. a\n   ## Hello brave\n   -  world',
  ],
  [
    'heading across a nested item to its end keeps its sibling',
    '- one\n  - «nested»\n  - x',
    'heading',
    '- one\n  ## nested\n  - x',
  ],
  [
    'checklist on a word of a nested item keeps the item above it',
    '- one\n  - «two» three\n- four',
    'taskList',
    '- one\n  - [ ] two\n  -  three\n- four',
  ],
  [
    'numbered over a whole numbered item and the item after it',
    '1. «one\n2. two»\n\nplain',
    'orderedList',
    'one\n\ntwo\n\nplain',
  ],
  [
    'checklist on a nested item that is not first keeps the selection',
    '- a\n  - b\n  - «c»\n- d',
    'taskList',
    '- a\n  - b\n  - [ ] c\n- d',
  ],
  [
    'bullet on a middle item keeps the numbers of the items after it',
    '1. a\n2. «b»\n3. c',
    'bulletList',
    '1. a\n\n- b\n\n3. c',
  ],
  [
    'bullet on the whole text of a numbered item with a nested list keeps the numbers after',
    '1. «b»\n   - n\n2. c\n3. d',
    'bulletList',
    '- b\n  - n\n\n2. c\n3. d',
  ],
  [
    'numbered toggled off on such an item keeps the numbers after',
    '1. «b»\n   - n\n2. c\n3. d',
    'orderedList',
    'b\n\n- n\n\n2. c\n3. d',
  ],
  [
    'quote on the text before the rest of a two-level item keeps the rest in its item',
    '- a\n  - «bc» d',
    'quote',
    '- a\n  > bc\n  -  d',
  ],
  [
    'heading before a hard break keeps the break and the text after it in the item',
    '- one «two»  \n  three\n- four',
    'heading',
    '- one \n  ## two\n\n  three\n- four',
  ],
  [
    'heading on a numbered item with a nested list keeps the next numbers',
    '1. «a»\n   - n\n2. b\n3. c',
    'heading',
    '1. a\n   - n\n2. b\n3. c',
  ],
  [
    'a selection after a hard break does not restyle the text before it',
    'x  \n«brave» world',
    'heading',
    'x\n\n## brave\n\n world',
  ],
  [
    'heading on a middle word of a numbered item keeps the next number',
    '1. one «two» three\n2. four',
    'heading',
    '1. one \n   ## two\n\n    three\n2. four',
  ],
  [
    'checklist on a nested word keeps its siblings under the outer item',
    '- one\n  - nest «ed» item\n  - later',
    'taskList',
    '- one\n  - nest \n  - [ ] ed\n  -  item\n  - later',
  ],
  [
    'numbered from a nested bullet into the next numbered item',
    '1. a\n   - «b\n2. c»',
    'orderedList',
    '1. a\n   1. b\n2. c',
  ],
  [
    'bullet toggle-off touching a numbered item leaves that item numbered',
    '- «a\n1. b»',
    'bulletList',
    'a\n\n1. b',
  ],
  [
    'heading on a nested numbered word keeps the outer item number',
    '1. a\n   1. «b»\n2. c',
    'heading',
    '1. a\n   ## b\n2. c',
  ],
  [
    'heading on a nested word keeps its later siblings nested',
    '- one\n  - nest «ed» item\n  - later',
    'heading',
    '- one\n  - nest \n    ## ed\n  \n     item\n  - later',
  ],
  [
    'heading on the middle paragraph of a numbered item keeps the next number',
    '1. a\n\n   «b»\n\n   c\n2. d',
    'heading',
    '1. a\n   ## b\n\n    c\n2. d',
  ],
  [
    'bullet on the middle paragraph of a numbered item keeps the next number',
    '1. a\n\n   «b»\n\n   c\n2. d',
    'bulletList',
    '1. a\n\n- b\n\n1.  c\n2. d',
  ],
  [
    'quote on a selection that starts in a quote and runs past it lifts the quoted block',
    '> «a\n\nb»',
    'quote',
    'a\n\nb',
  ],
  [
    'quote on a selection that starts in a quote and ends in the text after it lifts only the quoted text',
    '> «one\n\ntwo» three',
    'quote',
    'one\n\ntwo\n\n three',
  ],
  [
    'heading on a selection that starts in a heading and runs into a paragraph turns only the heading off',
    '## «a\n\nb»',
    'heading',
    'a\n\nb',
  ],
  [
    'code on a selection that starts in a code block and runs into a heading leaves the heading as it is',
    '```\n«a\n```\n\n## b»',
    'code',
    'a\n\n## b',
  ],
  [
    'code on a selection that starts in a code block and runs into a paragraph leaves the paragraph as it is',
    '```\n«a\n```\n\nb»',
    'code',
    'a\n\nb',
  ],
  [
    'heading on a word before a line break in the same paragraph does not restyle the line after it',
    'Hello «brave»\nworld',
    'heading',
    'Hello \n\n## brave\n\nworld',
  ],
  [
    'numbered over a paragraph between two numbered lists joins the list after it, so it reads back the same',
    '1. a\n2. b\n\n«X»\n\n5. c\n6. d',
    'orderedList',
    '1. a\n2. b\n3. X\n4. c\n5. d',
  ],
  [
    'numbered over a paragraph after a list that ends at 4 joins the list after it, so it reads back the same',
    '3. a\n4. b\n\n«X»\n\n9. c',
    'orderedList',
    '3. a\n4. b\n5. X\n6. c',
  ],
  [
    'bullet on a quoted paragraph inside a list item takes it off the list and keeps its quote',
    '- a\n  > «b»',
    'bulletList',
    '- a\n\n> b',
  ],
  [
    'bullet on one quoted paragraph of an item keeps the next quoted paragraph in the item',
    '- x\n  > «a»\n  > b',
    'bulletList',
    '- x\n\n> a\n\n-\n  > b',
  ],
  [
    'numbered over a paragraph before a list that goes on from it joins that list',
    '«X»\n\n2. c\n3. d',
    'orderedList',
    '1. X\n2. c\n3. d',
  ],
  [
    'numbered over a paragraph before a list that does not go on from it joins it, so it reads back the same',
    '«X»\n\n1. c\n2. d',
    'orderedList',
    '1. X\n2. c\n3. d',
  ],
  [
    'quote on a paragraph of a list item inside a quote takes it out of the quote',
    '> - a\n>\n>   «b»\n>\n>   c',
    'quote',
    '> - a\n\nb\n\n> - c',
  ],
  [
    'heading on the first paragraph of an item keeps its nested list in the item',
    '- «a»\n  - b\n- c',
    'heading',
    '- a\n  - b\n- c',
  ],
  [
    'quote on the first paragraph of an item keeps the nested list of the next item in that item',
    '- «a\n- b»\n  - x\n- c',
    'quote',
    '> a\n\n- b\n  - x\n- c',
  ],
  [
    'heading on the first paragraph of an item keeps the paragraph after it in the item',
    '- «a»\n\n  b\n- c',
    'heading',
    '## a\n\n- b\n- c',
  ],
  [
    'bullet on the first paragraph of an item followed by a quote takes it out with the quote',
    '- «a»\n  > b',
    'bulletList',
    'a\n\n> b',
  ],
  [
    'checklist on the first paragraph of a numbered item followed by a quote makes it an item with the quote',
    '1. «a»\n   > b',
    'taskList',
    '- [ ] a\n  > b',
  ],
  [
    'bullet on the first paragraph of an item followed by a code block takes it out with the code',
    '- «a»\n  ```\n  code\n  ```\n- c',
    'bulletList',
    'a\n\n```\ncode\n```\n\n- c',
  ],
  [
    'numbered on a quoted paragraph of a bullet item numbers the item with it',
    '- «a\n\n  > b»\n- c',
    'orderedList',
    '1. a\n   > 1. b\n\n- c',
  ],
  [
    'a selection ending right after a soft break restyles only the text before it | quote',
    'Hello «brave\n»world',
    'quote',
    'Hello \n\n> brave\n\nworld',
  ],
  [
    'a selection ending right after a soft break restyles only the text before it | heading',
    'Hello «brave\n»world',
    'heading',
    'Hello \n\n## brave\n\nworld',
  ],
  [
    'a selection starting right before a hard break restyles only the text after it | heading',
    'Hello«  \nbrave» there',
    'heading',
    'Hello\n\n## brave\n\n there',
    true,
  ],
  [
    'a selection starting right before a hard break restyles only the text after it | bulletList',
    'Hello«  \nbrave» there',
    'bulletList',
    'Hello\n\n- brave\n\n there',
    true,
  ],
  [
    'a selection starting right before a hard break restyles only the text after it | quote',
    'Hello«  \nbrave» there',
    'quote',
    'Hello\n\n> brave\n\n there',
    true,
  ],
  [
    'a selection starting at a leading hard break restyles only the text after it | heading',
    '«  \nbrave» there',
    'heading',
    '## brave\n\n there',
    true,
  ],
  [
    'a selection starting at a leading hard break restyles only the text after it | bulletList',
    '«  \nbrave» there',
    'bulletList',
    '- brave\n\n there',
    true,
  ],
  [
    'a selection over the whole text of a paragraph that starts with a hard break | bulletList',
    '«  \nbrave there»',
    'bulletList',
    '- brave there',
    true,
  ],
  [
    'a selection starting right before a soft break restyles only the text after it | heading',
    'Hello«\nbrave» there',
    'heading',
    'Hello\n\n## brave\n\n there',
    true,
  ],
  [
    'a selection starting right before a soft break restyles only the text after it | quote',
    'Hello«\nbrave» there',
    'quote',
    'Hello\n\n> brave\n\n there',
    true,
  ],
  [
    'heading on a selection that covers a hard break reads back with the same blocks',
    'x«one  \ntwo» y',
    'heading',
    'x\n\n## one\n\n## two\n\n y',
    true,
  ],
  [
    'checklist on a selection that covers a hard break reads back with the same items',
    'x«one  \ntwo» y',
    'taskList',
    'x\n\n- [ ] one\n- [ ] two\n\n&#32;y',
    true,
  ],
  [
    'numbered over a paragraph between a bullet list and a numbered list reads back with the same numbers',
    '- a\n\n«X»\n\n1. c\n2. d',
    'orderedList',
    '- a\n\n1. X\n2. c\n3. d',
    true,
  ],
  [
    'numbered over a paragraph between two numbered lists reads back with the same numbers',
    '1. a\n2. b\n\n«X»\n\n5. c\n6. d',
    'orderedList',
    '1. a\n2. b\n3. X\n4. c\n5. d',
    true,
  ],
  [
    'numbered over a paragraph before a numbered list reads back with the same numbers',
    '«X»\n\n1. c\n2. d',
    'orderedList',
    '1. X\n2. c\n3. d',
    true,
  ],
  [
    'heading on the first paragraph of an item with a quote after it leaves the item as it is and reads back',
    '- «a»\n  > b\n- c',
    'heading',
    '- a\n  > b\n- c',
    true,
  ],
  [
    'heading on the first paragraph of a numbered item with a nested list reads back with the item and its nested list',
    '1. «a»\n   - n\n2. b\n3. c',
    'heading',
    '1. a\n   - n\n2. b\n3. c',
    true,
  ],
  [
    'quote on the first paragraph of an item with a nested list leaves the item as it is and reads back',
    '- «a»\n  - b\n- c',
    'quote',
    '- a\n  - b\n- c',
    true,
  ],
  [
    'heading on the first paragraph of an item followed by a code block keeps the code in the item',
    '- «a»\n  ```\n  code\n  ```\n- c',
    'heading',
    '- a\n  ```\n  code\n  ```\n- c',
    true,
  ],
  [
    'quote on the first paragraph of an item followed by a code block keeps the code in the item',
    '- «a»\n  ```\n  code\n  ```\n- c',
    'quote',
    '- a\n  ```\n  code\n  ```\n- c',
    true,
  ],
  [
    'bullet on a whole code block that is not in a list converts it',
    '```\n«abc»\n```',
    'bulletList',
    '- abc',
  ],
  [
    'numbered on a whole code block that is not in a list converts it',
    '```\n«abc»\n```',
    'orderedList',
    '1. abc',
  ],
  [
    'checklist on a whole code block in a quote converts it',
    '> ```\n> «abc»\n> ```',
    'taskList',
    '> - [ ] abc',
  ],
  [
    'a selection of only a soft break changes nothing',
    'Hello brave«\n»world',
    'heading',
    'Hello brave\nworld',
  ],
]

/** The editor with `md` loaded, the «» markers taken out, and the text between them selected. */
function setup(md: string): Editor {
  const editor = new Editor({ extensions, content: md, contentType: 'markdown' })
  let from = -1
  let to = -1
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    for (let i = 0; i < node.text.length; i++) {
      if (node.text[i] === '«') from = pos + i
      if (node.text[i] === '»') to = pos + i
    }
    return true
  })
  editor.view.dispatch(editor.state.tr.delete(to, to + 1).delete(from, from + 1))
  editor.commands.setTextSelection({ from, to: to - 1 })
  return editor
}

describe('RichEditor block styles on the selected text', () => {
  it.each(CASES)('%s', (_name, md, style, expected, reload) => {
    const editor = setup(md)
    try {
      toggleBlock(editor, style)
      const out = tidy(editor.getMarkdown())
      expect(out).toBe(expected)
      // The saved markdown reads back to itself: what the editor shows is what a reload shows.
      if (reload) expect(roundTrip(out)).toBe(out)
    } finally {
      editor.destroy()
    }
  })
})

/**
 * A selection of empty lines only (no character, no break): the editor's whole-block toggle takes the lines, as it does
 * for a caret. The document is `a`, two empty paragraphs, `b`, and the selection covers the two empty ones.
 */
const EMPTY_LINE_CASES: [name: string, style: BlockStyle, expected: string, reload?: true][] = [
  ['two empty lines | heading', 'heading', 'a\n\nb', true],
  // Saved as two items of one list, which reloads as two lists: the editor's own toggle does the same (not a selection case).
  ['two empty lines | bulletList', 'bulletList', 'a\n\n-\n-\n\nb'],
  ['two empty lines | bulletList reads back', 'bulletList', 'a\n\n-\n-\n\nb', true],
  ['two empty lines | quote', 'quote', 'a\n\n>\n>\n> &nbsp;\n\nb', true],
]

/** The document of `EMPTY_LINE_CASES`, with the two empty paragraphs selected (positions 4 to 6). */
function setupEmptyLines(): Editor {
  const editor = new Editor({
    extensions,
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    },
  })
  editor.commands.setTextSelection({ from: 4, to: 6 })
  return editor
}

describe('RichEditor block styles on a selection of empty lines', () => {
  it.each(EMPTY_LINE_CASES)('%s', (_name, style, expected, reload) => {
    const editor = setupEmptyLines()
    try {
      toggleBlock(editor, style)
      const out = tidy(editor.getMarkdown())
      expect(out).toBe(expected)
      if (reload) expect(roundTrip(out)).toBe(out)
    } finally {
      editor.destroy()
    }
  })
})
