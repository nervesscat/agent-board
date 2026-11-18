import { type ChainedCommands, type Editor, type JSONContent, Node as EditorNode } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import Image from '@tiptap/extension-image'
import { ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Lexer } from 'marked'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { type Node, type ResolvedPos } from '@tiptap/pm/model'
import { AllSelection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { findWrapping, liftTarget } from '@tiptap/pm/transform'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Paperclip,
  Quote,
  SquareCode,
  Strikethrough,
} from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Tip } from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

/**
 * The serializer leaves extra blank lines around tables and at the end. Collapse them, outside code
 * blocks, where blank lines are part of the code. It also writes an empty list item as a marker and a
 * space; a marker alone reads back as a list, one with a space after it does not, so the space goes. A heading of
 * spaces alone is written with its spaces as entities: a heading with nothing in it does not read back, and a line of
 * spaces does not either.
 */
export function tidy(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^([ \t]*[-+*])[ \t]+$/gm, '$1')
            .replace(
              /^(#{1,6}) ( +)$/gm,
              (_line, hashes: string, spaces: string) => `${hashes} ${'&#32;'.repeat(spaces.length)}`,
            ),
    )
    .join('')
    .trimEnd()
}

/** The markdown of an empty paragraph, and of a non-breaking space: a line the markdown parser keeps. */
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;'
const NBSP_CHAR = '\xA0'

/**
 * The paragraph, read and written as the markdown library does, with one difference: a paragraph that follows a checklist
 * and starts with a space is written with `&#32;` in front. Read back, `- [ ] a` and then a line of ` b` loses the first
 * letters of ` b`; the entity keeps the space and the text.
 */
const Paragraph = EditorNode.create({
  name: 'paragraph',
  priority: 1000,
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens || []
    if (tokens.length === 1 && tokens[0].type === 'image') return helpers.parseChildren([tokens[0]])
    const content = helpers.parseInline(tokens)
    const isEmptyMarker = (s?: string) => s === EMPTY_PARAGRAPH_MARKDOWN || s === NBSP_CHAR
    if (
      tokens.length === 1 &&
      tokens[0].type === 'text' &&
      (isEmptyMarker(tokens[0].raw) || isEmptyMarker(tokens[0].text)) &&
      content.length === 1 &&
      content[0].type === 'text' &&
      isEmptyMarker(content[0].text)
    )
      return helpers.createNode('paragraph', undefined, [])
    return helpers.createNode('paragraph', undefined, content)
  },
  renderMarkdown: (node, h, ctx) => {
    const content = Array.isArray(node.content) ? node.content : []
    if (content.length === 0) {
      // An empty paragraph after an empty paragraph would vanish: it is written as a non-breaking space.
      // (An empty paragraph's JSON has no content at all.)
      const previous = ctx?.previousNode
      const previousEmpty = !(Array.isArray(previous?.content) && previous.content.length)
      return previous?.type === 'paragraph' && previousEmpty ? EMPTY_PARAGRAPH_MARKDOWN : ''
    }
    const text = h.renderChildren(content)
    // A paragraph of spaces alone reads back as nothing, so its spaces are written as entities (not in a task item,
    // where the reader drops the entity's `&`, see below).
    if (/^ +$/.test(text) && ctx?.parentType !== 'taskItem') return text.replace(/ /g, '&#32;')
    // After a numbered or checklist list, a paragraph that starts with a space reads back inside the item unless the
    // space is written as an entity.
    // Inside a task item the reader drops the entity's `&` (the nested paragraph reads back as `#32;`), so there the space is written bare.
    const afterList =
      ctx?.parentType !== 'taskItem' &&
      (ctx?.previousNode?.type === 'taskList' || ctx?.previousNode?.type === 'orderedList')
    return afterList && text.startsWith(' ') ? `&#32;${text.slice(1)}` : text
  },
  addKeyboardShortcuts() {
    return { 'Mod-Alt-0': () => this.editor.commands.setNode(this.name) }
  },
})

/** Inline nodes that can sit in a list item without a paragraph around them. */
const looseInline = ['text', 'hardBreak']

/**
 * The text a list item carries outside any paragraph (after a nested list, a checklist or a quote) comes from the markdown
 * reader as loose text, with its entities and escapes still in it. It is read as a paragraph of its own, its inline text
 * lexed like any paragraph's, so `&amp;`, `\_` and `&#32;` read back as the text they stand for.
 */
function looseTextAsParagraph(token: { type?: string; raw?: string; text?: string }) {
  if (token.type !== 'text' || !token.raw) return token
  return {
    type: 'paragraph',
    raw: token.raw,
    text: token.text,
    tokens: new Lexer().inlineTokens(token.raw.replace(/\n$/, '')),
  }
}

