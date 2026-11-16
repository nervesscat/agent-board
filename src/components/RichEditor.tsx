import { type ChainedCommands, type Command, type Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
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
 * Lifts the block at `pos` (of `size`) out of the list item it sits in. A list item starts with a
 * paragraph, so a block that a nested list follows cannot be lifted as it is: the nested list goes out
 * first (it becomes a list of its own, after the item), and then the block can.
 */
function liftOutOfItem(tr: Transaction, pos: number, size: number) {
  const liftRange = (from: number, to: number) => {
    const range = tr.doc.resolve(from).blockRange(tr.doc.resolve(to))
    const target = range && liftTarget(range)
    if (!range || target == null) return false
    tr.lift(range, target)
    return true
  }
  if (liftRange(pos, pos + size)) return
  const itemEnd = tr.doc.resolve(pos).end()
  if (pos + size < itemEnd && liftRange(pos + size, itemEnd)) liftRange(pos, pos + size)
}

/**
 * A block style (heading, list, quote, code block) changes every block its selection touches, so a
 * selection inside one paragraph would change the whole paragraph. This splits the paragraph at the
 * selection's ends, and lifts the selected blocks out of the list items they sit in, so the style covers
 * the selected text only and the unselected text stays in its list. A block the selection only touches
 * at its edge (one that starts where the selection ends) is left alone. A collapsed caret is left alone,
 * and so is a selection that is not text.
 */
export const narrowToSelection: Command = ({ tr }) => {
  if (!(tr.selection instanceof TextSelection) || tr.selection.empty) return true
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
  if (!blocks.length) return true
  // From the last block back, so each lift leaves the positions of the blocks before it as they are.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { pos, size } = blocks[i]
    if (!listItemTypes.includes(tr.doc.resolve(pos).parent.type.name)) continue
    liftOutOfItem(tr, pos, size)
  }
  const map = tr.mapping.slice(mark)
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      map.map(blocks[0].pos + 1, 1),
      map.map(blocks[blocks.length - 1].contentEnd, -1),
    ),
  )
  return true
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
 * Runs a block style on the selected text only (see `narrowToSelection`). `list` names the list the style
 * is: a selection already in that list is taken out of it and nothing more. Inline marks do not need it.
 */
export function toggleBlock(
  editor: Editor,
  toggle: (chain: ChainedCommands) => ChainedCommands,
  list?: 'bulletList' | 'orderedList' | 'taskList',
) {
  if (editor.state.selection.empty) {
    toggle(editor.chain().focus()).run()
    return
  }
  // The narrowing is a transaction of its own: the commands of one chain read the state from before it.
  const wasOn = list !== undefined && innermostList(editor) === list
  editor.chain().focus().command(narrowToSelection).run()
  if (wasOn) return
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
