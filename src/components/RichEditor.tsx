import { type ChainedCommands, type Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { type Node } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
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
 * blocks, where blank lines are part of the code.
 */
export function tidy(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, '\n\n')))
    .join('')
    .trimEnd()
}

/** What the editor understands; each one reads and writes its own markdown. */
export function richExtensions(placeholder = '') {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
    Markdown,
    Image,
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
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

/** The list kind the selection starts in, innermost first: a bullet item in a numbered item is a bullet item here. */
function innermostList(editor: Editor): string | undefined {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') return name
  }
  return undefined
}

/** Whether the selection, where it starts, is already in `style` (a toggle then turns it off). */
function styleActive(editor: Editor, style: BlockStyle): boolean {
  if (isListKind(style)) return innermostList(editor) === style
  if (style === 'heading') return editor.isActive('heading', { level: 2 })
  if (style === 'quote') return editor.isActive('blockquote')
  return editor.isActive('codeBlock')
}

/**
 * Splits the textblocks the selection touches at its ends, so the selection covers whole textblocks, and returns the
 * positions of those blocks (none for a selection that is not text, or covers no character). A split beside a line
 * break would leave the break in a block of its own, so there the break stays where it is.
 */
function splitSelection(tr: Transaction): number[] {
  if (!(tr.selection instanceof TextSelection) || tr.selection.empty) return []
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
  // A selection that ends right before a break: the split goes there, and the break goes, as at a start after one.
  const beforeBreak = (pos: number) => {
    const $pos = tr.doc.resolve(pos)
    return $pos.parent.isTextblock && $pos.parentOffset > 0 && $pos.nodeAfter?.type.name === 'hardBreak'
  }
  const splitTo = splittable(to)
  const splitFrom = splittable(from)
  const breakFrom = !splitFrom && afterBreak(from)
  const breakTo = !splitTo && beforeBreak(to)
  // The end first: the start is before it, so its position does not move.
  if (splitTo) tr.split(to)
  if (breakTo) {
    tr.split(to)
    tr.delete(to + 2, to + 3) // the break now starts the block after the split
  }
  if (splitFrom) tr.split(from)
  if (breakFrom) {
    tr.split(from)
    tr.delete(from - 1, from)
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

/** The size of the nested lists that follow the block at `pos` in its list item: they go with the block when it moves. */
function nestedSize(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  if (!listItemTypes.includes($pos.parent.type.name)) return 0
  let size = 0
  for (
    let i = $pos.index() + 1;
    i < $pos.parent.childCount && listTypes.includes($pos.parent.child(i).type.name);
    i++
  ) {
    size += $pos.parent.child(i).nodeSize
  }
  return size
}

/**
 * Lifts the block at `pos`, with the nested lists that follow it in its item, out of the list it sits in, one level (the
 * library's `lift`, which splits the item and its list around the block). Returns where the block is now, and the size
 * of the nested lists that came with it, or null when it cannot be lifted.
 */
function liftBlock(tr: Transaction, pos: number): { pos: number; nested: number } | null {
  const nested = nestedSize(tr.doc, pos)
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
  // A new list next to a list of its kind is the same list: they join.
  const made = tr.doc.nodeAt(at)!
  if (tr.doc.resolve(at + made.nodeSize).nodeAfter?.type === schema.nodes[list]) tr.join(at + made.nodeSize)
  if (tr.doc.resolve(at).nodeBefore?.type === schema.nodes[list]) tr.join(at)
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
    node.forEach((item, _offset, index) => {
      if (start !== undefined) return
      const number = item.firstChild ? numbers.get(item.firstChild) : undefined
      if (number !== undefined) start = number - index
    })
    if (start !== undefined && start !== node.attrs.start) starts.push({ pos, node, start })
    return true
  })
  for (const { pos, node, start } of starts) tr.setNodeMarkup(pos, undefined, { ...node.attrs, start })
}

/**
 * Applies a block style to the selected text only. The selection is split at its ends first, so the selected blocks
 * are whole textblocks. Then:
 * - heading, code block: each block's type changes in place, so a block in a list item stays in its item;
 * - quote: the selected blocks of one parent are wrapped in one quote, or lifted out of their quote when `active`;
 * - a list: when `active` (the selection starts in that list), a selected block of that list is lifted out of it (the
 *   toggle); otherwise each selected block that is not in that list becomes an item of it (see `makeListItem`).
 * Unselected text keeps its list, and each ordered item keeps its number (`keepNumbers`).
 */
export function applyBlockStyle(tr: Transaction, style: BlockStyle, active: boolean) {
  const blocks = splitSelection(tr)
  if (!blocks.length) return
  const { from, to } = tr.selection
  const numbers = orderedNumbers(tr.doc)
  const mark = tr.mapping.maps.length
  const at = (block: number) => tr.mapping.slice(mark).map(block, 1)
  if (!isListKind(style)) {
    // A list item starts with its paragraph, so a block that starts its item cannot take a heading, a code block or a
    // quote in its place: it is lifted out of its list first (the rest of the item stays where it was).
    for (const block of blocks) {
      const $pos = tr.doc.resolve(at(block))
      if (listItemTypes.includes($pos.parent.type.name) && $pos.index() === 0) liftBlock(tr, at(block))
    }
  }
  if (style === 'quote') {
    // The blocks of one parent go into one quote: consecutive ones, from the first to the last.
    const groups: number[][] = []
    // The parent of a block is the one its position is in: the document, or the start of its container.
    const parentOf = (pos: number) => (tr.doc.resolve(pos).depth ? tr.doc.resolve(pos).before() : -1)
    for (const block of blocks) {
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
  } else {
    for (const block of blocks) {
      const pos = at(block)
      const node = tr.doc.nodeAt(pos)
      if (!node) continue
      if (isListKind(style)) {
        const inList = listOf(tr.doc, pos) === style
        if (active && inList) liftBlock(tr, pos)
        else if (!active && !inList) makeListItem(tr, pos, style)
      } else {
        const schema = tr.doc.type.schema
        const type = style === 'code' ? schema.nodes.codeBlock : schema.nodes.heading
        const target = active ? schema.nodes.paragraph : type
        tr.setBlockType(
          pos + 1,
          pos + node.nodeSize - 1,
          target,
          target === schema.nodes.heading ? { level: 2 } : undefined,
        )
      }
    }
  }
  keepNumbers(tr, numbers)
  const map = tr.mapping.slice(mark)
  tr.setSelection(TextSelection.create(tr.doc, map.map(from, 1), map.map(to, -1)))
}

/**
 * Runs a block style on the selected text only (see `applyBlockStyle`). With no text selected (a caret, or a selection
 * that covers no character), the editor's own toggle takes the whole paragraph or item, as before.
 */
export function toggleBlock(editor: Editor, style: BlockStyle) {
  const { from, to, empty } = editor.state.selection
  if (empty || editor.state.doc.textBetween(from, to).length === 0) {
    editor.chain().focus().setTextSelection(from).run()
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