/**
 * A list item's text after a block (a heading, say) is read as loose inline content, with no paragraph around it, so
 * the item does not read back as the editor has it. Those runs go in paragraphs of their own.
 */
const ListItemWithParagraphs = ListItem.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens?.map(looseTextAsParagraph)
    const parsed = this.parent?.({ ...token, tokens }, helpers)
    if (!parsed || Array.isArray(parsed) || !parsed.content) return parsed ?? []
    const content: JSONContent[] = []
    let run: JSONContent[] = []
    const endRun = () => {
      if (run.length) content.push({ type: 'paragraph', content: run })
      run = []
    }
    for (const child of parsed.content) {
      if (looseInline.includes(child.type ?? '')) run.push(child)
      else {
        endRun()
        content.push(child)
      }
    }
    endRun()
    return { ...parsed, content }
  },
})

/** A task item's text after a nested list or a paragraph is loose text too: it reads the same way. */
const TaskItemWithParagraphs = TaskItem.extend({
  parseMarkdown(token, helpers) {
    const nestedTokens = token.nestedTokens?.map(looseTextAsParagraph)
    return this.parent?.({ ...token, nestedTokens }, helpers) ?? []
  },
})

/**
 * The text of a numbered item without its marker and the space after it, each continuation line cut by the same width.
 * The library cuts those lines one column short (it counts `1` for `1.`), so each line keeps a space, and a fenced block
 * after the first one loses its fence. An item with a fenced block is lexed again from this text (see the tokenizer
 * of `OrderedListWithBlankLine`); the other items read as the library reads them.
 */
function orderedItemText(raw: string): string {
  const [first = ''] = raw.split('\n')
  const marker = /^\s*\S+?[.)](?:[ \t]+|$)/.exec(first)?.[0] ?? ''
  return raw
    .split('\n')
    .map((line, i) => {
      if (i === 0) return line.slice(marker.length)
      const indent = line.length - line.trimStart().length
      return line.slice(Math.min(indent, marker.length))
    })
    .join('\n')
}

/**
 * A numbered list in a list item that does not start at 1 cannot follow a paragraph or a quote on the next line: the
 * reader takes its first line for more of that text. It goes after a blank line.
 */
