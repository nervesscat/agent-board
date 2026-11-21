import { useTranslation } from 'react-i18next'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { COMPLEXITIES, type Complexity } from '#/lib/constants'

const CHIP_COLOR: Record<Complexity, string> = {
  low: 'bg-muted text-muted-foreground',
  mid: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  high: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
  max: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400',
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
  const { t } = useTranslation()
  // How each level is written: the select's options, and the chip on a card.
  const labels = Object.fromEntries(COMPLEXITIES.map((l) => [l, t(`complexity.label.${l}`)]))
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Complexity)} items={labels}>
      <Tip content={t('complexity.selectHint')}>
        <SelectTrigger id={id} size={size} className={className}>
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent>
        {COMPLEXITIES.map((level) => (
          <SelectItem key={level} value={level}>
            {labels[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A ticket's review level on its card: a chip that says what the level does to the review on hover. */
export function ComplexityChip({ level, className = '' }: { level: Complexity; className?: string }) {
  const { t } = useTranslation()
  return (
    <Tip content={t(`complexity.hint.${level}`)}>
      <span
        className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${CHIP_COLOR[level]} ${className}`}
      >
        {t(`complexity.label.${level}`)}
      </span>
    </Tip>
  )
}
