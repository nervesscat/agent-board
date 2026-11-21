import { ArrowDown, Flag, Pencil, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

import { EditedChip } from '#/components/WorkflowChips'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import type { Complexity } from '#/lib/constants'
import { INSTRUCTIONS_MAX, type ResolvedStep } from '#/lib/workflow'
import { instructionsProblem } from '#/lib/workflowEdit'
import { cn } from '#/lib/utils'

/**
 * The hand-off after a step, drawn as the connector to the next one: what the step passes on and what the ticket
 * agent checks when it returns. The default text is the preset's; the human edits it in place (Save, or Cancel to
 * leave it) and Reset to default puts the preset's back. A blank text is the default too. The editor closes once
 * the text is saved; a refused save keeps it open with the draft and the reason. A saved text belongs to the
 * preset's step, not to the complexity on view, and the editor says so. The last step has no next one: its
 * connector ends the flow.
 */
export function WorkflowHandoff({
  step,
  next,
  last,
  complexity,
  defaultVaries,
  onSave,
}: {
  step: ResolvedStep
  /** The label of the step that follows, for the connector's heading. */
  next: string | null
  last: boolean
  /** The complexity on view: the hand-off shown is the one a ticket of it reads. */
  complexity: Complexity
  /** Whether this step's default hand-off reads differently at another complexity. */
  defaultVaries: boolean
  /** The instruction to keep, or null to go back to the default; answers with why it was not saved, else null. */
  onSave: (instructions: string | null) => Promise<string | null>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const field = useId()
  const editing = draft !== null
  const problem = draft === null ? null : instructionsProblem(draft)
  const count = draft?.trim().length ?? 0
  const close = () => {
    setDraft(null)
    setFailure(null)
  }
  const save = async () => {
    if (draft === null || problem || saving) return
    const text = draft.trim()
    setSaving(true)
    setFailure(null)
    // A blank text, or the default as it stands, is the default. The editor closes once it is kept.
    const error = await onSave(text === '' || text === step.handoffDefault ? null : text)
    setSaving(false)
    if (error === null) setDraft(null)
    else setFailure(error)
  }
  return (
    <div
      data-handoff={step.id}
      className={cn('grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3', step.skipped && 'opacity-60')}
    >
      <div className="flex justify-center pt-1.5" aria-hidden>
        <span className="z-[1] flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
          {last ? <Flag className="size-3" /> : <ArrowDown className="size-3" />}
        </span>
      </div>
      <div className="min-w-0 space-y-1.5 py-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            {last ? 'Result' : next ? `Hand-off to ${next}` : 'Hand-off'}
          </span>
          {step.edited.instructions && <EditedChip what="the hand-off instruction" />}
          {!editing && (
            <span className="ml-auto flex items-center gap-1">
              {step.edited.instructions && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Reset the ${step.label} hand-off to its default`}
                  onClick={() => onSave(null)}
                >
                  <RotateCcw data-icon="inline-start" /> Reset to default
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Edit the ${step.label} hand-off`}
                onClick={() => setDraft(step.handoff)}
              >
                <Pencil data-icon="inline-start" /> Edit
              </Button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="space-y-1.5">
            <Textarea
              id={field}
              aria-label={`${step.label} hand-off instruction`}
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${field}-count ${field}-scope${failure ? ` ${field}-failure` : ''}`}
              value={draft}
              autoFocus
              rows={4}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (!saving) close()
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  save()
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span
                id={`${field}-count`}
                role={problem ? 'alert' : undefined}
                className={cn('text-xs text-muted-foreground', problem && 'text-destructive')}
              >
                {count}/{INSTRUCTIONS_MAX}
                {problem ? `: ${problem}` : ''}
              </span>
              <span className="ml-auto flex gap-1.5">
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={close}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={Boolean(problem) || saving} onClick={save}>
                  Save
                </Button>
              </span>
            </div>
            {failure && (
              <p id={`${field}-failure`} role="alert" className="text-xs text-destructive">
                Not saved: {failure}
              </p>
            )}
            <p id={`${field}-scope`} data-handoff-scope className="text-xs text-muted-foreground">
              A saved instruction replaces this step&apos;s hand-off for every ticket on this preset, whatever
              its complexity.
              {defaultVaries && !step.edited.instructions
                ? ` The text shown is the default for ${complexity} tickets.`
                : ''}
            </p>
            <p className="text-xs text-muted-foreground">
              What the {step.label} step passes on and what the ticket agent checks when it returns. Leave it
              blank for the default. Ctrl+Enter saves, Escape cancels.
            </p>
          </div>
        ) : (
          <p
            data-handoff-text
            className={cn(
              'border-l-2 pl-2.5 text-[0.8125rem] leading-relaxed wrap-anywhere text-foreground/85',
              step.edited.instructions ? 'border-primary/50' : 'border-border',
            )}
          >
            {step.handoff}
          </p>
        )}
      </div>
    </div>
  )
}
