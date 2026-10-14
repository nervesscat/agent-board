import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GitMerge, Plus, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'

import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { ApiError, errorMessage, get, type Need, type TicketFull, type TicketRow } from '#/lib/api'

const AMBER = 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'

/** What a need waits for, for a tooltip: its branch into the base it has to reach. */
const needTitle = (n: Need) =>
  `#${n.id} ${n.title}${n.branch ? `: ${n.branch} ${n.merged ? 'is in' : 'not merged into'} ${n.into}` : n.merged ? ': done' : ': not done, no branch'}`

/**
 * A move refused because something the ticket needs is not merged yet: the reason, with the human's
 * way past it (`force`). Any other error shows as it is.
 */
export function toastRefusal(err: unknown, force: () => void, label = 'Mark done anyway') {
  if (err instanceof ApiError && err.code === 'needs')
    toast.error(err.message, { duration: 15_000, action: { label, onClick: force } })
  else toast.error(errorMessage(err))
}

/** "needs #3": what a card or row waits on to be merged first; nothing once all of it is. */
export function NeedsBadge({ needs, className }: { needs: Need[]; className?: string }) {
  const open = needs.filter((n) => !n.merged)
  if (!open.length) return null
  return (
    <Tip content={`Merge first:\n${open.map(needTitle).join('\n')}`}>
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
          AMBER,
          className,
        )}
      >
        <GitMerge className="size-3" /> needs {open.map((n) => `#${n.id}`).join(', ')}
      </span>
    </Tip>
  )
}

/** The ticket page's header: each need, "not merged yet" (amber) or "merged" (green), linking to it. */
export function NeedsStatus({ t }: { t: TicketFull }) {
  return t.needs.map((n) => (
    <Tip key={n.id} content={needTitle(n)}>
      <Link
        to="/projects/$id/features/$ticketId"
        params={{ id: String(t.projectId), ticketId: String(n.id) }}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:underline',
          n.merged ? GREEN : AMBER,
        )}
      >
        <GitMerge className="size-3.5" /> Needs #{n.id} · {n.merged ? 'merged' : 'not merged yet'}
      </Link>
    </Tip>
  ))
}

/**
 * The Needs field of the ticket's details: what must be merged into its base before it can be done,
 * as chips (× takes one off), a picker of the project's other tickets to add one, and the open
 * tickets whose unmerged work its branch already holds, each with "Add as a need".
 */
export function NeedsField({
  t,
  includes = [],
  onSave,
}: {
  t: TicketFull
  includes?: number[]
  onSave: (needs: number[]) => void
}) {
  // Every ticket of the project, lanes too: a branch can stand on any of them.
  const { data: tickets = [] } = useQuery({
    queryKey: ['tickets', String(t.projectId), 'all'],
    queryFn: () => get<TicketRow[]>(`/api/projects/${t.projectId}/tickets`),
    staleTime: 30_000,
  })
  const ids = t.needs.map((n) => n.id)
  // Not itself, not twice, and not one that needs it already (the server checks longer loops).
  const blocked = new Set([t.id, ...ids, ...t.neededBy.map((n) => n.id)])
  const options = tickets.filter((x) => !blocked.has(x.id)).sort((a, b) => b.id - a.id)
  const items = Object.fromEntries(options.map((x) => [String(x.id), `#${x.id} ${x.title}`]))
  const title = (id: number) => tickets.find((x) => x.id === id)?.title
  const suggested = includes.filter((id) => !ids.includes(id))
  return (
    <div className="space-y-1.5">
      {t.needs.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {t.needs.map((n) => (
            <Tip key={n.id} content={needTitle(n)}>
              <li
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs',
                  n.merged ? GREEN : AMBER,
                )}
              >
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: String(t.projectId), ticketId: String(n.id) }}
                  className="min-w-0 truncate hover:underline"
                >
                  #{n.id} {n.title}
                </Link>
                <Tip content={`Remove the need for #${n.id}`}>
                  <button
                    type="button"
                    aria-label={`Remove the need for #${n.id}`}
                    className="shrink-0 opacity-70 hover:opacity-100"
                    onClick={() => onSave(ids.filter((id) => id !== n.id))}
                  >
                    <X className="size-3" />
                  </button>
                </Tip>
              </li>
            </Tip>
          ))}
        </ul>
      )}
      <Select
        value={null}
        onValueChange={(v) => v && onSave([...ids, Number(v)])}
        items={items}
        disabled={!options.length}
      >
        <SelectTrigger id="needs" size="sm" className="w-full">
          <SelectValue
            placeholder={options.length ? 'Add a ticket it needs merged first…' : 'No other tickets'}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((x) => (
            <SelectItem key={x.id} value={String(x.id)}>
              <span className="truncate">
                <span className="text-muted-foreground">#{x.id}</span> {x.title}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {suggested.map((id) => (
        <div key={id} className={cn('flex items-start gap-1.5 rounded px-1.5 py-1 text-xs', AMBER)}>
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Includes unmerged work from{' '}
            <Link
              to="/projects/$id/features/$ticketId"
              params={{ id: String(t.projectId), ticketId: String(id) }}
              className="font-medium hover:underline"
            >
              #{id}
              {title(id) ? ` ${title(id)}` : ''}
            </Link>
          </span>
          <Tip content={`#${t.id} cannot be done until #${id}'s branch is merged into its base`}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => onSave([...ids, id])}
            >
              <Plus data-icon="inline-start" /> Add as a need
            </Button>
          </Tip>
        </div>
      ))}
    </div>
  )
}
