import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GitMerge, Plus, Sparkles, TriangleAlert, X } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from 'cn'

import { ControlSkeleton } from '#/components/ControlSkeleton'
import { Button } from '#/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { shared } from '#/i18n'
import {
  ApiError,
  errorMessage,
  get,
  type Need,
  type TicketFull,
  type TicketGit,
  type TicketRow,
} from '#/lib/api'

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

/**
 * The ticket page's header: each need not merged yet, in amber, linking to it. A merged need shows
 * nothing here: the warning is the only thing the header says.
 */
export function NeedsStatus({ t }: { t: TicketFull }) {
  const { t: tr } = useTranslation()
  return t.needs
    .filter((n) => !n.merged)
    .map((n) => (
      <Tip key={n.id} content={needTitle(n)}>
        <Link
          to="/projects/$id/features/$ticketId"
          params={{ id: String(t.projectId), ticketId: String(n.id) }}
          className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:underline', AMBER)}
        >
          <GitMerge className="size-3.5" /> {tr('needs.statusNotMerged', { id: n.id })}
        </Link>
      </Tip>
    ))
}

/**
 * The Needs field of the ticket's details: what must be merged into its base before it can be done,
 * as chips (× takes one off; the ones the board added carry a sparkle), a picker of the project's
 * other tickets to add one, and, for the open tickets whose unmerged work its branch holds but the board
 * cannot tell for sure is theirs (so it added no need), a row each with "Add as a need". The board adds
 * the ones it can prove itself, so those never show here.
 */
export function NeedsField({ t, onSave }: { t: TicketFull; onSave: (needs: number[]) => void }) {
  const { t: tr } = useTranslation()
  // Every ticket of the project, lanes too: a branch can stand on any of them.
  const { data: tickets = [], isPending } = useQuery({
    queryKey: ['tickets', String(t.projectId), 'all'],
    queryFn: () => get<TicketRow[]>(`/api/projects/${t.projectId}/tickets`),
    staleTime: 30_000,
  })
  // Read apart from the ticket's git state: the scan behind it is the slow part, and the server keeps
  // its answer until a branch or a ticket changes.
  const { data: included } = useQuery({
    queryKey: ['ticket-git', String(t.id), 'includes'],
    queryFn: () => get<TicketGit>(`/api/tickets/${t.id}/git?includes=1`),
    select: (g) => g.includes ?? [],
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const ids = t.needs.map((n) => n.id)
  const suggested = (included ?? []).filter((id) => !ids.includes(id) && !t.neededBy.some((n) => n.id === id))
  const title = (id: number) => tickets.find((x) => x.id === id)?.title
  // Not itself, not twice, and not one that needs it already (the server checks longer loops).
  const blocked = new Set([t.id, ...ids, ...t.neededBy.map((n) => n.id)])
  const options = tickets.filter((x) => !blocked.has(x.id)).sort((a, b) => b.id - a.id)
  const items = Object.fromEntries(options.map((x) => [String(x.id), `#${x.id} ${x.title}`]))
  return (
    <div className="space-y-1.5">
      {t.needs.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {t.needs.map((n) => (
            <Tip key={n.id} content={n.auto ? `${needTitle(n)}\n${tr('needs.autoTitle')}` : needTitle(n)}>
              <li
                data-auto={n.auto || undefined}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs',
                  n.merged ? GREEN : AMBER,
                )}
              >
                {n.auto && <Sparkles aria-label={tr('needs.addedByBoard')} className="size-3 shrink-0" />}
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
        <div
          key={id}
          data-testid="includes-hint"
          className={cn('flex items-start gap-1.5 rounded px-1.5 py-1 text-xs', AMBER)}
        >
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
          <Tip content={tr('needs.cannotBeDoneUnsure', { id: t.id, need: id })}>
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
