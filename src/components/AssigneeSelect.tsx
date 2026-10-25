import { useQuery } from '@tanstack/react-query'
import { Bot, Lock } from 'lucide-react'

import { RoleBadge, useWho } from '#/components/Actor'
import { AgentAvatar } from '#/components/AgentAvatar'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { type ActorRow, get } from '#/lib/api'
import { useProjectAgents } from '#/lib/project'

const NONE = '__none__'

/**
 * Who a ticket goes to. One of the project's agents reserves it for that agent; a connected agent (an
 * agent token, or a sub-identity of one) or nobody leaves it shared, for any agent to pick up or take
 * over. A connected agent shows its role's badge, as `Actor` does.
 */
export function AssigneeSelect({
  id,
  value,
  onChange,
}: {
  id?: string
  value: string
  onChange: (name: string) => void
}) {
  const agents = useProjectAgents()
  const { data: actors = [] } = useQuery({
    queryKey: ['actors'],
    queryFn: () => get<ActorRow[]>('/api/actors'),
    staleTime: 5 * 60_000,
  })
  const isAgent = (n: string) => agents.some((a) => a.name.toLowerCase() === n.toLowerCase())
  const connected = actors.filter((a) => a.kind === 'agent' && !isAgent(a.name)).map((a) => a.name)
  // Whatever it holds now stays pickable, even a name the board no longer knows.
  if (value && !isAgent(value) && !connected.includes(value)) connected.push(value)
  const items: Record<string, string> = {
    [NONE]: 'Unassigned',
    ...Object.fromEntries(agents.map((a) => [a.name, `${a.name} (reserved)`])),
    ...Object.fromEntries(connected.map((n) => [n, n])),
  }
  const current = agents.find((a) => a.name.toLowerCase() === value.toLowerCase())?.name ?? value
  const who = useWho()
  const isConnected = (v: string) => v !== NONE && !isAgent(v)
  return (
    <Select value={current || NONE} onValueChange={(v) => onChange(!v || v === NONE ? '' : v)} items={items}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>
          {(v: string) =>
            isConnected(v) ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{v}</span>
                <RoleBadge role={who(v).role} />
              </span>
            ) : (
              items[v]
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Unassigned</SelectItem>
        {agents.length > 0 && (
          <SelectGroup>
            <SelectLabel>Project agents: only they work it</SelectLabel>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.name}>
                <AgentAvatar agent={a} />
                {a.name}
                <Lock className="size-3 text-muted-foreground" />
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {connected.length > 0 && (
          <SelectGroup>
            <SelectLabel>Connected agents: shared</SelectLabel>
            {connected.map((n) => (
              <SelectItem key={n} value={n}>
                <Bot className="text-muted-foreground" />
                {n}
                <RoleBadge role={who(n).role} />
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}
