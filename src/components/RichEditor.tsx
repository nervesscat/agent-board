import { type ChainedCommands, type Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { type NodeType, type ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { liftTarget } from '@tiptap/pm/transform'
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

/** The list items a block can sit in: the lift takes a block out of one of these. */
const listItemTypes = ['listItem', 'taskItem']

/**
 * Lifts the block at `pos` (of `size`) out of the list item it sits in, one level. A list item starts
 * with a paragraph, so a block that a nested list follows cannot be lifted as it is: the nested list goes
 * out first (it becomes a list of its own, after the item), and then the block can. Returns the block's
 * position after the lift, or null when it could not be lifted.
 */
function liftOutOfItem(tr: Transaction, pos: number, size: number): number | null {
  const liftRange = (from: number, to: number) => {
    const range = tr.doc.resolve(from).blockRange(tr.doc.resolve(to))
    const target = range && liftTarget(range)
    if (!range || target == null) return false
    tr.lift(range, target)
    return true
  }
  const mark = tr.mapping.maps.length
  if (!liftRange(pos, pos + size)) {
    const itemEnd = tr.doc.resolve(pos).end()
    if (!(pos + size < itemEnd && liftRange(pos + size, itemEnd)) || !liftRange(pos, pos + size)) return null
  }
  return tr.mapping.slice(mark).map(pos, 1)
}

/**
 * How far the selected blocks are lifted out of their list items. `list` names the list a list style
 * applies to: a block already in an item of that list stays in it, and the style makes a list of its own
 * there. `once` lifts a block one level only (a toggle-off takes the block out of its own item, no further).
 */
export type Keep = { list?: string; once?: boolean }

/**
 * A block style (heading, list, quote, code block) changes every block its selection touches, so a
 * selection inside one paragraph would change the whole paragraph. This splits the paragraph at the
 * selection's ends, and lifts the selected blocks out of the list items they sit in (as `keep` says), so
 * the style covers the selected text only and the unselected text stays in its list. A block the selection
 * only touches at its edge (one that starts where the selection ends) is left alone. A collapsed caret is
 * left alone, and so is a selection that is not text.
 */
export function narrowBlocks(tr: Transaction, keep: Keep = {}): { converted: boolean } {
  if (!(tr.selection instanceof TextSelection) || tr.selection.empty) return { converted: false }
  const { from, to } = tr.selection
  // Both checks read the document before either split, so they are about the same paragraphs.
  const inside = (pos: number) => {
    const $pos = tr.doc.resolve(pos)
    return $pos.parent.isTextblock && $pos.parentOffset > 0 && $pos.parentOffset < $pos.parent.content.size
  }
  const splitTo = inside(to)
  const splitFrom = inside(from)
  // The end first: the start is before it, so its position does not move.
  if (splitTo) tr.split(to)
  if (splitFrom) tr.split(from)
  // Mapped through the splits: a start that was split lands in the new paragraph, an end that was
  // split lands at the end of the old one.
  const start = tr.mapping.map(from, 1)
  const end = tr.mapping.map(to, -1)
  const mark = tr.mapping.maps.length
  const blocks: { pos: number; size: number; contentEnd: number }[] = []
  tr.doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return true
    const contentStart = pos + 1
    const contentEnd = contentStart + node.content.size
    if (contentStart < end && contentEnd > start) blocks.push({ pos, size: node.nodeSize, contentEnd })
    return false
  })
  if (!blocks.length) return { converted: false }
  const listType = keep.list ? tr.doc.type.schema.nodes[keep.list] : undefined
  let converted: { from: number; to: number } | null = null
  // From the first block on. A block's lift leaves the blocks before it where they are, and the blocks
  // after it are found again by mapping their positions through every step since `mark`.
  for (let i = 0; i < blocks.length; i++) {
    const { size } = blocks[i]
    let pos = tr.mapping.slice(mark).map(blocks[i].pos, 1)
    const $pos = tr.doc.resolve(pos)
    // Only a selection of one block is converted: converting an item replaces its list (positions move), and
    // the toggle that styles the other blocks would then skip them (see toggleBlock). A selection over several
    // blocks takes the lifting path below.
    if (blocks.length === 1 && listType && !keep.once && isWholeItemOf(tr, $pos, size, keep.list)) {
      // The item is only this block and nested lists: the item itself moves into a list of the style's
      // type, its nested lists stay inside it. The block keeps its position (the item's start and the
      // block's start do not move), so the selection is the block's text.
      convertItemTo(tr, $pos.before(), listType)
      converted = { from: pos + 1, to: pos + size - 1 }
      continue
    }
    // Out of the list items it sits in, the innermost first, so a block of a nested list ends up outside the lists.
    for (;;) {
      const $inner = tr.doc.resolve(pos)
      if (!listItemTypes.includes($inner.parent.type.name)) break
      if ($inner.node($inner.depth - 1).type.name === keep.list) break
      const next = liftOutOfItem(tr, pos, size)
      if (next === null) break
      pos = next
      if (keep.once) break
    }
  }
  const map = tr.mapping.slice(mark)
  // A converted last block keeps its own positions (its item's replacement does not move them), and the
  // blocks before it are mapped as usual.
  const textEnd = converted ? converted.to : map.map(blocks[blocks.length - 1].contentEnd, -1)
  const textStart = converted && blocks.length === 1 ? converted.from : map.map(blocks[0].pos + 1, 1)
  tr.setSelection(TextSelection.create(tr.doc, textStart, textEnd))
  return { converted: converted !== null }
}

