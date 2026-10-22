import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Tip } from '#/components/ui/tooltip'
import { addTasks } from '#/lib/tasks'

/**
 * A list of items with an input below it: Enter or + adds the text typed as the last item, trimmed.
 * Enter never submits the form, not even with no text, so listing items never saves or creates
 * anything early. Text pasted with several lines adds one item per line. × removes that item. `text` is
 * what is typed and not yet an item: a form saves it too (`addTasks(value, text)`), so nothing typed is
 * lost. With `reorderable`, each item has buttons that move it up and down; the focus follows the item.
 */
export function ListInput({
  id,
  value,
  onChange,
  text,
  onTextChange,
  label = 'Tasks',
  placeholder = 'Add a task',
  addLabel = 'Add task',
  reorderable = false,
}: {
  /** The text input's, for a `<Label htmlFor>`. */
  id?: string
  value: string[]
  onChange: (items: string[]) => void
  text: string
  onTextChange: (text: string) => void
  /** The list's accessible name. */
  label?: string
  placeholder?: string
  /** The + button's name and tooltip. */
  addLabel?: string
  /** Up and down buttons on each item, for a list whose order matters. */
  reorderable?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // After a move, the button to focus: the same one on the item where it landed, or its other one when
  // the item reached the end that turns that one off.
  const [focusAfterMove, setFocusAfterMove] = useState<{ index: number; dir: 'up' | 'down' } | null>(null)
  useEffect(() => {
    if (!focusAfterMove) return
    const { index, dir } = focusAfterMove
    const atEnd = dir === 'up' ? index === 0 : index === value.length - 1
    const which = atEnd ? (dir === 'up' ? 'down' : 'up') : dir
    list.current?.querySelector<HTMLButtonElement>(`[data-move="${which}-${index}"]`)?.focus()
    setFocusAfterMove(null)
  }, [focusAfterMove, value.length])

  const add = (typed = text) => {
    if (!typed.trim()) return
    onChange(addTasks(value, typed))
    onTextChange('')
  }
  const move = (from: number, dir: 'up' | 'down') => {
    const to = dir === 'up' ? from - 1 : from + 1
    if (to < 0 || to >= value.length) return
    const next = [...value]
    ;[next[from], next[to]] = [next[to], next[from]]
    onChange(next)
    setFocusAfterMove({ index: to, dir })
  }
  const iconButton =
    'mt-0.5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30'
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul ref={list} aria-label={label} className="space-y-1.5">
          {value.map((item, i) => (
            // Two items may read the same, and an item here has no id of its own yet.
            <li key={i} className="flex items-start gap-2 text-sm">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0 flex-1 wrap-anywhere">{item}</span>
              {reorderable && (
                <>
                  <Tip content="Move up">
                    <button
                      type="button"
                      data-move={`up-${i}`}
                      className={iconButton}
                      disabled={i === 0}
                      onClick={() => move(i, 'up')}
                      aria-label={`Move ${item} up`}
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                  </Tip>
                  <Tip content="Move down">
                    <button
                      type="button"
                      data-move={`down-${i}`}
                      className={iconButton}
                      disabled={i === value.length - 1}
                      onClick={() => move(i, 'down')}
                      aria-label={`Move ${item} down`}
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                  </Tip>
                </>
              )}
              <Tip content="Remove">
                <button
                  type="button"
                  className={iconButton}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  aria-label={`Remove ${item}`}
                >
                  <X className="size-3.5" />
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          ref={input}
          id={id}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            // An Enter that commits an IME conversion is not an item. Safari ends the composition just
            // before that keydown, so only its keyCode 229 tells it apart.
            if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return
            // An item, never the form submitted.
            e.preventDefault()
            add()
          }}
          onPaste={(e) => {
            // An input drops the line breaks of what is pasted, which would make one item of many.
            const pasted = e.clipboardData.getData('text/plain')
            if (!/[\r\n]/.test(pasted)) return
            e.preventDefault()
            const el = e.currentTarget
            add(
              text.slice(0, el.selectionStart ?? text.length) +
                pasted +
                text.slice(el.selectionEnd ?? text.length),
            )
          }}
          placeholder={placeholder}
        />
        <Tip content={addLabel}>
          <Button
            type="button"
            size="icon"
            variant="outline"
            // Off only to the eye and to assistive tech while there is no text: a disabled button drops
            // the focus out of the dialog, both when it turns off under the focus and when it is pressed
            // (the second click of a double-click). A press on it adds what there is, which may be
            // nothing, and puts the focus back in the text, where the next item is typed.
            aria-disabled={!text.trim() || undefined}
            className="aria-disabled:opacity-50 aria-disabled:hover:bg-background dark:aria-disabled:hover:bg-input/30"
            onClick={() => {
              add()
              input.current?.focus()
            }}
            aria-label={addLabel}
          >
            <Plus />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
