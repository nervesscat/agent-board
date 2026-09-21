import { CalendarDays } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { localDate } from '#/lib/format'

/** A day as `YYYY-MM-DD` (local), picked from a calendar. Future days are off. */
export function DatePicker({ value, onChange }: { value: string; onChange: (date: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = new Date(`${value}T00:00:00`)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <CalendarDays data-icon="inline-start" />
        {selected.toLocaleDateString([], {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={{ after: new Date() }}
          onSelect={(d) => {
            if (!d) return
            onChange(localDate(d))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
