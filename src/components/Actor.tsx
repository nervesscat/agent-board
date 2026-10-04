import { useQuery } from '@tanstack/react-query'
import { Bot, User } from 'lucide-react'

import { get } from '#/lib/api'

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

/** Who did it: agents get a bot glyph, the human signed in through the browser an "admin" badge. */
export function Actor({ name, className = '' }: { name: string; className?: string }) {
  const kind = useActorKinds()(name)
  const Icon = kind === 'agent' ? Bot : User
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium ${className}`}
      title={kind === 'agent' ? `${name} (agent, gate token)` : `${name} (you, signed in with a passkey)`}
    >
      <Icon className="size-3.5 text-muted-foreground" />
      {name}
      {kind === 'human' && (
        <span className="rounded bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
          admin
        </span>
      )}
    </span>
  )
}
