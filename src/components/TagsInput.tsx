import { X } from 'lucide-react'
import { useRef } from 'react'

import { Tag } from '#/components/Tag'
import { addTags } from '#/lib/tags'
import { cn } from '#/lib/utils'

/**
 * Tags as chips inside one field, with the text being typed after them. Enter, a comma or leaving
 * the field for another control turns the text into chips (a switch to another window keeps it);
 * text pasted at once is split on its commas. A tag already there in any casing is not added again.
 * × removes a chip, and Backspace in the empty text the last one. Enter with no text is left to the
 * form, so it still submits. `text` is what is typed and not yet a chip: a form saves it too
 * (`addTags(value, text)`), so nothing typed is lost.
 */
export function TagsInput({
  id,
  value,
  onChange,
  text,
  onTextChange,
  placeholder,
  className,
}: {
  /** The text input's, for a `<Label htmlFor>`. */
  id?: string
  value: string[]
  onChange: (tags: string[]) => void
  text: string
  onTextChange: (text: string) => void
  placeholder?: string
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const commit = () => {
    if (text.trim()) onChange(addTags(value, text))
    if (text) onTextChange('')
  }
  return (
    // A click on the field around the chips goes to the text, as it would in a plain input. Pressing
    // the box would take the focus from the text first, and that blur would end the word being
    // typed: the press keeps the focus in the text instead, with the caret at its end.
    <div
      onMouseDown={(e) => {
        const el = input.current
        if (e.target !== e.currentTarget || !el) return
        e.preventDefault()
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }}
      className={cn(
        'flex min-h-8 w-full min-w-0 cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2.5 py-0.5 text-base transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 md:text-sm dark:bg-input/30',
        className,
      )}
    >
      {value.map((tag) => (
        <Tag key={tag} tag={tag} className="max-w-full cursor-default items-center gap-0.5 pr-0.5 break-all">
          <button
            type="button"
            // Out of the Tab order, so Tab reaches the text as in any field; Backspace removes from
            // the keyboard. Pressing it keeps the focus where it is.
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
            aria-label={`Remove ${tag}`}
            title="Remove"
          >
            <X className="size-3" />
          </button>
        </Tag>
      ))}
      <input
        ref={input}
        id={id}
        value={text}
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => {
          const next = e.target.value
          if (!next.includes(',')) return onTextChange(next)
          const parts = next.split(',')
          // A comma typed ends the tag before it; text pasted (or filled in) at once is all tags.
          const event = e.nativeEvent as InputEvent
          const typed = event.inputType === 'insertText' && (event.data ?? '').length <= 1
          const rest = typed ? parts.pop()! : ''
          onChange(addTags(value, parts.join(',')))
          onTextChange(rest.trimStart())
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && text.trim()) {
            // A chip, not the form submitted.
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !text && value.length) {
            e.preventDefault()
            onChange(value.slice(0, -1))
          }
        }}
        // The window losing the focus (to another window or tab) is not leaving the field: the word
        // waits there for the return.
        onBlur={() => {
          if (document.hasFocus()) commit()
        }}
        className="h-6 min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
