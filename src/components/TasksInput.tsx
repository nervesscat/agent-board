import { Plus, X } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
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
              <button
                type="button"
                className="mt-0.5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                aria-label={`Remove ${task}`}
                title="Remove"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key !== 'Enter') return
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
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={!text.trim()}
          onClick={() => add()}
          aria-label="Add task"
          title="Add task"
        >
          <Plus />
        </Button>
      </div>
    </div>
  )
}
