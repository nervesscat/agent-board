import { useQuery } from '@tanstack/react-query'
import { Bot, Cog, User } from 'lucide-react'
import type { ReactNode } from 'react'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Tip } from '#/components/ui/tooltip'
import { type ActorRow, get } from '#/lib/api'
import { useProjectAgent } from '#/lib/project'
import { ROLE_LABEL, type Who, type WhoRole, chainOf, claimedShape, whoOf } from '#/lib/roles'
import { cn } from '#/lib/utils'

/**
 * Who each name is, as the board last saw it sign in (roles.ts whoOf): an agent token is an agent (an
 * orchestrator or a worker), the browser's passkey session is the human.
 */
export function useWho() {
  const { data } = useQuery({
    queryKey: ['actors'],
    queryFn: () => get<ActorRow[]>('/api/actors'),
    staleTime: 5 * 60_000,
  })
  const actors = new Map(data?.map((a) => [a.name, a]))
  return (name: string): Who => whoOf(name, actors)
}

/** How each name signs in: an agent token is an agent, the browser's passkey session is a human. */
export function useActorKinds() {
  const who = useWho()
  return (name: string) => who(name).kind
}

const ROLE_STYLE: Record<WhoRole, string> = {
  human: 'bg-primary text-primary-foreground',
  orchestrator: 'bg-violet-600 text-white dark:bg-violet-500',
  worker: 'bg-muted text-muted-foreground ring-1 ring-border ring-inset',
  board: 'text-muted-foreground outline-1 -outline-offset-1 outline-border outline-dashed',
}

/** The role as a small badge: Human, Orchestrator, Agent (a worker) or Board (the board itself). */
export function RoleBadge({ role, className }: { role: WhoRole; className?: string }) {
  return (
    <span
      data-role={role}
      className={cn(
        'shrink-0 self-center rounded px-1 text-[10px] leading-4 font-medium whitespace-nowrap',
        ROLE_STYLE[role],
        className,
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  )
}

/** What the tooltip says after the chain: how the name signs in, and what its role lets it do. */
function how({ role, parent }: Who): string {
  if (role === 'board') return 'the board, recorded automatically'
  if (role === 'human') return 'you, signed in with a passkey'
  if (role === 'orchestrator')
    return "an agent, signed in with a token the human made an orchestrator: it also changes the projects' instructions"
  return parent ? `an agent, a worker under ${parent}` : 'an agent, signed in with a token'
}

/**
 * The picture before a name, centred on the name's first line. The name gives the box its baseline: a
 * box whose first item is a picture would sit on the picture's bottom edge, off the line of the text
 * around it.
 */
function Picture({ children }: { children: ReactNode }) {
  return <span className="flex h-lh shrink-0 items-center self-start">{children}</span>
}

/**
 * The name's box never grows past the line it sits on, nor holds its flex row open at its full width
 * (`min-w-0`): a deep sub-identity is one long word, so the name (a text node of its own, on the
 * line of the text around it) breaks anywhere, and the "under" part is cut short. The tooltip keeps the whole chain.
 */
const ROOT = 'inline-flex min-w-0 max-w-full items-baseline gap-1 font-medium wrap-anywhere'

/**
 * The name, or with `truncate` the name cut short with an ellipsis where its one line cannot fit, so
 * that what follows it (the role's badge) keeps its room: for a row that never wraps, such as a
 * ticket card's. The tooltip keeps the whole name and chain.
 */
const Name = ({ name, truncate }: { name: string; truncate?: boolean }) =>
  truncate ? (
    <span data-testid="actor-name" className="min-w-0 truncate">
      {name}
    </span>
  ) : (
    name
  )

/**
 * Who did it: one of the project's agents gets its picture (and the connected agent it posted `via`),
 * any other name a glyph and its role's badge (Human, Orchestrator, Agent, or Board for what the board
 * recorded itself); a worker sub-identity also
 * says whom it works under. The tooltip has the whole chain, the name first.
 */
export function Actor({
  name,
  via,
  truncate,
  short,
  className = '',
}: {
  name: string
  via?: string
  /** Cut the name short on its one line before the badge after it (see `Name`). */
  truncate?: boolean
  /** On a card, show only the leaf of a sub-identity (`ticket-794`); the tooltip keeps the whole chain. */
  short?: boolean
  className?: string
}) {
  const who = useWho()
  const agent = useProjectAgent(name)
  const shown = short && name.includes('/') ? name.split('/').pop()! : name
  if (agent)
    return (
      <Tip
        content={`${agent.name} (one of the project's agents${via ? `, posted via ${chainOf(via, who)}` : ''})`}
      >
        <span className={`${ROOT} ${className}`}>
          <Picture>
            <AgentAvatar agent={agent} />
          </Picture>
          <Name name={agent.name} truncate={truncate} />
          {via && <span className="min-w-0 font-normal text-muted-foreground">via {via}</span>}
        </span>
      </Tip>
    )
  const me = who(name)
  const Icon = me.kind === 'board' ? Cog : me.kind === 'agent' ? Bot : User
  return (
    <Tip content={me.role === 'board' ? how(me) : `${chainOf(name, who)}: ${how(me)}`}>
      <span className={`${ROOT} ${className}`} data-role={me.role}>
        <Picture>
          <Icon className="size-3.5 text-muted-foreground" />
        </Picture>
        <Name name={shown} truncate={truncate} />
        <RoleBadge role={me.role} />
        {!short && me.role === 'worker' && me.parent && (
          // Kept on one line, cut short with an ellipsis where it cannot fit (the tooltip has the chain).
          <span className="min-w-0 truncate font-normal text-muted-foreground">under {me.parent}</span>
        )}
      </span>
    </Tip>
  )
}

/**
 * The name a record claims (`name`, which may be free text such as a sub-agent's label) and who
 * recorded it as signed in (`by`): when `by` is someone else, the claimed name is plain text, then "by"
 * and the recorder as `Actor` shows it (roles.ts claimedShape). When they are the same, or `by` is
 * unknown (an older record), it is one `Actor`.
 */
export { claimedShape }

export function ClaimedActor({
  name,
  by,
  className = '',
}: {
  name: string
  by: string | null | undefined
  className?: string
}) {
  if (!by || claimedShape(name, by) === 'actor') return <Actor name={name} className={className} />
  return (
    <>
      <span data-testid="claimed-name" className={`min-w-0 font-medium break-all ${className}`}>
        {name}
      </span>{' '}
      <span
        data-testid="event-by"
        className="inline-flex min-w-0 flex-wrap items-baseline gap-1 text-muted-foreground"
      >
        by <Actor name={by} className="min-w-0 flex-wrap break-all" />
      </span>
    </>
  )
}
