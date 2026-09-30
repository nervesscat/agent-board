import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { type StageLike, stageOf } from '#/lib/stages'

/** Picks one of the project's stages; `value` and `onChange` are stage keys. */
export function StatusSelect({
  stages,
  value,
  onChange,
}: {
  stages: StageLike[]
  value: string
  onChange: (key: string) => void
}) {
  // A ticket left in a stage that was since removed still shows what it has.
  const all = stages.some((s) => s.key === value) ? stages : [...stages, stageOf(stages, value)]
  const items = Object.fromEntries(all.map((s) => [s.key, s.name]))
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)} items={items}>
      <SelectTrigger size="sm">
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
