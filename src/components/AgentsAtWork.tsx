import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot } from 'lucide-react'

import { AgentPet } from '#/components/AgentPet'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import { Tip } from '#/components/ui/tooltip'
import { petsOf, type Pet } from '#/lib/agentsAtWork'
import { get, type LiveWorkPayload, type ProjectSummary } from '#/lib/api'
import { cn } from '#/lib/utils'
import { useServerOffset } from '#/lib/useNow'
import { onServerClock } from '#/lib/workStatus'

/**
 * The Overview's Agents at work: tiny pixel-art pets, one per agent on a ticket right now, from the
 * project's live work (no agent reports anything for it); a ticket in Done, Approved or Cancelled has
 * none. Each is a link to its ticket and says in words what its pose says: a typing pet works, one with
 * a raised paw and a "?" waits, a sleeping one has gone quiet. A grid on a wide screen, as many
 * columns as fit the card and wrapping onto more rows; on a phone one under another, each with its
 * ticket line beside it. Refreshed every 30 seconds, like the cards around
 * it, and light enough for many: the motion is CSS alone.
 */
export function AgentsAtWork({ p, className }: { p: ProjectSummary; className?: string }) {
  const projectId = p.project.id
  const { data, isLoading, error } = useQuery({
    queryKey: ['live-work', projectId],
    queryFn: () => get<LiveWorkPayload>(`/api/projects/${projectId}/live-work`),
    refetchInterval: 30_000,
  })
  // "Last heard" is counted on the server's clock from when this read was taken, as on the other cards.
  const now = onServerClock(Date.now(), useServerOffset(data?.now))
  const { pets, more, live } = petsOf(data, now)
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Bot className="size-4 text-muted-foreground" /> Agents at work
          {live > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {live}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-12 w-full max-w-sm" />
        ) : error ? (
          <p className="text-sm text-muted-foreground">Could not read who is working.</p>
        ) : !pets.length ? (
          <div data-testid="agents-empty" className="flex min-h-11 items-center gap-2.5">
            <AgentPet state="asleep" />
            <span className="text-sm text-muted-foreground">No agents working</span>
          </div>
        ) : (
          <ul
            data-testid="agents-list"
            className="flex flex-col gap-1 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] sm:gap-x-2 sm:gap-y-1"
          >
            {pets.map((pet, i) => (
              <li key={pet.key} className={cn('min-w-0', pet.size === 'small' && 'max-sm:ml-6')}>
                <PetLink projectId={projectId} pet={pet} index={i} />
              </li>
            ))}
            {more > 0 && (
              <li className="flex items-center px-2 text-xs text-muted-foreground tabular-nums">
                +{more} more
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function PetLink({ projectId, pet, index }: { projectId: number; pet: Pet; index: number }) {
  const small = pet.size === 'small'
  return (
    <Tip content={pet.label}>
      <Link
        to="/projects/$id/features/$ticketId"
        params={{ id: String(projectId), ticketId: String(pet.ticketId) }}
        data-testid="agent-pet"
        data-state={pet.state}
        aria-label={pet.label}
        className={cn(
          'flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
          pet.state === 'asleep' && 'text-muted-foreground',
        )}
      >
        <AgentPet state={pet.state} small={small} index={index} />
        <span className="min-w-0 flex-1 text-xs leading-snug">
          <span className="block truncate font-medium text-foreground">{pet.short}</span>
          <span className="block truncate text-muted-foreground">
            {[pet.agent, pet.phase].filter(Boolean).join(' · ')}
          </span>
          <span className="block truncate text-muted-foreground">{pet.since}</span>
        </span>
      </Link>
    </Tip>
  )
}
