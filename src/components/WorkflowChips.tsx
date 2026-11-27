import { Bot, Lock, Pencil, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Tip } from '#/components/ui/tooltip'
import type { TeamAgentRef } from '#/lib/workflow'
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
 * A small label on a node (who runs it, its effort, a lock, an edit). With `tip` it explains itself on
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

/**
 * Who runs a node: the ticket agent itself (`you`), or the Team agent that runs it (a pick, the Team agent
 * named like its role, or the built-in role the Team lacks) with the role it runs as in a muted way, and a
 * badge when a saved pick is not in the Team. `plain` leaves out the tooltips (and so the tab stops): on a
 * node, which is itself one button.
 */
export function AgentChip({
  agent,
  label,
  team,
  plain = false,
}: {
  agent: string
  label: string
  team: TeamAgentRef | null
  plain?: boolean
}) {
  const { t } = useTranslation()
  if (!team)
    return (
      <Chip tone="agent" icon={<User aria-hidden />} tip={plain ? undefined : t('workflowChips.selfTip')}>
        {label}
      </Chip>
    )
  const tip = t(`workflowChips.agentTip.${team.source}`, { agent })
  return (
    <>
      <Chip tone="agent" icon={<Bot aria-hidden />} tip={plain ? undefined : tip}>
        <span className="min-w-0 truncate" data-agent-name>
          {team.name}
        </span>
        {team.name.toLowerCase() !== agent && (
          <span className="min-w-0 truncate font-normal opacity-70" data-agent-role>
            {agent}
          </span>
        )}
      </Chip>
      {team.missing && (
        <Chip
          tone="lock"
          tip={plain ? undefined : t('workflowChips.missingTip', { picked: team.picked, name: team.name })}
        >
          {t('workflowChips.agentMissing')}
        </Chip>
      )}
    </>
  )
}

/** A step the human cannot turn off, with why. */
export function LockChip({ lock, reason }: { lock: 'always' | 'above-low'; reason: string | null }) {
  const { t } = useTranslation()
  return (
    <Chip tone="lock" icon={<Lock aria-hidden />} tip={reason ?? undefined}>
      {lock === 'always' ? t('workflowChips.locked') : t('workflowChips.lockedAboveLow')}
    </Chip>
  )
}

/** A step the human changed: what exactly. */
export function ChangedChip({ what, plain = false }: { what: string; plain?: boolean }) {
  const { t } = useTranslation()
  return (
    <Chip
      tone="edited"
      icon={<Pencil aria-hidden />}
      tip={plain ? undefined : t('workflowChips.changedTip', { what })}
    >
      {t('workflowChips.changed')}
    </Chip>
  )
}
