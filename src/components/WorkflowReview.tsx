import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'
import { ROUNDS_MAX, type ResolvedReview } from '#/lib/workflow'
import { parseRounds } from '#/lib/workflowEdit'
import { cn } from '#/lib/utils'

/** The Review step's four round counts, as the fields in its settings panel. */

/**
 * What a rounds field has sent and not seen answered, kept outside the field: the field is made again when the
 * preset is switched away and back or the Review node is closed and opened, and the new one must still know
 * which count the board is about to hold. The owner keeps one per preset and level.
 */
export interface RoundsFlight {
  /** The last count sent, until the board's answer is in. */
  sent: number | null
  /** How many saves are still out. */
  pending: number
}

/** The four round counts: a number field for each complexity, saved as it is typed (once it is valid). */
export function RoundsEditor({
  review,
  complexity,
  flightOf,
  onChange,
}: {
  review: ResolvedReview
  complexity: Complexity
  flightOf: (level: Complexity) => RoundsFlight
  onChange: (level: Complexity, rounds: number) => Promise<string | null>
}) {
  const { t } = useTranslation()
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">{t('workflowReview.legend')}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {COMPLEXITIES.map((level) => (
          <RoundsField
            key={level}
            level={level}
            value={review.roundsByComplexity[level]}
            fallback={review.defaultRounds[level]}
            current={level === complexity}
            flight={flightOf(level)}
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
  flight,
  onChange,
}: {
  level: Complexity
  value: number
  fallback: number
  current: boolean
  flight: RoundsFlight
  /** Answers with the reason the count was not saved, or null once it was. */
  onChange: (rounds: number) => Promise<string | null>
}) {
  const { t } = useTranslation()
  const id = useId()
  const [draft, setDraft] = useState(String(value))
  const [failure, setFailure] = useState<string | null>(null)
  const typing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // What the board has saved, for the handlers that outlive a render.
  const saved = useRef(value)
  // The last count sent and how many saves are still out (`flight`, which outlives this field): a count is
  // compared with what the board is about to hold, not with the answer to a save that has not come back, so
  // typing the old count again is a change.
  const alive = useRef(true)
  const issued = useRef(0)
  const typed = useRef(String(value))
  // What the board has saved shows, unless a count is being typed in: the answer to the last key must not
  // overwrite the next one.
  useEffect(() => {
    saved.current = value
    if (flight.pending === 0) flight.sent = null
    if (!typing.current) setDraft(String(value))
  }, [value, flight])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const parsed = parseRounds(draft)
  const error = parsed.ok ? null : parsed.error
  const commit = (text: string) => {
    clearTimeout(timer.current)
    const next = parseRounds(text)
    if (!next.ok) return
    if (next.rounds === (flight.sent ?? saved.current)) {
      // The count is what the board holds (or is about to): an older refusal's message no longer fits it.
      setFailure(null)
      return
    }
    const rounds = next.rounds
    const mine = ++issued.current
    flight.sent = rounds
    flight.pending += 1
    setFailure(null)
    void onChange(rounds).then((reason) => {
      flight.pending -= 1
      // A refused count is not held by the board; and an answer that came after this field was gone has no
      // field left to clear the count when the saved one arrives.
      if (flight.pending === 0 && (reason !== null || !alive.current)) flight.sent = null
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
        {t(`complexity.label.${level}`)}
        {value !== fallback && <span className="ml-auto text-primary">{t('workflowReview.changed')}</span>}
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
            {t('workflowReview.notSaved', { reason: failure })}
          </span>
        ) : (
          <>{t('workflowReview.default', { value: fallback })}</>
        )}
      </p>
    </div>
  )
}
