import { Plus, X } from 'lucide-react'
import { useRef } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Tip } from '#/components/ui/tooltip'
import { addTasks } from '#/lib/tasks'

/**
 * A list of tasks with an input below it: Enter or + adds the text typed as the last task, trimmed.
 * Enter never submits the form, not even with no text, so listing tasks never creates anything early.
 * Text pasted with several lines adds one task per line. × removes that task. `text` is what is typed
 * and not yet a task: a form saves it too (`addTasks(value, text)`), so nothing typed is lost.
 */
export function TasksInput({
  id,
  value,
  onChange,
  text,
  onTextChange,
}: {
  /** The text input's, for a `<Label htmlFor>`. */
  id?: string
  value: string[]
  onChange: (tasks: string[]) => void
  text: string
  onTextChange: (text: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const add = (typed = text) => {
    if (!typed.trim()) return
    onChange(addTasks(value, typed))
    onTextChange('')
  }
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul aria-label="Tasks" className="space-y-1.5">
          {value.map((task, i) => (
            // Two tasks may read the same, and a task here has no id of its own yet.
            <li key={i} className="flex items-start gap-2 text-sm">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0 flex-1 wrap-anywhere">{task}</span>
              <Tip content="Remove">
                <button
                  type="button"
                  className="mt-0.5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  aria-label={`Remove ${task}`}
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
            // An Enter that commits an IME conversion is not a task. Safari ends the composition just
            // before that keydown, so only its keyCode 229 tells it apart.
            if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return
            // A task, never the form submitted.
            e.preventDefault()
            add()
          }}
          onPaste={(e) => {
            // An input drops the line breaks of what is pasted, which would make one task of many.
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
          placeholder="Add a task"
        />
        <Tip content="Add task">
          <Button
            type="button"
            size="icon"
            variant="outline"
            // Off only to the eye and to assistive tech while there is no text: a disabled button drops
            // the focus out of the dialog, both when it turns off under the focus and when it is pressed
            // (the second click of a double-click). A press on it adds what there is, which may be
            // nothing, and puts the focus back in the text, where the next task is typed.
            aria-disabled={!text.trim() || undefined}
            className="aria-disabled:opacity-50 aria-disabled:hover:bg-background dark:aria-disabled:hover:bg-input/30"
            onClick={() => {
              add()
              input.current?.focus()
            }}
            aria-label="Add task"
          >
            <Plus />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
