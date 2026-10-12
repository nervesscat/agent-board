import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react'

import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

/**
 * A time of day (`HH:MM`, 24-hour) picked on a clock face: drag or tap the hand to the hour, then to
 * the minute (snapped to `step` minutes), type it, or use the arrow keys on the face. The face and the
 * text follow the browser's locale: AM/PM where the locale says so, 24 hours otherwise.
 */
export function AnalogClock({
  value,
  onChange,
  label,
  step = 5,
  className,
}: {
  value: string
  onChange: (value: string) => void
  /** Names the clock (and its slider) for screen readers, and shows above it. */
  label: string
  /** Minutes a drag, a tap or an arrow key moves by. */
  step?: number
  className?: string
}) {
  const hour12 = useHour12()
  const [mode, setMode] = useState<'hour' | 'minute'>('hour')
  const [draft, setDraft] = useState<string | null>(null)
  const dragging = useRef(false)
  const labelId = useId()
  const total = toMinutes(value) ?? 0
  const hour = Math.floor(total / 60)
  const minute = total % 60
  const text = formatTime(total, hour12)
  const invalid = draft !== null && parseTime(draft) === null

  const set = (minutes: number) => {
    const next = fromMinutes(Math.min(Math.max(minutes, 0), 24 * 60 - 1))
    if (next !== value) onChange(next)
  }

  // Where on the face the pointer is: its angle from 12 o'clock and how far out it is.
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - box.left) / box.width) * SIZE - C
    const y = ((e.clientY - box.top) / box.height) * SIZE - C
    const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360
    if (mode === 'minute') {
      const m = (Math.round(angle / (6 * step)) * step) % 60
      return set(hour * 60 + m)
    }
    const h = Math.round(angle / 30) % 12 // 0 is the top
    const inner = Math.hypot(x, y) < (OUTER + INNER) / 2
    let next: number
    if (hour12) next = h + (hour >= 12 ? 12 : 0)
    else if (inner) next = h === 0 ? 0 : h + 12
    else next = h === 0 ? 12 : h
    set(next * 60 + minute)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const by: Record<string, number> = {
      ArrowUp: step,
      ArrowRight: step,
      ArrowDown: -step,
      ArrowLeft: -step,
      PageUp: 60,
      PageDown: -60,
    }
    if (e.key in by) set(total + by[e.key]!)
    else if (e.key === 'Home') set(0)
    else if (e.key === 'End') set(24 * 60 - step)
    else return
    e.preventDefault()
  }

  // The numbers round the face: the hours (two rings on a 24-hour clock) or the minutes.
  const marks: { text: string; at: number; r: number; on: boolean }[] =
    mode === 'minute'
      ? Array.from({ length: 12 }, (_, i) => ({
          text: String(i * 5).padStart(2, '0'),
          at: i,
          r: OUTER,
          on: minute === i * 5,
        }))
      : [
          ...Array.from({ length: 12 }, (_, i) => {
            const h = i === 0 ? 12 : i
            return { text: String(h), at: i, r: OUTER, on: hour12 ? hour % 12 === i : hour === h }
          }),
          ...(hour12
            ? []
            : Array.from({ length: 12 }, (_, i) => {
                const h = i === 0 ? 0 : i + 12
                return { text: String(h).padStart(2, '0'), at: i, r: INNER, on: hour === h }
              })),
        ]
  const handAngle = mode === 'minute' ? minute * 6 : (hour % 12) * 30
  const handR = mode === 'hour' && !hour12 && (hour === 0 || hour > 12) ? INNER : OUTER
  const [hx, hy] = point(handAngle, handR)

  return (
    <div role="group" aria-labelledby={labelId} className={cn('w-full max-w-56 space-y-2', className)}>
      <div id={labelId} className="text-xs font-medium">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          aria-label={`${label} (type a time)`}
          aria-invalid={invalid || undefined}
          value={draft ?? text}
          inputMode="text"
          autoComplete="off"
          className="h-8 w-24 tabular-nums"
          onChange={(e) => {
            setDraft(e.target.value)
            const parsed = parseTime(e.target.value)
            if (parsed !== null) set(parsed)
          }}
          onBlur={() => {
            if (!invalid) setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !invalid) setDraft(null)
          }}
        />
        {hour12 && (
          <div className="flex rounded-lg border p-0.5" role="group" aria-label={`${label}: AM or PM`}>
            {(['AM', 'PM'] as const).map((half) => {
              const on = (half === 'PM') === hour >= 12
              return (
                <button
                  key={half}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    if (!on) set(total + (half === 'PM' ? 12 * 60 : -12 * 60))
                    setDraft(null)
                  }}
                  className={cn(
                    'h-7 min-w-9 rounded-md px-1.5 text-xs font-medium text-muted-foreground',
                    on ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                  )}
                >
                  {half}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex gap-1" role="group" aria-label={`${label}: set the hour or the minute`}>
        {(['hour', 'minute'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'h-7 rounded-md px-2 text-xs text-muted-foreground',
              mode === m ? 'bg-muted font-medium text-foreground' : 'hover:bg-muted/60',
            )}
          >
            {m === 'hour' ? 'Hour' : 'Minute'}
          </button>
        ))}
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={24 * 60 - 1}
        aria-valuenow={total}
        aria-valuetext={text}
        data-mode={mode}
        onKeyDown={onKeyDown}
        className="aspect-square w-full max-w-56 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="size-full touch-none select-none"
          aria-hidden
          onPointerDown={(e) => {
            dragging.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            pick(e)
          }}
          onPointerMove={(e) => {
            if (dragging.current) pick(e)
          }}
          onPointerUp={() => {
            dragging.current = false
            setDraft(null)
            // An hour picked: the minute comes next, as on a phone's clock.
            if (mode === 'hour') setMode('minute')
          }}
          onPointerCancel={() => {
            dragging.current = false
          }}
        >
          <circle data-part="face" cx={C} cy={C} r={C - 2} className="fill-muted stroke-border" />
          <line
            data-part="hand"
            x1={C}
            y1={C}
            x2={hx}
            y2={hy}
            strokeWidth={2.5}
            strokeLinecap="round"
            className="stroke-primary"
          />
          <circle cx={C} cy={C} r={4} className="fill-primary" />
          <circle cx={hx} cy={hy} r={15} className="fill-primary" />
          {marks.map((m) => {
            const [x, y] = point(m.at * 30, m.r)
            return (
              <text
                key={`${m.r}-${m.at}`}
                data-part="mark"
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                className={cn(
                  m.r === INNER ? 'text-[11px]' : 'text-[13px]',
                  m.on ? 'fill-primary-foreground font-semibold' : 'fill-foreground',
                  m.r === INNER && !m.on && 'fill-muted-foreground',
                )}
              >
                {m.text}
              </text>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// The face, in SVG units: its size, centre, and the radii of the outer and inner rings of numbers.
const SIZE = 200
const C = SIZE / 2
const OUTER = 80
const INNER = 54

function point(degrees: number, r: number): [number, number] {
  const rad = (degrees * Math.PI) / 180
  return [C + r * Math.sin(rad), C - r * Math.cos(rad)]
}

const toMinutes = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const fromMinutes = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** "5:00 PM" on a 12-hour clock, "17:00" on a 24-hour one. */
export function formatTime(minutes: number, hour12: boolean): string {
  const h = Math.floor(minutes / 60)
  const mm = String(minutes % 60).padStart(2, '0')
  return hour12 ? `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:${mm}`
}

/**
 * A typed time as minutes after midnight, or null: "17:05", "8:45", "5:05 pm", "5pm", "12:30 a.m.".
 * Without AM/PM it is a 24-hour time.
 */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/i.exec(text.trim())
  if (!m) return null
  let h = Number(m[1])
  const minute = m[2] === undefined ? null : Number(m[2])
  const half = m[3]?.toLowerCase()
  if (minute === null && !half) return null
  if ((minute ?? 0) > 59) return null
  if (half) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (half === 'p' ? 12 : 0)
  } else if (h > 23) return null
  return h * 60 + (minute ?? 0)
}

// Whether the browser's locale writes times on a 12-hour clock. The server cannot know, so it (and
// the first render in the browser) says 24 hours; the browser's own answer follows straight after.
const noop = () => () => {}
const localeHour12 = () =>
  /h1[12]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle ?? '')
export const useHour12 = () => useSyncExternalStore(noop, localeHour12, () => false)
