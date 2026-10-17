import { cn } from 'cn'
import type { ReactNode } from 'react'

import { Tabs, TabsList, TabsTrigger, tabsListVariants, tabsTriggerClass } from '#/components/ui/tabs'

export interface Chip<K extends string> {
  key: K
  label: ReactNode
  /** A count shown in a badge after the label; none without it. */
  count?: number
}

// A tab's underline, drawn by the line style only (chips are the default style), hangs 5px below it:
// without it, nothing of a chip reaches outside its list, so the list has nothing to scroll.
const NO_UNDERLINE = 'after:hidden'

function ChipLabel({ label, count }: Pick<Chip<string>, 'label' | 'count'>) {
  return (
    <>
      {label}
      {count !== undefined && (
        <span className="ml-1.5 rounded-full bg-background px-1.5 text-xs tabular-nums">{count}</span>
      )}
    </>
  )
}

/**
 * A row of chips with one on at a time, as tabs: `children` are their panels (TabsContent), if any.
 */
export function ChipTabs<K extends string>({
  chips,
  value,
  onChange,
  listClassName,
  children,
}: {
  chips: readonly Chip<K>[]
  value: K
  onChange: (key: K) => void
  listClassName?: string
  children?: ReactNode
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as K)}>
      <TabsList className={listClassName}>
        {chips.map((c) => (
          <TabsTrigger key={c.key} value={c.key} className={NO_UNDERLINE}>
            <ChipLabel label={c.label} count={c.count} />
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  )
}

/**
 * A row of chips that look like ChipTabs' but toggle each on its own, any number on at once. A chip
 * that is on is pressed (`aria-pressed`) and drawn as the chosen tab (`data-active`).
 */
export function ChipToggles<K extends string>({
  chips,
  value,
  onToggle,
  label,
  className,
}: {
  chips: readonly Chip<K>[]
  value: readonly K[]
  onToggle: (key: K, on: boolean) => void
  /** The row's name for assistive tech. */
  label: string
  className?: string
}) {
  return (
    // The tab styles read the orientation and the list's variant off their groups.
    <div data-orientation="horizontal" className="group/tabs flex max-w-full">
      <div
        role="group"
        aria-label={label}
        data-slot="tabs-list"
        data-variant="default"
        className={cn(tabsListVariants(), className)}
      >
        {chips.map((c) => {
          const on = value.includes(c.key)
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              data-active={on ? '' : undefined}
              className={cn(tabsTriggerClass, NO_UNDERLINE)}
              onClick={() => onToggle(c.key, !on)}
            >
              <ChipLabel label={c.label} count={c.count} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
