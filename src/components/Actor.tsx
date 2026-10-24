import { useQuery } from '@tanstack/react-query'
import { Bot, User } from 'lucide-react'
import type { ReactNode } from 'react'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Tip } from '#/components/ui/tooltip'
import { type ActorRole, type ActorRow, get } from '#/lib/api'
import { useProjectAgent } from '#/lib/project'
import { ROLE_LABEL, type Who, chainOf, whoOf } from '#/lib/roles'
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

const ROLE_STYLE: Record<ActorRole, string> = {
  human: 'bg-primary text-primary-foreground',
  orchestrator: 'bg-violet-600 text-white dark:bg-violet-500',
  worker: 'bg-muted text-muted-foreground ring-1 ring-border ring-inset',
}

/** The role as a small badge: Human, Orchestrator or Agent (a worker). */
export function RoleBadge({ role, className }: { role: ActorRole; className?: string }) {
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
 * Who did it: one of the project's agents gets its picture (and the connected agent it posted `via`),
 * any other name a glyph and its role's badge (Human, Orchestrator, Agent); a worker sub-identity also
 * says whom it works under. The tooltip has the whole chain, the name first.
 */
export function Actor({ name, via, className = '' }: { name: string; via?: string; className?: string }) {
  const who = useWho()
  const agent = useProjectAgent(name)
  if (agent)
    return (
      <Tip
        content={`${agent.name} (one of the project's agents${via ? `, posted via ${chainOf(via, who)}` : ''})`}
      >
        <span className={`inline-flex items-baseline gap-1 font-medium ${className}`}>
          <Picture>
            <AgentAvatar agent={agent} />
          </Picture>
          {agent.name}
          {via && <span className="font-normal text-muted-foreground">via {via}</span>}
        </span>
      </Tip>
    )
  const me = who(name)
  const Icon = me.kind === 'agent' ? Bot : User
  return (
    <Tip content={`${chainOf(name, who)}: ${how(me)}`}>
      <span className={`inline-flex items-baseline gap-1 font-medium ${className}`} data-role={me.role}>
        <Picture>
          <Icon className="size-3.5 text-muted-foreground" />
        </Picture>
        {name}
        <RoleBadge role={me.role} />
        {me.role === 'worker' && me.parent && (
          <span className="font-normal whitespace-nowrap text-muted-foreground">under {me.parent}</span>
        )}
      </span>
    </Tip>
  )
}
