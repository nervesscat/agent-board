import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
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
  Quote,
  SquareCode,
  Strikethrough,
} from 'lucide-react'
import { useEffect, useRef } from 'react'

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

/**
 * Rich text in, markdown out: what agents write and read stays markdown, people get formatting
 * buttons instead of syntax. Tables, task lists, code and images round-trip. Files pasted or dropped
 * go to `onFiles` (the caller attaches them) instead of into the text. Ctrl/⌘+Enter calls `onSubmit`,
 * Esc `onCancel`.
 */
export function RichEditor({
  value,
  onChange,
  placeholder,
  onFiles,
  onSubmit,
  onCancel,
  autoFocus = false,
  minHeight = 'min-h-20',
  label = 'Text',
  className,
}: {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  onFiles?: (files: File[]) => void
  onSubmit?: () => void
  onCancel?: () => void
  autoFocus?: boolean
  minHeight?: string
  /** Accessible name of the editing area. */
  label?: string
  className?: string
}) {
  // The latest callbacks, for handlers the editor captured when it was created.
  const handlers = useRef({ onChange, onFiles, onSubmit, onCancel })
  handlers.current = { onChange, onFiles, onSubmit, onCancel }
  const lastEmitted = useRef(value)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Markdown,
      Image,
      TableKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: value,
    contentType: 'markdown',
    // The server render has no editor; it appears once the page is live.
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
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

  return (
    <div
      className={cn(
        'rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        className,
      )}
    >
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
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
      run: () => chain().toggleHeading({ level: 2 }).run(),
    },
    { label: 'Bullet list', icon: List, on: state.bullet, run: () => chain().toggleBulletList().run() },
    {
      label: 'Numbered list',
      icon: ListOrdered,
      on: state.ordered,
      run: () => chain().toggleOrderedList().run(),
    },
    { label: 'Checklist', icon: ListChecks, on: state.task, run: () => chain().toggleTaskList().run() },
    { label: 'Quote', icon: Quote, on: state.quote, run: () => chain().toggleBlockquote().run() },
    {
      label: 'Code block',
      icon: SquareCode,
      on: state.codeBlock,
      run: () => chain().toggleCodeBlock().run(),
    },
    { label: 'Link', icon: Link2, on: state.link, run: link },
  ]
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-0.5 border-b px-1.5 py-1">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          title={b.label}
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
      ))}
    </div>
  )
}
