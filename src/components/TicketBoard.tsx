import { Link } from '@tanstack/react-router'
import { GitBranch, Layers } from 'lucide-react'
import { useState } from 'react'

import { Actor } from '#/components/Actor'
import { Tag, compareTags } from '#/components/Tag'
import type { TicketRow } from '#/lib/api'
import { TICKET_STATUSES, type TicketStatus } from '#/lib/constants'
import { STAGE_TAG, STATUS_LABEL, ago } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'

/**
 * Tickets in status columns. Drag a card onto another column to change its status; clicking a card
 * opens the ticket.
 */
export function TicketBoard({
  projectId,
  items,
  onMove,
}: {
  projectId: string
  items: TicketRow[]
  onMove: (ticketId: number, status: TicketStatus) => void
}) {
  const { data: project } = useProject(projectId)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<TicketStatus | null>(null)
  const draggedStatus = items.find((x) => x.id === dragging)?.status
  const drop = (status: TicketStatus) => {
    const t = items.find((x) => x.id === dragging)
    if (t && t.status !== status) onMove(t.id, status)
    setDragging(null)
    setOver(null)
  }
  return (
    // Fixed-width columns side by side, scrolling sideways; each column is as tall as its own cards.
    <div className="flex items-start gap-3 overflow-x-auto pb-2">
      {TICKET_STATUSES.map((status) => {
        const column = items.filter((t) => t.status === status)
        return (
          <div
            key={status}
            onDragOver={(e) => {
              if (dragging === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== status) setOver(status)
            }}
            onDragLeave={(e) => {
              // Leaving for a card inside the same column is not leaving the column.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop(status)
            }}
            className={`w-72 shrink-0 rounded-lg bg-muted/40 p-2 transition-colors ${
              over === status && draggedStatus !== status ? 'bg-primary/10 ring-2 ring-primary/40' : ''
            }`}
          >
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {STATUS_LABEL[status]} <span className="tabular-nums">{column.length}</span>
            </div>
            <div className="min-h-12 space-y-2">
              {column.map((t) => (
                <Link
                  key={t.id}
                  to="/projects/$id/features/$ticketId"
                  params={{ id: projectId, ticketId: String(t.id) }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', `#${t.id} ${t.title}`)
                    setDragging(t.id)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                  className={`flex h-40 cursor-grab flex-col overflow-hidden rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing ${
                    dragging === t.id ? 'opacity-40' : ''
                  }`}
                  title={t.title}
                >
                  <div className="line-clamp-2 font-medium leading-snug">
                    <span className="text-muted-foreground">#{t.id}</span> {t.title}
                  </div>
                  <div className="mt-1.5 flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                    {repoLabel(project, t.repoId) && (
                      <span className="shrink-0 rounded bg-muted px-1">{repoLabel(project, t.repoId)}</span>
                    )}
                    {t.assignee && <Actor name={t.assignee} className="shrink-0" />}
                    {t.branch && (
                      <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                        <GitBranch className="size-3 shrink-0" /> <span className="truncate">{t.branch}</span>
                      </span>
                    )}
                    <span className="ml-auto shrink-0">{ago(t.updatedAt)}</span>
                  </div>
                  {t.tags.length > 0 && (
                    <div className="mt-1.5 flex min-w-0 gap-1 overflow-hidden">
                      {[...t.tags].sort(compareTags).map((tag) => (
                        <Tag key={tag} tag={tag} className="shrink-0" />
                      ))}
                    </div>
                  )}
                  {t.lanes.total > 0 && <LaneCount lanes={t.lanes} />}
                  {t.rollup.total > 0 && <Progress rollup={t.rollup} className="mt-auto pt-2" />}
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const LANE_WORDS: [TicketStatus, string][] = [
  ['in_progress', 'active'],
  ['blocked', 'blocked'],
  ['review', 'in review'],
  ['done', 'done'],
  ['cancelled', 'cancelled'],
]

/** "3 lanes · 1 active · 1 in review" */
function LaneCount({ lanes }: { lanes: TicketRow['lanes'] }) {
  const parts = LANE_WORDS.filter(([s]) => lanes[s]).map(([s, word]) => `${lanes[s]} ${word}`)
  if (lanes.approved) parts.push(`${lanes.approved} approved`)
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Layers className="size-3 shrink-0" />
      <span className="truncate">
        {[`${lanes.total} lane${lanes.total === 1 ? '' : 's'}`, ...parts].join(' · ')}
      </span>
    </div>
  )
}

function Progress({ rollup, className = '' }: { rollup: TicketRow['rollup']; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${(100 * rollup.done) / rollup.total}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {rollup.done}/{rollup.total}
      </span>
    </div>
  )
}

/** The same tickets as rows, in column order (newest first within a status), like the lanes list. */
export function TicketList({ projectId, items }: { projectId: string; items: TicketRow[] }) {
  const { data: project } = useProject(projectId)
  const rows = [...items].sort(
    (a, b) =>
      TICKET_STATUSES.indexOf(a.status) - TICKET_STATUSES.indexOf(b.status) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
  if (!rows.length) return <p className="text-sm text-muted-foreground">No tickets.</p>
  return (
    <ul className="divide-y rounded-md border">
      {rows.map((t) => (
        <li key={t.id} className="transition-colors hover:bg-muted/50">
          <Link
            to="/projects/$id/features/$ticketId"
            params={{ id: projectId, ticketId: String(t.id) }}
            className="flex min-w-0 items-start gap-3 px-3 py-2.5"
          >
            <span
              className={`mt-px w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${STAGE_TAG[t.status]}`}
            >
              {STATUS_LABEL[t.status]}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm leading-snug">
                <span className="text-muted-foreground">#{t.id}</span>{' '}
                <span className={t.status === 'cancelled' ? 'text-muted-foreground line-through' : ''}>
                  {t.title}
                </span>
                {t.tags.length > 0 && (
                  <span className="ml-2 inline-flex flex-wrap gap-1 align-[1px]">
                    {[...t.tags].sort(compareTags).map((tag) => (
                      <Tag key={tag} tag={tag} />
                    ))}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {repoLabel(project, t.repoId) && (
                  <span className="rounded bg-muted px-1">{repoLabel(project, t.repoId)}</span>
                )}
                {t.assignee && <Actor name={t.assignee} />}
                {t.branch && (
                  <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                    <GitBranch className="size-3 shrink-0" /> <span className="truncate">{t.branch}</span>
                  </span>
                )}
                {t.lanes.total > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3" /> {t.lanes.total} lane{t.lanes.total === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums text-muted-foreground">
              {t.rollup.total > 0 && (
                <span>
                  {t.rollup.done}/{t.rollup.total}
                </span>
              )}
              <span>{ago(t.updatedAt)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
