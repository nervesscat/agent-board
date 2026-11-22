import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GitMerge, Plus, TriangleAlert, X } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from 'cn'

import { ControlSkeleton } from '#/components/ControlSkeleton'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { shared } from '#/i18n'
import { ApiError, errorMessage, get, type Need, type TicketFull, type TicketRow } from '#/lib/api'

const AMBER = 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'

/** What a need waits for, for a tooltip: its branch into the base it has to reach. */
const needTitle = (n: Need) =>
  n.branch
    ? shared.t(n.merged ? 'needs.titleIn' : 'needs.titleNotIn', {
        id: n.id,
        title: n.title,
        branch: n.branch,
        into: n.into,
      })
    : shared.t(n.merged ? 'needs.titleDone' : 'needs.titleNotDone', { id: n.id, title: n.title })

/**
 * A move refused because something the ticket needs is not merged yet: the reason, with the human's
 * way past it (`force`). Any other error shows as it is.
 */
export function toastRefusal(err: unknown, force: () => void, label = shared.t('needs.markDoneAnyway')) {
  if (err instanceof ApiError && err.code === 'needs')
    toast.error(err.message, { duration: 15_000, action: { label, onClick: force } })
  else toast.error(errorMessage(err))
}

/** "needs #3": what a card or row waits on to be merged first; nothing once all of it is. */
export function NeedsBadge({ needs, className }: { needs: Need[]; className?: string }) {
  const { t: tr } = useTranslation()
  const open = needs.filter((n) => !n.merged)
  if (!open.length) return null
  return (
    <Tip content={tr('needs.mergeFirst', { list: open.map(needTitle).join('\n') })}>
      <span
        className={cn(
          'inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
          AMBER,
          className,
        )}
      >
        <GitMerge className="size-3" /> {tr('needs.badge', { list: open.map((n) => `#${n.id}`).join(', ') })}
      </span>
    </Tip>
  )
}

/** The ticket page's header: each need, "not merged yet" (amber) or "merged" (green), linking to it. */
export function NeedsStatus({ t }: { t: TicketFull }) {
  const { t: tr } = useTranslation()
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
        <GitMerge className="size-3.5" />{' '}
        {tr(n.merged ? 'needs.statusMerged' : 'needs.statusNotMerged', { id: n.id })}
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
  const { t: tr } = useTranslation()
  // Every ticket of the project, lanes too: a branch can stand on any of them.
  const { data: tickets = [], isPending } = useQuery({
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
                <Tip content={tr('needs.removeNeed', { id: n.id })}>
                  <button
                    type="button"
                    aria-label={tr('needs.removeNeed', { id: n.id })}
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
        disabled={isPending || !options.length}
      >
        <SelectTrigger id="needs" size="sm" className="w-full">
          <SelectValue
            placeholder={
              isPending ? (
                <ControlSkeleton label={tr('loading.tickets')} />
              ) : options.length ? (
                tr('needs.addPlaceholder')
              ) : (
                tr('needs.noOthers')
              )
            }
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
            <Trans
              i18nKey="needs.includes"
              values={{ ref: `#${id}${title(id) ? ` ${title(id)}` : ''}` }}
              components={{
                goto: (
                  <Link
                    to="/projects/$id/features/$ticketId"
                    params={{ id: String(t.projectId), ticketId: String(id) }}
                    className="font-medium hover:underline"
                  />
                ),
              }}
            />
          </span>
          <Tip content={tr('needs.cannotBeDone', { id: t.id, need: id })}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => onSave([...ids, id])}
            >
              <Plus data-icon="inline-start" /> {tr('needs.addAsNeed')}
            </Button>
          </Tip>
        </div>
      ))}
    </div>
  )
}
