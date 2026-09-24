import { Link } from '@tanstack/react-router'
import { GitBranch, Layers } from 'lucide-react'
import { useState } from 'react'

import { Actor } from '#/components/Actor'
import { Tag, compareTags } from '#/components/Tag'
import type { TicketRow } from '#/lib/api'
import { TICKET_STATUSES, type TicketStatus } from '#/lib/constants'
import { STATUS_LABEL, ago } from '#/lib/format'
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
    <div className="grid gap-3 md:grid-cols-5">
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
            className={`rounded-lg bg-muted/40 p-2 transition-colors ${
              over === status && draggedStatus !== status ? 'bg-primary/10 ring-2 ring-primary/40' : ''
            }`}
          >
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {STATUS_LABEL[status]} <span className="tabular-nums">{column.length}</span>
            </div>
            <div className="min-h-16 space-y-2">
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
                  className={`block cursor-grab rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing ${
                    dragging === t.id ? 'opacity-40' : ''
                  }`}
                >
                  <div className="font-medium leading-snug">
                    <span className="text-muted-foreground">#{t.id}</span> {t.title}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {repoLabel(project, t.repoId) && (
                      <span className="rounded bg-muted px-1">{repoLabel(project, t.repoId)}</span>
                    )}
                    {t.assignee && <Actor name={t.assignee} />}
                    {t.branch && (
                      <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                        <GitBranch className="size-3 shrink-0" /> <span className="truncate">{t.branch}</span>
                      </span>
                    )}
                    <span className="ml-auto">{ago(t.updatedAt)}</span>
                  </div>
                  {t.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {[...t.tags].sort(compareTags).map((tag) => (
                        <Tag key={tag} tag={tag} />
                      ))}
                    </div>
                  )}
                  {t.lanes.total > 0 && <LaneCount lanes={t.lanes} />}
                  {t.rollup.total > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${(100 * t.rollup.done) / t.rollup.total}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {t.rollup.done}/{t.rollup.total}
                      </span>
                    </div>
                  )}
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
  ['review', 'in review'],
  ['done', 'done'],
]

/** "3 lanes · 1 active · 1 in review" */
function LaneCount({ lanes }: { lanes: TicketRow['lanes'] }) {
  const parts = LANE_WORDS.filter(([s]) => lanes[s]).map(([s, word]) => `${lanes[s]} ${word}`)
  if (lanes.approved) parts.push(`${lanes.approved} approved`)
  return (
    <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
      <Layers className="size-3" />
      {[`${lanes.total} lane${lanes.total === 1 ? '' : 's'}`, ...parts].join(' · ')}
    </div>
  )
}
