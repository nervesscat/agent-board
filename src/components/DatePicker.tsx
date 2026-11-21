import { CalendarDays, X } from 'lucide-react'
import { useState } from 'react'
import type { Matcher } from 'react-day-picker'
import { useTranslation } from 'react-i18next'

import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { currentLocale } from '#/i18n'
import { localDate } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'

type Picked = {
  /** The day picked, `YYYY-MM-DD`. */
  value: string
  onChange: (date: string) => void
}
type Optional = {
  /** The day picked, `YYYY-MM-DD`, or none. */
  value: string | undefined
  /** With undefined when the day is cleared. */
  onChange: (date: string | undefined) => void
  /** What the button says while no day is picked, and its name for assistive tech. */
  placeholder: string
  /** The first and last days that can be picked, `YYYY-MM-DD`. */
  min?: string
  max?: string
}

const asDate = (day: string) => new Date(`${day}T00:00:00`)
const longDay = (d: Date) =>
  d.toLocaleDateString(currentLocale(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

/**
 * A day as `YYYY-MM-DD` (local), picked from a calendar. Future days are off. With a `placeholder`
 * the day is optional: the button says the placeholder while none is picked, a clear button beside it
 * takes the day away, and `min`/`max` bound the days that can be picked.
 */
export function DatePicker(props: Picked | Optional) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const optional = 'placeholder' in props
  const selected = props.value ? asDate(props.value) : undefined
  // The day is written in the browser's language and region: after mount, so the server's page (which cannot
  // know them for a date) and the first render in the browser say the same.
  const hydrated = useHydrated()
  const day = selected && hydrated ? longDay(selected) : ''
  const disabled: Matcher[] = [{ after: new Date() }]
  if (optional && props.min) disabled.push({ before: asDate(props.min) })
  if (optional && props.max) disabled.push({ after: asDate(props.max) })
  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="outline" size="sm" />}
        aria-label={optional ? `${props.placeholder}${day ? `: ${day}` : ''}` : undefined}
      >
        <CalendarDays data-icon="inline-start" />
        {selected ? day : <span className="text-muted-foreground">{optional ? props.placeholder : ''}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={optional ? 'start' : 'end'}>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? (optional && props.max ? asDate(props.max) : undefined)}
          disabled={disabled}
          onSelect={(d) => {
            if (!d) return
            props.onChange(localDate(d))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
  if (!optional) return picker
  return (
    <span className="inline-flex items-center">
      {picker}
      {selected && (
        <Tip content={t('pickers.clear', { what: props.placeholder })}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('pickers.clear', { what: props.placeholder })}
            onClick={() => props.onChange(undefined)}
          >
            <X />
          </Button>
        </Tip>
      )}
    </span>
  )
}
