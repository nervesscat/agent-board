import { CornerDownRight, Split } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { AgentChip } from '#/components/WorkflowChips'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import { ROUNDS_MAX, type ResolvedReview, type ResolvedSubStep } from '#/lib/workflow'
import { parseRounds } from '#/lib/workflowEdit'
import { COMPLEXITY_NAMES, domId, groupSubSteps, roundsText } from '#/lib/workflowView'
import { cn } from '#/lib/utils'

/**
 * What the Review step holds, drawn under it: the rounds each complexity gets (editable), the phases of one
 * round, what happens between rounds and when a round survives. The phases belong to the preset: they are
 * shown, not edited. Every node is a tree item one level below its parent.
 */

/** The four round counts: a number field for each complexity, saved as it is typed (once it is valid). */
export function RoundsEditor({
  review,
  complexity,
  onChange,
}: {
  review: ResolvedReview
  complexity: Complexity
  onChange: (level: Complexity, rounds: number) => Promise<string | null>
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">Review rounds per complexity</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {COMPLEXITIES.map((level) => (
          <RoundsField
            key={level}
            level={level}
            value={review.roundsByComplexity[level]}
            fallback={review.defaultRounds[level]}
            current={level === complexity}
            onChange={(rounds) => onChange(level, rounds)}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** How long a typed count waits for the next key before it is saved. */
const SAVE_AFTER_MS = 400

function RoundsField({
  level,
  value,
  fallback,
  current,
  onChange,
}: {
  level: Complexity
  value: number
  fallback: number
  current: boolean
  /** Answers with the reason the count was not saved, or null once it was. */
  onChange: (rounds: number) => Promise<string | null>
}) {
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  const [failure, setFailure] = useState<string | null>(null)
  const typing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // What the board has saved, for the handlers that outlive a render.
  const saved = useRef(value)
  // The last count sent and how many saves are still out: a count is compared with what the board is about to
  // hold, not with the answer to a save that has not come back, so typing the old count again is a change.
  const sent = useRef<number | null>(null)
  const pending = useRef(0)
  const issued = useRef(0)
  const typed = useRef(String(value))
  // What the board has saved shows, unless a count is being typed in: the answer to the last key must not
  // overwrite the next one.
  useEffect(() => {
    saved.current = value
    if (pending.current === 0) sent.current = null
    if (!typing.current) setDraft(String(value))
  }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const parsed = parseRounds(draft)
  const error = parsed.ok ? null : parsed.error
  const commit = (text: string) => {
    clearTimeout(timer.current)
    const next = parseRounds(text)
    if (!next.ok) return
    if (next.rounds === (sent.current ?? saved.current)) {
      // The count is what the board holds (or is about to): an older refusal's message no longer fits it.
      setFailure(null)
      return
    }
    const rounds = next.rounds
    const mine = ++issued.current
    sent.current = rounds
    pending.current += 1
    setFailure(null)
    void onChange(rounds).then((reason) => {
      pending.current -= 1
      if (reason !== null && pending.current === 0) sent.current = null
      // Only the latest save speaks for the field; an older one that failed has been overtaken.
      if (mine !== issued.current) return
      setFailure(reason)
      // A refused count does not stay in the field as if it were saved, unless something newer was typed.
      if (reason !== null) {
        const now = parseRounds(typed.current)
        if (now.ok && now.rounds === rounds) {
          setDraft(String(saved.current))
          typed.current = String(saved.current)
        }
      }
    })
  }
  return (
    <div className={cn('space-y-1 rounded-md border p-1.5', current && 'border-primary/50 bg-primary/5')}>
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {COMPLEXITY_NAMES[level]}
        {value !== fallback && <span className="ml-auto text-primary">edited</span>}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={ROUNDS_MAX}
        step={1}
        value={draft}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : failure ? `${id}-failure` : undefined}
        className="h-7"
        onFocus={() => {
          typing.current = true
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          setFailure(null)
          typed.current = e.target.value
          clearTimeout(timer.current)
          const text = e.target.value
          timer.current = setTimeout(() => commit(text), SAVE_AFTER_MS)
        }}
        onBlur={(e) => {
          typing.current = false
          commit(e.target.value)
          // A count that was not valid goes back to what is saved.
          if (!parseRounds(e.target.value).ok) {
            setDraft(String(value))
            typed.current = String(value)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
        }}
      />
      <p className="text-[11px] text-muted-foreground">
        {error ? (
          <span id={`${id}-error`} role="alert" className="text-destructive">
            {error}
          </span>
        ) : failure ? (
          <span id={`${id}-failure`} role="alert" className="text-destructive">
            Not saved: {failure}
          </span>
        ) : (
          <>default {fallback}</>
        )}
      </p>
    </div>
  )
}

/** The review's rounds in a few words, for its heading and the page's summary line. */
export const reviewRoundsText = (review: ResolvedReview, complexity: Complexity): string =>
  roundsText(review.roundsByComplexity[complexity])

/** One phase of a round: its number, name, agent and what it does; the ones inside it are its children. */
function PhaseNode({
  step,
  level,
  collapsed,
  onToggle,
}: {
  step: ResolvedSubStep
  level: number
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const title = domId('wf-title', step.id)
  const open = !collapsed.has(step.id)
  const hasChildren = step.children.length > 0
  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-labelledby={title}
      aria-expanded={hasChildren ? open : undefined}
      data-node={step.id}
      className="space-y-1 rounded-md border bg-background/60 px-2.5 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {step.number && <span className="font-mono text-xs text-muted-foreground">{step.number}</span>}
        <span id={title} className="text-sm font-medium">
          {step.label}
        </span>
        <AgentChip agent={step.agent} label={step.agentLabel} />
        {hasChildren && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${step.label}`}
            className="ml-auto rounded px-1.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => onToggle(step.id)}
          >
            {open ? 'Hide phases' : 'Show phases'}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{step.what}</p>
      {hasChildren && open && (
        <PhaseList steps={step.children} level={level + 1} collapsed={collapsed} onToggle={onToggle} />
      )}
    </li>
  )
}

/** A list of phases: neighbours that run side by side sit together in a box that says so. */
function PhaseList({
  steps,
  level,
  collapsed,
  onToggle,
  after,
}: {
  steps: readonly ResolvedSubStep[]
  level: number
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  /** More tree items for the end of the list. */
  after?: ReactNode
}) {
  const node = (step: ResolvedSubStep) => (
    <PhaseNode key={step.id} step={step} level={level} collapsed={collapsed} onToggle={onToggle} />
  )
  return (
    <ul role="group" className="mt-1.5 space-y-1.5">
      {groupSubSteps(steps).map((item) =>
        item.kind === 'single' ? (
          node(item.step)
        ) : (
          <li role="none" key={item.steps[0]!.id} data-parallel={item.group}>
            <div className="rounded-md border border-dashed border-sky-500/40 p-1.5">
              <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-sky-700 dark:text-sky-400">
                <Split className="size-3" aria-hidden /> In parallel: these {item.steps.length} start together
              </p>
              <ul role="none" className="space-y-1.5">
                {item.steps.map(node)}
              </ul>
            </div>
          </li>
        ),
      )}
      {after}
    </ul>
  )
}

/** The body of the Review node: rounds, the phases of a round, what happens between rounds, the survival rule. */
export function ReviewBody({
  review,
  complexity,
  level,
  collapsed,
  onToggle,
  onRounds,
}: {
  review: ResolvedReview
  complexity: Complexity
  /** The tree level of the phases (one below the Review node). */
  level: number
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onRounds: (level: Complexity, rounds: number) => Promise<string | null>
}) {
  const betweenOpen = !collapsed.has('review.between')
  const between = domId('wf-title', 'review.between')
  const rounds = review.roundsByComplexity[complexity]
  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <RoundsEditor review={review} complexity={complexity} onChange={onRounds} />
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Each round runs these phases, none skipped
          {rounds === 0 && ` (a ${COMPLEXITY_NAMES[complexity].toLowerCase()} ticket gets no rounds)`}:
        </p>
        <PhaseList
          steps={review.phases}
          level={level}
          collapsed={collapsed}
          onToggle={onToggle}
          after={
            <li
              role="treeitem"
              aria-level={level}
              aria-labelledby={between}
              aria-expanded={betweenOpen}
              data-node="review.between"
              className="space-y-1 rounded-md border border-dashed px-2.5 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <CornerDownRight className="size-3.5 text-muted-foreground" aria-hidden />
                <span id={between} className="text-sm font-medium">
                  Between rounds
                </span>
                <span className="text-xs text-muted-foreground">
                  {review.between.map((b) => `${b.label.toLowerCase()} (${b.agentLabel})`).join(' → ')} → next
                  round
                </span>
                <button
                  type="button"
                  aria-expanded={betweenOpen}
                  aria-label={`${betweenOpen ? 'Collapse' : 'Expand'} Between rounds`}
                  className="ml-auto rounded px-1.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => onToggle('review.between')}
                >
                  {betweenOpen ? 'Hide' : 'Show'}
                </button>
              </div>
              {betweenOpen && (
                <ul role="group" className="space-y-1.5 pt-1">
                  {review.between.map((b) => (
                    <PhaseNode
                      key={b.id}
                      step={b}
                      level={level + 1}
                      collapsed={collapsed}
                      onToggle={onToggle}
                    />
                  ))}
                </ul>
              )}
            </li>
          }
        />
      </div>
      {review.runs.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Runs {review.runs.length} separate /feature-review runs each round:{' '}
          {review.runs.map((r) => r.label.toLowerCase()).join(' and ')}, each under its own agent name and
          never shown the other&apos;s findings.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">A round survives when</span> {review.survival}.
      </p>
    </div>
  )
}