const OrderedListWithBlankLine = OrderedList.extend({
  markdownTokenizer: {
    name: 'orderedList',
    level: 'block',
    start: () => -1,
    tokenize(src, tokens, lexer) {
      const list = OrderedList.config.markdownTokenizer?.tokenize(src, tokens, lexer)
      if (!list || !list.items) return list
      for (const item of list.items) {
        if (item.raw === undefined || !/^[ \t]*(```|~~~)/m.test(item.raw)) continue
        item.tokens = lexer.blockTokens(orderedItemText(item.raw)).filter((token) => token.type !== 'space')
      }
      return list
    },
  },
  renderMarkdown(node, h, ctx) {
    const list = this.parent?.(node, h, ctx) ?? ''
    const inItem = ctx?.parentType === 'listItem' || ctx?.parentType === 'taskItem'
    return inItem && ctx.previousNode && (node.attrs?.start ?? 1) !== 1 ? `\n${list}` : list
  },
})

/**
 * A quote in a list item that follows a numbered list reads back into the list's last item unless a blank line comes
 * before it, so it gets one.
 */
const BlockquoteWithBlankLine = Blockquote.extend({
  renderMarkdown(node, h, ctx) {
    const quote = this.parent?.(node, h, ctx) ?? ''
    const inItem = ctx?.parentType === 'listItem' || ctx?.parentType === 'taskItem'
    const after = ctx.previousNode?.type
    return inItem && (after === 'orderedList' || after === 'blockquote') ? `\n${quote}` : quote
  },
})

/** What the editor understands; each one reads and writes its own markdown. */
export function richExtensions(placeholder = '') {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true },
      paragraph: false,
      listItem: false,
      orderedList: false,
      blockquote: false,
    }),
    ListItemWithParagraphs,
    OrderedListWithBlankLine,
    BlockquoteWithBlankLine,
    Paragraph,
    Markdown,
    Image,
    TableKit,
    TaskList,
    TaskItemWithParagraphs.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
  ]
}

/**
 * Rich text in, markdown out: what agents write and read stays markdown, people get formatting
 * buttons instead of syntax. Tables, task lists, code and images round-trip. Files pasted or dropped
 * go to `onFiles` (the caller attaches them) instead of into the text. With `onAttach` the toolbar starts
 * with an attach button that calls it (the caller opens its file picker; `attaching` while it works);
 * forms that keep their attach in a row of their own leave it out. Ctrl/⌘+Enter calls `onSubmit`, Esc
 * `onCancel`.
 */
export function RichEditor({
  value,
  onChange,
  placeholder,
  onFiles,
  onAttach,
  attaching = false,
  onSubmit,
  onCancel,
  autoFocus = false,
  minHeight = 'min-h-20',
  label = 'Text',
  className,
  caretRoom,
}: {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  onFiles?: (files: File[]) => void
  /** Puts an attach button at the start of the toolbar, before Bold. */
  onAttach?: () => void
  /** The attach button spins while the files it picked are on their way. */
  attaching?: boolean
  onSubmit?: () => void
  onCancel?: () => void
  autoFocus?: boolean
  minHeight?: string
  /** Accessible name of the editing area. */
  label?: string
  className?: string
  /**
   * Pixels to keep between the caret and the top and the bottom of what scrolls the text, for a
   * heading or a footer pinned over them. The editor scrolls the caret itself after Enter, Backspace,
   * paste or undo, and goes by this, not by CSS `scroll-padding` (which the browser keeps when it
   * moves the caret, so set both). Left out, it scrolls only once the caret is out of the box.
   */
  caretRoom?: { top: number; bottom: number }
}) {
  // The latest callbacks, for handlers the editor captured when it was created.
  const handlers = useRef({ onChange, onFiles, onSubmit, onCancel })
  handlers.current = { onChange, onFiles, onSubmit, onCancel }
  const lastEmitted = useRef(value)

  const editor = useEditor({
    extensions: richExtensions(placeholder),
    content: value,
    contentType: 'markdown',
    // The server render has no editor; it appears once the page is live.
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    // The options are applied again on every render, so a room that changes (a heading measured once
    // drawn, or resized) reaches the editor. Scrolls when the caret is closer than the room, to the room.
    editorProps: {
      scrollThreshold: caretRoom && { ...caretRoom, left: 0, right: 0 },
      scrollMargin: caretRoom && { ...caretRoom, left: 5, right: 5 },
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class: cn(
          'prose prose-sm dark:prose-invert max-w-none break-words px-3 py-2 focus:outline-none',
          minHeight,
        ),
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && handlers.current.onSubmit) {
          handlers.current.onSubmit()
          return true
        }
        if (event.key === 'Escape' && handlers.current.onCancel) {
          // Taken here: `onCancel` may open a dialog ("Discard your changes?"), which listens for Esc
          // on the document as soon as it opens, and would close again on this same keypress.
          event.stopPropagation()
          handlers.current.onCancel()
          return true
        }
        return false
      },
      handlePaste: (_view, event) => takeFiles(event, event.clipboardData?.files),
      handleDrop: (_view, event) => takeFiles(event, (event as DragEvent).dataTransfer?.files),
    },
    onUpdate: ({ editor }) => {
      const md = editor.isEmpty ? '' : tidy(editor.getMarkdown())
      lastEmitted.current = md
      handlers.current.onChange(md)
    },
  })

  function takeFiles(event: Event, list: FileList | null | undefined) {
    const files = Array.from(list ?? [])
    if (!files.length || !handlers.current.onFiles) return false
    // Taken here: a drop zone around the editor must not add them a second time.
    event.preventDefault()
    event.stopPropagation()
    handlers.current.onFiles(files)
    return true
  }

  // A value set from outside (cleared after posting, another ticket loaded) replaces the content.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return
    lastEmitted.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  // The text comes before the toolbar in the page, so Tab reaches the text first and the buttons after
  // it, attach first (Shift+Tab the reverse); `flex-col-reverse` still draws the toolbar above the text.
  return (
    <div
      className={cn(
        'flex flex-col-reverse rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        className,
      )}
    >
      <EditorContent editor={editor} />
      {editor && <Toolbar editor={editor} onAttach={onAttach} attaching={attaching} />}
    </div>
  )
}

/** The list items a block can sit in. */
const listItemTypes = ['listItem', 'taskItem']
/** The lists a list item can hold, in any kind. */
const listTypes = ['bulletList', 'orderedList', 'taskList']
/** What can follow a paragraph in a list item and go with it when it moves: the lists, a quote, a code block. */
const restTypes = [...listTypes, 'blockquote', 'codeBlock']

/**
 * The block styles of the toolbar. The list kinds are lists: a selection in a list of the kind is toggled off, otherwise
 * the selected blocks become items of it. The others are blocks of their own.
 */
export type BlockStyle = 'heading' | 'quote' | 'code' | 'bulletList' | 'orderedList' | 'taskList'
type ListKind = 'bulletList' | 'orderedList' | 'taskList'

const isListKind = (style: BlockStyle): style is ListKind => style.endsWith('List')

/** The kind of the list a block sits in, when the block is the text of a list item. */
function listOf(doc: Node, pos: number): string | undefined {
  const $pos = doc.resolve(pos)
  if (!listItemTypes.includes($pos.parent.type.name) || $pos.depth < 1) return undefined
  return $pos.node($pos.depth - 1).type.name
}

/**
 * The position the selection starts at, inside a textblock. A whole-document selection (Ctrl+A) starts before the first
 * block, so it starts in the first textblock, as a text selection starts in the block it begins in.
 */
function startPos(editor: Editor): ResolvedPos {
  const { selection, doc } = editor.state
  if (!(selection instanceof AllSelection)) return selection.$from
  let first = -1
  doc.descendants((node, pos) => {
    if (first >= 0) return false
    if (node.isTextblock) first = pos
    return first < 0
  })
  return first < 0 ? selection.$from : doc.resolve(first + 1)
}

/** The list kind the selection starts in, innermost first: a bullet item in a numbered item is a bullet item here. */
function innermostList($from: ResolvedPos): string | undefined {
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') return name
  }
  return undefined
}

/** Whether the position is inside a quote, at any depth. */
function inQuote($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === 'blockquote') return true
  }
  return false
}

/** Whether the selection, where it starts, is already in `style` (a toggle then turns it off). */
function styleActive(editor: Editor, style: BlockStyle): boolean {
  const $from = startPos(editor)
  if (isListKind(style)) return innermostList($from) === style
  if (style === 'quote') return inQuote($from)
  if (style === 'code') return $from.parent.type.name === 'codeBlock'
  return $from.parent.type.name === 'heading' && $from.parent.attrs.level === 2
}

/**
 * Splits the textblocks the selection touches at its ends, so the selection covers whole textblocks, and returns the
 * positions of those blocks (none for a selection that covers no character). A selection that is not text (the whole
 * document, Ctrl+A, or a node) has no ends inside a textblock to split, so it covers the blocks it touches as they are.
 * A split beside a line break would leave the break in a block of its own, so there the break stays where it is. With
 * `splitBreaks`, the blocks are split at the breaks the selection covers too, and the breaks go: a heading or checklist
 * item cannot hold a line break once it is saved.
 */
function splitSelection(tr: Transaction, splitBreaks = false): number[] {
  if (tr.selection.empty) return []
  const { from, to } = tr.selection
  const splittable = (pos: number) => {
    const $pos = tr.doc.resolve(pos)
    if (!$pos.parent.isTextblock || $pos.parentOffset <= 0 || $pos.parentOffset >= $pos.parent.content.size)
      return false
    const { nodeBefore, nodeAfter } = $pos
    if (nodeBefore?.type.name === 'hardBreak' || nodeAfter?.type.name === 'hardBreak') return false
    return !(nodeBefore?.text?.endsWith('\n') || nodeAfter?.text?.startsWith('\n'))
  }
  // A start right after a break splits there, and the break goes: the text before it keeps its own block.
  const afterBreak = (pos: number) => {
    const $pos = tr.doc.resolve(pos)
    if (!$pos.parent.isTextblock || $pos.parentOffset <= 1 || $pos.parentOffset >= $pos.parent.content.size)
      return false
    const { nodeBefore, nodeAfter } = $pos
    if (nodeAfter?.type.name === 'hardBreak') return false
    return nodeBefore?.type.name === 'hardBreak' || !!nodeBefore?.text?.endsWith('\n')
  }
  // A selection that starts or ends right before a break (a line break, or a newline inside the text): the split goes
  // there, and the break goes, as at a start after one.
  const beforeBreak = (pos: number) => {
    const $pos = tr.doc.resolve(pos)
    const { nodeAfter } = $pos
    if (!$pos.parent.isTextblock || $pos.parentOffset <= 0) return false
    return nodeAfter?.type.name === 'hardBreak' || !!nodeAfter?.text?.startsWith('\n')
  }
  const splitTo = splittable(to)
  const splitFrom = splittable(from)
  const breakFrom = !splitFrom && afterBreak(from)
  const breakBeforeFrom = !splitFrom && !breakFrom && beforeBreak(from)
  // A selection that starts in a paragraph that opens with a break (before it or right after it): there is no text in
  // front of the break to split off, so the break alone goes.
  const $from = tr.doc.resolve(from)
  const leadingBreak =
    !splitFrom &&
    !breakFrom &&
    !breakBeforeFrom &&
    $from.parent.isTextblock &&
    $from.parentOffset <= 1 &&
    $from.parent.firstChild?.type.name === 'hardBreak'
  // A selection that ends right after a break: the same split as at a start after one, and the break goes.
  const breakEnd = !splitTo && afterBreak(to)
  const breakTo = !splitTo && !breakEnd && beforeBreak(to)
  // The end first: the start is before it, so its position does not move.
  if (splitTo) tr.split(to)
  if (breakEnd) {
    tr.split(to)
    tr.delete(to - 1, to) // the break ends the block before the split
  }
  if (breakTo) {
    tr.split(to)
    tr.delete(to + 2, to + 3) // the break now starts the block after the split
  }
  if (splitFrom) tr.split(from)
  if (breakFrom) {
    tr.split(from)
    tr.delete(from - 1, from)
  }
  if (breakBeforeFrom) {
    tr.split(from)
    tr.delete(from + 2, from + 3) // the break now starts the block after the split
  }
  if (leadingBreak) {
    const opening = from - $from.parentOffset // where the paragraph's content starts: the break is its first child
    tr.delete(opening, opening + 1)
  }
  if (splitBreaks) {
    // The breaks the selection covers, last first, so the positions of the earlier ones do not move.
    const breaks: number[] = []
    const first = tr.mapping.map(from, 1)
    const last = tr.mapping.map(to, -1)
    tr.doc.nodesBetween(first, last, (node, pos) => {
      if (node.type.name === 'hardBreak' && pos >= first && pos < last) breaks.push(pos)
      return true
    })
    for (const pos of breaks.reverse()) {
      // A break that opens its block has no text in front of it to split off: it just goes.
      if (tr.doc.resolve(pos).parentOffset === 0) {
        tr.delete(pos, pos + 1)
        continue
      }
      tr.split(pos)
      tr.delete(pos + 2, pos + 3) // the break now starts the block after the split
    }
  }
  const start = tr.mapping.map(from, 1)
  const end = tr.mapping.map(to, -1)
  const found: number[] = []
  tr.doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return true
    const contentStart = pos + 1
    const contentEnd = contentStart + node.content.size
    if (contentStart < end && contentEnd > start) found.push(pos)
    return false
  })
  return found
}

/**
 * The size of the rest of the list item that follows the block at `pos`: its nested lists, quotes and code blocks, which
 * go with the block when it moves (a list item cannot start with them, so they cannot stay behind it without a paragraph).
 */
function nestedSize(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  if (!listItemTypes.includes($pos.parent.type.name)) return 0
  let size = 0
  for (
    let i = $pos.index() + 1;
    i < $pos.parent.childCount && restTypes.includes($pos.parent.child(i).type.name);
    i++
  ) {
    size += $pos.parent.child(i).nodeSize
  }
  return size
}

/**
 * Lifts the block at `pos` out of the list it sits in, one level (the library's `lift`, which splits the item and its
 * list around the block). With `withNested`, the nested lists that follow it in its item go with it. Returns where the
 * block is now, and the size of the nested lists that came with it, or null when it cannot be lifted.
 */
function liftBlock(tr: Transaction, pos: number, withNested = true): { pos: number; nested: number } | null {
  const nested = withNested ? nestedSize(tr.doc, pos) : 0
  const size = tr.doc.nodeAt(pos)!.nodeSize
  const range = tr.doc.resolve(pos).blockRange(tr.doc.resolve(pos + size + nested))
  const target = range && liftTarget(range)
  if (!range || target == null) return null
  const mark = tr.mapping.maps.length
  tr.lift(range, target)
  return { pos: tr.mapping.slice(mark).map(pos, 1), nested }
}

/**
 * Makes the block at `pos` an item of `list`. A block in a list item first leaves the list it sits in (one lift, so it
 * stays in the item that list is in, at the same level as its neighbours); the new list is put there. Its nested lists
 * stay with it, in its new item. The new list joins an adjacent list of its kind.
 */
function makeListItem(tr: Transaction, pos: number, list: ListKind) {
  let at = pos
  let nested = nestedSize(tr.doc, at)
  if (listOf(tr.doc, at) !== undefined) {
    const moved = liftBlock(tr, at)
    if (moved) {
      at = moved.pos
      nested = moved.nested
    }
  }
  const schema = tr.doc.type.schema
  const size = tr.doc.nodeAt(at)!.nodeSize
  const range = tr.doc.resolve(at).blockRange(tr.doc.resolve(at + size + nested))
  const wrapping = range && findWrapping(range, schema.nodes[list])
  if (!range || !wrapping) return
  tr.wrap(range, wrapping)
  // A new list next to a list of its kind is the same list: they join. Two ordered lists written next to each other read
  // back as one list, so the joined list numbers on from the item before it (keepNumbers keeps the first item's number).
  const made = tr.doc.nodeAt(at)!
  const before = tr.doc.resolve(at).nodeBefore
  const after = tr.doc.resolve(at + made.nodeSize).nodeAfter
  if (after?.type === schema.nodes[list]) tr.join(at + made.nodeSize)
  if (before?.type === schema.nodes[list]) tr.join(at)
}

/**
 * The number each ordered item shows, keyed by each of its blocks: a split or a lift keeps the blocks as they are, so
 * the piece of an item that a split leaves in a list of its own still knows the number of its item.
 */
function orderedNumbers(doc: Node): Map<Node, number> {
  const numbers = new Map<Node, number>()
  doc.descendants((node) => {
    if (node.type.name !== 'orderedList') return true
    node.forEach((item, _offset, index) => {
      item.forEach((block) => numbers.set(block, node.attrs.start + index))
    })
    return true
  })
  return numbers
}

/**
 * After lists were split and joined, each ordered list starts where its items were numbered before (a list with no item
 * from before keeps its number), so an item the style did not touch keeps its number.
 */
function keepNumbers(tr: Transaction, numbers: Map<Node, number>) {
  const starts: { pos: number; node: Node; start: number }[] = []
  tr.doc.descendants((node, pos) => {
    if (node.type.name !== 'orderedList') return true
    let start: number | undefined
    // A list whose first item is new keeps the number its list was made with (the item it was joined on).
    let newFirst = false
    node.forEach((item, _offset, index) => {
      if (start !== undefined || newFirst) return
      // The item's number is that of any block of it that had one (a new paragraph in front of the rest has none).
      let number: number | undefined
      item.forEach((block) => (number ??= numbers.get(block)))
      if (number !== undefined) start = number - index
      else if (index === 0) newFirst = true
    })
    if (start !== undefined && start !== node.attrs.start) starts.push({ pos, node, start })
    return true
  })
  for (const { pos, node, start } of starts) tr.setNodeMarkup(pos, undefined, { ...node.attrs, start })
}

/**
 * Whether every node around the block at `pos` holds valid content. A node that does not (a heading that leads a list
 * item, as markdown can write it) cannot be lifted out of: the lift asks that node where the block would fit, and the
 * schema refuses to answer, so the block stays where it is.
 */
function insideValid(doc: Node, pos: number): boolean {
  const $pos = doc.resolve(pos)
  for (let depth = 0; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth)
    if (!node.type.validContent(node.content)) return false
  }
  return true
}

/**
 * Whether the block at `pos` is the first paragraph of a list item and is followed by a list, quote or code block there:
 * such a block keeps its place when it is restyled in place (see `applyBlockStyle`).
 */
function leadsItemWithRest(doc: Node, pos: number): boolean {
  const $pos = doc.resolve(pos)
  if (!listItemTypes.includes($pos.parent.type.name) || $pos.index() !== 0) return false
  const next = $pos.parent.maybeChild(1)
  return !!next && next.type.name !== 'paragraph'
}

/**
 * Applies a block style to the selected text only. The selection is split at its ends first, so the selected blocks
 * are whole textblocks. Then:
 * - heading, code block: each block's type changes in place, so a block in a list item stays in its item (the first
 *   paragraph of an item leaves the list first, see below);
 * - quote: the selected blocks of one parent are wrapped in one quote, or lifted out of their quote when `active`;
 * - a list: when `active` (the selection starts in that list), a selected block of that list is lifted out of it (the
 *   toggle); otherwise each selected block that is not in that list becomes an item of it (see `makeListItem`).
 * Unselected text keeps its list, and each ordered item keeps its number (`keepNumbers`).
 */
export function applyBlockStyle(tr: Transaction, style: BlockStyle, active: boolean) {
  // A heading or checklist item cannot keep a line break when it is saved, so the breaks it covers are split out.
  const blocks = splitSelection(tr, style === 'heading' || style === 'taskList')
  if (!blocks.length) return
  const { from, to } = tr.selection
  const numbers = orderedNumbers(tr.doc)
  const mark = tr.mapping.maps.length
  const at = (block: number) => tr.mapping.slice(mark).map(block, 1)
  const schema = tr.doc.type.schema
  if (!isListKind(style)) {
    // A toggle takes off only the blocks of its kind: the others keep their style and their place.
    const kind = style === 'code' ? 'codeBlock' : 'heading'
    const ofKind = (block: number) =>
      style === 'quote' ? inQuote(tr.doc.resolve(block)) : tr.doc.nodeAt(block)?.type.name === kind
    const changed = blocks.filter(
      (block) =>
        (!active || ofKind(block)) && !leadsItemWithRest(tr.doc, block) && insideValid(tr.doc, block),
    )
    // A list item starts with its paragraph, so a first paragraph that is followed by another paragraph leaves its list
    // and the next paragraph becomes the first of the item. (A first paragraph followed by a list, quote or code block
    // is left as it is above: no paragraph can stand in front of that rest, and markdown cannot write an empty one.)
    for (const block of changed) {
      const pos = at(block)
      const $pos = tr.doc.resolve(pos)
      if (!listItemTypes.includes($pos.parent.type.name) || $pos.index() !== 0) continue
      liftBlock(tr, pos, false)
    }
    if (style === 'quote') applyQuote(tr, changed, active, at)
    else
      for (const block of changed) {
        const pos = at(block)
        const node = tr.doc.nodeAt(pos)
        if (!node) continue
        const type = style === 'code' ? schema.nodes.codeBlock : schema.nodes.heading
        const target = active ? schema.nodes.paragraph : type
        tr.setBlockType(
          pos + 1,
          pos + node.nodeSize - 1,
          target,
          target === schema.nodes.heading ? { level: 2 } : undefined,
        )
      }
  } else {
    // A block inside a node with invalid content stays where it is, as in the other styles (see `insideValid`).
    for (const block of blocks.filter((b) => insideValid(tr.doc, b))) {
      const pos = at(block)
      const node = tr.doc.nodeAt(pos)
      if (!node) continue
      const inList = listOf(tr.doc, pos) === style
      const $pos = tr.doc.resolve(pos)
      const quotedInItem = $pos.parent.type.name === 'blockquote' && listOf(tr.doc, $pos.before()) === style
      if (active && inList) liftBlock(tr, pos)
      else if (active && quotedInItem) leaveListQuoted(tr, pos)
      else if (!active && !inList) {
        // A list item holds paragraphs, so a heading or code block becomes a paragraph before it is listed.
        if (node.type.name !== 'paragraph')
          tr.setBlockType(pos + 1, pos + node.nodeSize - 1, schema.nodes.paragraph)
        makeListItem(tr, pos, style)
      }
    }
  }
  keepNumbers(tr, numbers)
  const map = tr.mapping.slice(mark)
  tr.setSelection(
    tr.selection instanceof AllSelection
      ? new AllSelection(tr.doc)
      : TextSelection.create(tr.doc, map.map(from, 1), map.map(to, -1)),
  )
}

/**
 * The quote of the blocks: the selected blocks of one parent go into one quote (consecutive ones, from the first to the
 * last), or, when `active`, are lifted out of their quote.
 */
function applyQuote(tr: Transaction, blocks: number[], active: boolean, at: (block: number) => number) {
  if (active) {
    // A quoted block of a list item leaves the list first, so the quote can be lifted from around it.
    for (const block of blocks) {
      const pos = at(block)
      if (listItemTypes.includes(tr.doc.resolve(pos).parent.type.name)) liftBlock(tr, pos)
    }
  }
  const groups: number[][] = []
  // The parent of a block is the one its position is in: the document, or the start of its container.
  const parentOf = (pos: number) => (tr.doc.resolve(pos).depth ? tr.doc.resolve(pos).before() : -1)
  // The lifts above moved some blocks, so the positions are taken as they are now.
  for (const block of blocks.map((b) => at(b))) {
    const last = groups[groups.length - 1]
    if (last && parentOf(block) === parentOf(last[0])) last.push(block)
    else groups.push([block])
  }
  for (const group of groups.reverse()) {
    const first = tr.doc.resolve(group[0])
    const lastBlock = group[group.length - 1]
    const end = lastBlock + tr.doc.nodeAt(lastBlock)!.nodeSize
    const range = first.blockRange(tr.doc.resolve(end))
    if (!range) continue
    if (active) {
      const target = first.parent.type.name === 'blockquote' ? liftTarget(range) : null
      if (target !== null) tr.lift(range, target)
    } else {
      const wrapping = findWrapping(range, tr.doc.type.schema.nodes.blockquote)
      if (wrapping) tr.wrap(range, wrapping)
    }
  }
}

/** Wraps the block at `pos` in a quote of its own. */
function wrapInQuote(tr: Transaction, pos: number) {
  const node = tr.doc.nodeAt(pos)!
  const range = tr.doc.resolve(pos).blockRange(tr.doc.resolve(pos + node.nodeSize))
  const wrapping = range && findWrapping(range, tr.doc.type.schema.nodes.blockquote)
  if (range && wrapping) tr.wrap(range, wrapping)
}

/**
 * A quoted block of a list item, when its list is toggled off: the block leaves its quote and its list, and goes back
 * into a quote of its own, so only the list changes.
 */
function leaveListQuoted(tr: Transaction, pos: number) {
  const node = tr.doc.nodeAt(pos)!
  const range = tr.doc.resolve(pos).blockRange(tr.doc.resolve(pos + node.nodeSize))
  const target = range && liftTarget(range)
  if (!range || target == null) return
  const mark = tr.mapping.maps.length
  tr.lift(range, target)
  const block = tr.mapping.slice(mark).map(pos, 1)
  // A rest of the item that is not a paragraph (another quote) starts with an empty one, so the item stays valid.
  const $block = tr.doc.resolve(block)
  const next = $block.parent.maybeChild($block.index() + 1)
  if (next && next.type.name !== 'paragraph')
    tr.insert(block + tr.doc.nodeAt(block)!.nodeSize, tr.doc.type.schema.nodes.paragraph.create())
  const moved = liftBlock(tr, block)
  wrapInQuote(tr, moved ? moved.pos : block)
}

/**
 * Runs a block style on the selected text only (see `applyBlockStyle`). With no text selected (a caret, or a selection
 * that covers no character), the editor's own toggle takes the whole paragraph or item, as before; a selection of
 * empty lines takes it over the lines themselves.
 */
export function toggleBlock(editor: Editor, style: BlockStyle) {
  const { from, to, empty } = editor.state.selection
  if (empty) {
    editor.chain().focus().setTextSelection(from).run()
    caretToggle(style)(editor.chain().focus()).run()
    return
  }
  const { doc } = editor.state
  if (doc.textBetween(from, to).replace(/\n/g, '').length === 0) {
    // A selection of line breaks alone has no text to restyle; one of empty lines has no break either.
    if (doc.textBetween(from, to, undefined, '\n')) return
    caretToggle(style)(editor.chain().focus()).run()
    return
  }
  const active = styleActive(editor, style)
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      applyBlockStyle(tr, style, active)
      return true
    })
    .run()
}

/** The editor's own toggle of a style, for a caret. */
function caretToggle(style: BlockStyle): (chain: ChainedCommands) => ChainedCommands {
  switch (style) {
    case 'heading':
      return (c) => c.toggleHeading({ level: 2 })
    case 'quote':
      return (c) => c.toggleBlockquote()
    case 'code':
      return (c) => c.toggleCodeBlock()
    case 'bulletList':
      return (c) => c.toggleBulletList()
    case 'orderedList':
      return (c) => c.toggleOrderedList()
    case 'taskList':
      return (c) => c.toggleTaskList()
  }
}

function Toolbar({
  editor,
  onAttach,
  attaching,
}: {
  editor: Editor
  onAttach?: () => void
  attaching: boolean
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      heading: e.isActive('heading', { level: 2 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
    }),
  })
  const chain = () => editor.chain().focus()
  const link = () => {
    if (state.link) return chain().unsetLink().run()
    const href = window.prompt('Link to')?.trim()
    if (href) chain().extendMarkRange('link').setLink({ href }).run()
  }
  const buttons = [
    { label: 'Bold', icon: Bold, on: state.bold, run: () => chain().toggleBold().run() },
    { label: 'Italic', icon: Italic, on: state.italic, run: () => chain().toggleItalic().run() },
    {
      label: 'Strikethrough',
      icon: Strikethrough,
      on: state.strike,
      run: () => chain().toggleStrike().run(),
    },
    { label: 'Inline code', icon: Code, on: state.code, run: () => chain().toggleCode().run() },
    {
      label: 'Heading',
      icon: Heading2,
      on: state.heading,
      run: () => toggleBlock(editor, 'heading'),
    },
    {
      label: 'Bullet list',
      icon: List,
      on: state.bullet,
      run: () => toggleBlock(editor, 'bulletList'),
    },
    {
      label: 'Numbered list',
      icon: ListOrdered,
      on: state.ordered,
      run: () => toggleBlock(editor, 'orderedList'),
    },
    {
      label: 'Checklist',
      icon: ListChecks,
      on: state.task,
      run: () => toggleBlock(editor, 'taskList'),
    },
    {
      label: 'Quote',
      icon: Quote,
      on: state.quote,
      run: () => toggleBlock(editor, 'quote'),
    },
    {
      label: 'Code block',
      icon: SquareCode,
      on: state.codeBlock,
      run: () => toggleBlock(editor, 'code'),
    },
    { label: 'Link', icon: Link2, on: state.link, run: link },
  ]
  const attachLabel = attaching ? 'Attaching files…' : 'Attach files'
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-0.5 border-b px-1.5 py-1">
      {onAttach && (
        <Tip content={attachLabel}>
          <button
            type="button"
            aria-label={attachLabel}
            aria-busy={attaching}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAttach}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {attaching ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
          </button>
        </Tip>
      )}
      {buttons.map((b) => (
        <Tip key={b.label} content={b.label}>
          <button
            type="button"
            aria-label={b.label}
            aria-pressed={b.on}
            // Keep the selection in the text while clicking a button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={b.run}
            className={cn(
              'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground',
              b.on && 'bg-muted text-foreground',
            )}
          >
            <b.icon className="size-3.5" />
          </button>
        </Tip>
      ))}
    </div>
  )
}
