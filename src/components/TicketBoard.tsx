import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, GitBranch, Layers } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Actor } from '#/components/Actor'
import { Tag, compareTags } from '#/components/Tag'
import { Button } from '#/components/ui/button'
import type { TicketRow } from '#/lib/api'
import { ago } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'
import { type StageLike, stageBadge, stageOf } from '#/lib/stages'

/**
 * Tickets in the project's stage columns. Drag a card onto another column to change its stage;
 * clicking a card opens the ticket.
 */
export function TicketBoard({
  projectId,
  items,
  onMove,
}: {
  projectId: string
  items: TicketRow[]
  onMove: (ticketId: number, status: string) => void
}) {
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const draggedStatus = items.find((x) => x.id === dragging)?.status
  const drop = (status: string) => {
    const t = items.find((x) => x.id === dragging)
    if (t && t.status !== status) onMove(t.id, status)
    setDragging(null)
    setOver(null)
  }
  const scroller = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(scroller)
  // One column (w-72) plus the gap (gap-3), landing on a column's left edge.
  const step = (dir: -1 | 1) => {
    const el = scroller.current
    if (!el) return
    const col = 288 + 12
    el.scrollTo({ left: (Math.round(el.scrollLeft / col) + dir) * col, behavior: 'smooth' })
  }
  return (
    <div>
      {(edges.left || edges.right) && (
        <div className="mb-2 flex justify-end gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!edges.left}
            onClick={() => step(-1)}
            aria-label="Previous stage"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!edges.right}
            onClick={() => step(1)}
            aria-label="Next stage"
          >
            <ChevronRight />
          </Button>
        </div>
      )}
      {/* Fixed-width columns side by side, scrolling sideways; each column is as tall as its own cards. */}
      <div ref={scroller} className="flex items-start gap-3 overflow-x-auto pb-2">
        {stages.map(({ key: status, name }) => {
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
                <span className="truncate">{name}</span> <span className="tabular-nums">{column.length}</span>
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
                    // As tall as what it shows, up to a cap: a bare ticket stays small, a busy one stops growing.
                    className={`flex max-h-40 cursor-grab flex-col overflow-hidden rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing ${
                      dragging === t.id ? 'opacity-40' : ''
                    }`}
                    title={t.title}
                  >
                    <div className="line-clamp-2 font-medium leading-snug">
                      <span className="text-muted-foreground">#{t.id}</span> {t.title}
                    </div>
                    {/* The time sits at the end of the last of these rows, so it always shares a line. */}
                    {(repoLabel(project, t.repoId) || t.assignee || t.branch) && (
                      <div className={INFO_ROW}>
                        {repoLabel(project, t.repoId) && (
                          <span className="shrink-0 rounded bg-muted px-1">
                            {repoLabel(project, t.repoId)}
                          </span>
                        )}
                        {t.assignee && <Actor name={t.assignee} className="shrink-0" />}
                        {t.branch && (
                          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                            <GitBranch className="size-3 shrink-0" />{' '}
                            <span className="truncate">{t.branch}</span>
                          </span>
                        )}
                        {!t.tags.length && <Updated at={t.updatedAt} />}
                      </div>
                    )}
                    {t.tags.length > 0 && (
                      <div className={INFO_ROW}>
                        {/* Tags clip on their own, so a long list never pushes the time out of view. */}
                        <div className="flex min-w-0 gap-1 overflow-hidden">
                          {[...t.tags].sort(compareTags).map((tag) => (
                            <Tag key={tag} tag={tag} className="shrink-0" />
                          ))}
                        </div>
                        <Updated at={t.updatedAt} />
                      </div>
                    )}
                    {!repoLabel(project, t.repoId) && !t.assignee && !t.branch && !t.tags.length && (
                      <div className={INFO_ROW}>
                        <Updated at={t.updatedAt} />
                      </div>
                    )}
                    {t.lanes.total > 0 && <LaneCount lanes={t.lanes} stages={stages} />}
                    {t.rollup.total > 0 && <Progress rollup={t.rollup} className="mt-auto pt-2" />}
                  </Link>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const INFO_ROW =
  'mt-1.5 flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground'

const Updated = ({ at }: { at: string }) => <span className="ml-auto shrink-0">{ago(at)}</span>

/** Whether a sideways scroller has more to show on its left and on its right. */
function useScrollEdges(ref: React.RefObject<HTMLDivElement | null>) {
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () =>
      setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref])
  return edges
}

/** "3 lanes · 1 in progress · 1 in review": lanes per stage, leaving out the ones still waiting. */
function LaneCount({ lanes, stages }: { lanes: TicketRow['lanes']; stages: StageLike[] }) {
  const parts = stages
    .filter((s) => s.kind !== 'open' && lanes.byStage[s.key])
    .map((s) => `${lanes.byStage[s.key]} ${s.name.toLowerCase()}`)
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
  const stages = project?.stages ?? []
  const rank = (key: string) => {
    const i = stages.findIndex((s) => s.key === key)
    return i < 0 ? stages.length : i
  }
  const rows = [...items].sort(
    (a, b) => rank(a.status) - rank(b.status) || b.updatedAt.localeCompare(a.updatedAt),
  )
  if (!rows.length) return <p className="text-sm text-muted-foreground">No tickets.</p>
  return (
    <ul className="divide-y rounded-md border">
      {rows.map((t) => {
        const stage = stageOf(stages, t.status)
        return (
          <li key={t.id} className="transition-colors hover:bg-muted/50">
            <Link
              to="/projects/$id/features/$ticketId"
              params={{ id: projectId, ticketId: String(t.id) }}
              className="flex min-w-0 items-start gap-3 px-3 py-2.5"
            >
              <span
                className={`mt-px w-20 shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${stageBadge(stage)}`}
                title={stage.name}
              >
                {stage.name}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm leading-snug">
                  <span className="text-muted-foreground">#{t.id}</span>{' '}
                  <span className={stage.kind === 'cancelled' ? 'text-muted-foreground line-through' : ''}>
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
        )
      })}
    </ul>
  )
}
