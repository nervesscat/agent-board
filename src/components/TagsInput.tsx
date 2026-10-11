import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

import { Tag } from '#/components/Tag'
import { addTags, MAX_TAG_LENGTH, MAX_TAGS, overTagLimits, tagTooLong } from '#/lib/tags'
import { cn } from '#/lib/utils'

/**
 * Tags as chips inside one field, with the text being typed after them. Enter, a comma or leaving
 * the field for another control turns the text into chips (a switch to another window keeps it);
 * text pasted at once is split on its commas. A tag already there in any casing is not added again.
 * × removes a chip, and Backspace in the empty text the last one. Enter with no text is left to the
 * form, so it still submits. `text` is what is typed and not yet a chip: a form saves it too
 * (`addTags(value, text)`), so nothing typed is lost.
 *
 * Tags past the server's limits (`overTagLimits`) are not refused here: the field turns invalid, as
 * an `aria-invalid` input does, a line under it says which limit, and a chip too long is marked. The
 * form is the one to hold back its submit meanwhile.
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
  const over = overTagLimits(value, text)
  const invalid = over.tooMany || over.tooLong
  const messageId = useId()
  // The latest props, for a commit that runs after the render that scheduled it (after a reset too).
  const latest = useRef({ value, text, onChange, onTextChange })
  latest.current = { value, text, onChange, onTextChange }
  const commit = () => {
    const { value, text, onChange, onTextChange } = latest.current
    if (text.trim()) onChange(addTags(value, text))
    if (text) onTextChange('')
  }
  // Whether a mouse button is held down (on a touch screen, from the tap's mousedown to its mouseup),
  // and the cancel of a commit waiting for that press to end.
  const pressing = useRef(false)
  const pending = useRef<() => void>(undefined)
  useEffect(() => {
    const ac = new AbortController()
    const opts = { capture: true, signal: ac.signal }
    window.addEventListener('mousedown', () => (pressing.current = true), opts)
    for (const type of ['mouseup', 'dragend'])
      window.addEventListener(type, () => (pressing.current = false), opts)
    return () => {
      ac.abort()
      pending.current?.()
    }
  }, [])
  return (
    <>
      {/* A click on the field around the chips goes to the text, as it would in a plain input. Pressing
          the box would take the focus from the text first, and that blur would end the word being
          typed: the press keeps the focus in the text instead, with the caret at its end. Invalid, it
          looks as `ui/input` does with `aria-invalid`, focused too. */}
      <div
        onMouseDown={(e) => {
          const el = input.current
          if (e.target !== e.currentTarget || !el) return
          e.preventDefault()
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }}
        data-invalid={invalid || undefined}
        className={cn(
          'flex min-h-8 w-full min-w-0 cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2.5 py-0.5 text-base transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-invalid:border-destructive data-invalid:ring-3 data-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:data-invalid:border-destructive/50 dark:data-invalid:ring-destructive/40',
          className,
        )}
      >
        {value.map((tag) => {
          const tooLong = tagTooLong(tag)
          return (
            <Tag
              key={tag}
              tag={tag}
              data-invalid={tooLong || undefined}
              title={tooLong ? `More than ${MAX_TAG_LENGTH} characters` : undefined}
              className="max-w-full cursor-default items-center gap-0.5 pr-0.5 break-all data-invalid:ring-1 data-invalid:ring-destructive"
            >
              <button
                type="button"
                // Out of the Tab order, so Tab reaches the text as in any field; Backspace removes
                // from the keyboard. Pressing it keeps the focus where it is.
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
          )
        })}
        <input
          ref={input}
          id={id}
          value={text}
          placeholder={value.length ? undefined : placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
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
          // waits there for the return. A press that takes the focus commits only once it is released
          // and has clicked: a chip can grow the field and move what is under the pointer, so that the
          // release would miss it. If the focus came back (a press on the field's label), nothing left.
          onBlur={() => {
            if (!document.hasFocus()) return
            if (!pressing.current) return commit()
            pending.current?.()
            pending.current = afterPress(() => {
              pending.current = undefined
              if (document.activeElement !== input.current) commit()
            })
          }}
          className="h-6 min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
      {invalid && (
        <p id={messageId} className="text-xs text-destructive">
          {[
            over.tooMany && `At most ${MAX_TAGS} tags.`,
            over.tooLong && `A tag can have at most ${MAX_TAG_LENGTH} characters.`,
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
    </>
  )
}

/**
 * Runs `fn` once the mouse button held down now is released, after the click that release makes.
 * Returns its cancel.
 */
function afterPress(fn: () => void) {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = () => {
    ac.abort()
    timer = setTimeout(fn)
  }
  for (const type of ['mouseup', 'dragend'])
    window.addEventListener(type, end, { capture: true, signal: ac.signal })
  return () => {
    ac.abort()
    clearTimeout(timer)
  }
}
