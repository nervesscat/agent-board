import { useQuery } from '@tanstack/react-query'
import { Bot, User } from 'lucide-react'
import type { ReactNode } from 'react'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Tip } from '#/components/ui/tooltip'
import { get } from '#/lib/api'
import { useProjectAgent } from '#/lib/project'

type Kind = 'agent' | 'human'

const AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'cursor', 'agent', 'bot']

/** Only for names the board has never seen sign in (e.g. history from before it started keeping track). */
const guess = (name: string): Kind => (AGENTS.some((a) => name.toLowerCase().includes(a)) ? 'agent' : 'human')

/** How each name signs in: a gate token is an agent, the browser's passkey session is a human. */
export function useActorKinds() {
  const { data } = useQuery({
    queryKey: ['actors'],
    queryFn: () => get<{ name: string; kind: Kind }[]>('/api/actors'),
    staleTime: 5 * 60_000,
  })
  const kinds = new Map(data?.map((a) => [a.name, a.kind]))
  return (name: string): Kind => kinds.get(name) ?? guess(name)
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
 * other agents a bot glyph, the human signed in through the browser an "admin" badge.
 */
export function Actor({ name, via, className = '' }: { name: string; via?: string; className?: string }) {
  const kind = useActorKinds()(name)
  const agent = useProjectAgent(name)
  if (agent)
    return (
      <Tip content={`${agent.name} (one of the project's agents${via ? `, posted via ${via}` : ''})`}>
        <span className={`inline-flex items-baseline gap-1 font-medium ${className}`}>
          <Picture>
            <AgentAvatar agent={agent} />
          </Picture>
          {agent.name}
          {via && <span className="font-normal text-muted-foreground">via {via}</span>}
        </span>
      </Tip>
    )
  const Icon = kind === 'agent' ? Bot : User
  return (
    <Tip
      content={kind === 'agent' ? `${name} (agent, gate token)` : `${name} (you, signed in with a passkey)`}
    >
      <span className={`inline-flex items-baseline gap-1 font-medium ${className}`}>
        <Picture>
          <Icon className="size-3.5 text-muted-foreground" />
        </Picture>
        {name}
        {kind === 'human' && (
          <span className="self-center rounded bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
            admin
          </span>
        )}
      </span>
    </Tip>
  )
}
