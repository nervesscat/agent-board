import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { TICKET_STATUSES, type TicketStatus } from '#/lib/constants'
import { STATUS_LABEL } from '#/lib/format'

const items = Object.fromEntries(TICKET_STATUSES.map((s) => [s, STATUS_LABEL[s]]))

export function StatusSelect({
  value,
  onChange,
}: {
  value: TicketStatus
  onChange: (s: TicketStatus) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TicketStatus)} items={items}>
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TICKET_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {STATUS_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
