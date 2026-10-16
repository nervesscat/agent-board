import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'

/** How each level is written: the select's options, and the chip on a card. */
const COMPLEXITY_LABEL: Record<Complexity, string> = { low: 'Low', mid: 'Mid', high: 'High' }

/** The hover hint of the select: what each level does to the review. */
const SELECT_HINT = 'Low: no review. Mid: one review round. High: up to three.'

/** The hover hint of a level's chip: what that level does to the review. */
const LEVEL_HINT: Record<Complexity, string> = {
  low: 'Low: no review. The builder verifies it itself.',
  mid: 'Mid: one review round.',
  high: 'High: up to three review rounds.',
}

const CHIP_COLOR: Record<Complexity, string> = {
  low: 'bg-muted text-muted-foreground',
  mid: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  high: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
}

/**
 * A ticket's review level, picked: `value` and `onChange` are levels. Small by default (a ticket's
 * header); `id`, `size` and `className` fit it into a form.
 */
export function ComplexitySelect({
  id,
  value,
  onChange,
  size = 'sm',
  className,
}: {
  id?: string
  value: Complexity
  onChange: (level: Complexity) => void
  size?: 'sm' | 'default'
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Complexity)} items={COMPLEXITY_LABEL}>
      <Tip content={SELECT_HINT}>
        <SelectTrigger id={id} size={size} className={className}>
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent>
        {COMPLEXITIES.map((level) => (
          <SelectItem key={level} value={level}>
            {COMPLEXITY_LABEL[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A ticket's review level on its card: a chip that says what the level does to the review on hover. */
export function ComplexityChip({ level, className = '' }: { level: Complexity; className?: string }) {
  return (
    <Tip content={LEVEL_HINT[level]}>
      <span
        className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${CHIP_COLOR[level]} ${className}`}
      >
        {COMPLEXITY_LABEL[level]}
      </span>
    </Tip>
  )
}