/**
 * Moves the list item at `itemPos` into a list of `listType` of its own, in its place: its list is split
 * around it, and only that piece changes type. Its nested lists stay inside it.
 */
function convertItemTo(tr: Transaction, itemPos: number, listType: NodeType): void {
  const $item = tr.doc.resolve(itemPos)
  const list = $item.parent
  const index = $item.index()
  const size = $item.nodeAfter?.nodeSize ?? 0
  let p = itemPos
  if (index > 0) {
    tr.split(p, 1)
    p += 2 // the split put a closing and an opening token of the list in front of the item
  }
  if (index < list.childCount - 1) tr.split(p + size, 1)
  const listPos = tr.doc.resolve(p).before()
  if (listType.name !== 'taskList') {
    tr.setNodeMarkup(listPos, listType)
    return
  }
  // A task list holds task items: the one-item list is replaced by a task list whose item is unchecked and
  // keeps the item's content (its nested lists included). One step, so the intermediate document stays valid.
  const piece = tr.doc.nodeAt(listPos)
  if (!piece) return
  const item = piece.firstChild
  if (!item) return
  const taskItem = listType.schema.nodes.taskItem.create({ checked: false }, item.content)
  tr.replaceWith(listPos, listPos + piece.nodeSize, listType.create(piece.attrs, taskItem))
}

/**
 * True when the item at `$pos` (a block of `size` at its start) is that block and nested lists of `list`'s
 * kind and no other text: the whole item is what the style applies to, and the item is `listItem`.
 */
function isWholeItemOf(tr: Transaction, $pos: ResolvedPos, size: number, list: string | undefined): boolean {
  const item = $pos.parent
  if (list !== 'bulletList' && list !== 'orderedList' && list !== 'taskList') return false
  if (item.type.name !== 'listItem' || $pos.index() !== 0) return false
  if (item.childCount < 2 || item.child(0).nodeSize !== size || !item.child(0).isTextblock) return false
  for (let i = 1; i < item.childCount; i++) {
    const name = item.child(i).type.name
    if (name !== 'bulletList' && name !== 'orderedList' && name !== 'taskList') return false
  }
  return $pos.node($pos.depth - 1).type.name !== list && tr.doc.type.schema.nodes[list] !== undefined
}

/**
 * The list the selection sits in, innermost first: a bullet item in a numbered item is a bullet item
 * for this purpose, so a numbered style on its word is not taken for a toggle-off of the numbered list.
 */
function innermostList(editor: Editor): string | undefined {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') return name
  }
  return undefined
}

/**
 * Runs a block style on the selected text only (see `narrowBlocks`). `list` names the list the style
 * is: a selection already in that list is taken out of it and nothing more. Inline marks do not need it.
 */
export function toggleBlock(
  editor: Editor,
  toggle: (chain: ChainedCommands) => ChainedCommands,
  list?: 'bulletList' | 'orderedList' | 'taskList',
) {
  const { from, to } = editor.state.selection
  if (editor.state.selection.empty || editor.state.doc.textBetween(from, to).length === 0) {
    // No character is selected (a caret, or a selection that only crosses a paragraph break): the style
    // goes on the paragraph the selection starts in, as for a caret.
    editor.chain().focus().setTextSelection(from).run()
    toggle(editor.chain().focus()).run()
    return
  }
  // The narrowing is a transaction of its own: the commands of one chain read the state from before it.
  const wasOn = list !== undefined && innermostList(editor) === list
  const keep: Keep = list === undefined ? {} : wasOn ? { once: true } : { list }
  let converted = false
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      converted = narrowBlocks(tr, keep).converted
      return true
    })
    .run()
  if (wasOn || converted) return
  if (list && innermostList(editor)) {
    // The selected text is still inside another list (a bullet item in a numbered one): the list is made
    // around it, nested there. A toggle would take it for the outer list and undo that list instead.
    editor.chain().focus().wrapInList(list).run()
    return
  }
  toggle(editor.chain().focus()).run()
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
      run: () => toggleBlock(editor, (c) => c.toggleHeading({ level: 2 })),
    },
    {
      label: 'Bullet list',
      icon: List,
      on: state.bullet,
      run: () => toggleBlock(editor, (c) => c.toggleBulletList(), 'bulletList'),
    },
    {
      label: 'Numbered list',
      icon: ListOrdered,
      on: state.ordered,
      run: () => toggleBlock(editor, (c) => c.toggleOrderedList(), 'orderedList'),
    },
    {
      label: 'Checklist',
      icon: ListChecks,
      on: state.task,
      run: () => toggleBlock(editor, (c) => c.toggleTaskList(), 'taskList'),
    },
    {
      label: 'Quote',
      icon: Quote,
      on: state.quote,
      run: () => toggleBlock(editor, (c) => c.toggleBlockquote()),
    },
    {
      label: 'Code block',
      icon: SquareCode,
      on: state.codeBlock,
      run: () => toggleBlock(editor, (c) => c.toggleCodeBlock()),
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
