import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { type StageLike, stageOf } from '#/lib/stages'

/**
 * Picks one of the project's stages; `value` and `onChange` are stage keys. Small by default (a ticket's
 * header); `id`, `size` and `className` fit it into a form.
 */
export function StatusSelect({
  stages,
  value,
  onChange,
  id,
  size = 'sm',
  className,
}: {
  stages: StageLike[]
  value: string
  onChange: (key: string) => void
  id?: string
  size?: 'sm' | 'default'
  className?: string
}) {
  // A ticket left in a stage that was since removed still shows what it has.
  const all = stages.some((s) => s.key === value) ? stages : [...stages, stageOf(stages, value)]
  const items = Object.fromEntries(all.map((s) => [s.key, s.name]))
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)} items={items}>
      <SelectTrigger id={id} size={size} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
