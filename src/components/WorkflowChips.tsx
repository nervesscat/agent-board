import { Bot, Lock, Pencil, User } from 'lucide-react'
import type { ReactNode } from 'react'

import { Tip } from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

/** The look of a small label on a node: its tone says what kind of fact it states. */
const TONES = {
  neutral: 'bg-muted text-muted-foreground',
  agent: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  effort: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
  lock: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  edited: 'bg-primary/10 text-primary',
  skipped: 'border border-dashed border-muted-foreground/40 text-muted-foreground',
  rounds: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400',
} as const

export type ChipTone = keyof typeof TONES

/**
 * A small label on a tree node (who runs it, its effort, a lock, an edit). With `tip` it explains itself on
 * hover and on keyboard focus, so it can be tabbed to.
 */
export function Chip({
  tone = 'neutral',
  icon,
  tip,
  className,
  children,
  ...rest
}: {
  tone?: ChipTone
  icon?: ReactNode
  tip?: ReactNode
  className?: string
  children: ReactNode
} & Omit<React.ComponentProps<'span'>, 'children' | 'className'>) {
  const chip = (
    <span
      tabIndex={tip ? 0 : undefined}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-none font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>svg]:size-3 [&>svg]:shrink-0',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  )
  return tip ? <Tip content={tip}>{chip}</Tip> : chip
}

/** Who runs a step: the ticket agent itself (`you`), or an agent it starts. */
export function AgentChip({ agent, label }: { agent: string; label: string }) {
  const you = agent === 'you'
  return (
    <Chip
      tone="agent"
      icon={you ? <User aria-hidden /> : <Bot aria-hidden />}
      tip={
        you
          ? 'The ticket agent does this itself'
          : agent === 'runner'
            ? 'The /feature-review run, which starts the phase agents below'
            : `The project's \`${label}\` agent does this`
      }
    >
      {label}
    </Chip>
  )
}

/** A step the human cannot turn off, with why. */
export function LockChip({ lock, reason }: { lock: 'always' | 'above-low'; reason: string | null }) {
  return (
    <Chip tone="lock" icon={<Lock aria-hidden />} tip={reason ?? undefined}>
      {lock === 'always' ? 'Locked' : 'Locked above low'}
    </Chip>
  )
}

/** A step the human changed: what exactly. */
export function EditedChip({ what }: { what: string }) {
  return (
    <Chip tone="edited" icon={<Pencil aria-hidden />} tip={`Changed from the preset: ${what}`}>
      edited
    </Chip>
  )
}
