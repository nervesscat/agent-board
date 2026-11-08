import { Link } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  BookmarkX,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GitBranch,
  Hand,
  Layers,
  Scale,
} from 'lucide-react'
import { type DragEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Actor } from '#/components/Actor'
import { ComplexityChip } from '#/components/Complexity'
import { NeedsBadge } from '#/components/Needs'
import { PushDot } from '#/components/PushDot'
import { Tag, compareTags } from '#/components/Tag'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { StalledBadge } from '#/components/WorkTimeline'
import type { Push, TicketRow } from '#/lib/api'
import { ago } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'
import {
  type StageLike,
  columnOrder,
  isClosed,
  mergeAfter,
  stageBadge,
  stageColumn,
  stageOf,
} from '#/lib/stages'
import { nameFirst } from '#/lib/tickets'

/** Where a card goes in its own column: right above or below another card of it. */
export type Placement = { anchor: number; side: 'above' | 'below' }

/**
 * Tickets in the project's stage columns. Drag a card onto another column to change its stage, or up
 * and down its own column to change its place there (a line shows where it lands); Move up / Move down
 * on each card do the same without dragging (touch, keyboard). In a review column the order is the
 * merge order, and a card placed above a ticket it needs says "merge after" it. Clicking a card opens
 * the ticket. A done or cancelled column can archive all its tickets at once. `push` colours each
 * branch by whether it is on origin.
 */
export function TicketBoard({
  projectId,
  items,
  push,
  onMove,
  onPlace,
  onArchiveAll,
}: {
  projectId: string
  items: TicketRow[]
  push?: Map<number, Push>
  onMove: (ticketId: number, status: string) => void
  /** Put a card right above or below another card of its column (of the ones shown). */
  onPlace: (ticketId: number, to: Placement) => void
  onArchiveAll?: (status: string) => void
}) {
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // Dragging within its own column: the gap it would land in, 0 above the first card.
  const [slot, setSlot] = useState<number | null>(null)
  const draggedStatus = items.find((x) => x.id === dragging)?.status
  const endDrag = () => {
    setDragging(null)
    setOver(null)
    setSlot(null)
  }
  const drop = (status: string, column: TicketRow[], at: number) => {
    const t = items.find((x) => x.id === dragging)
    if (t && t.status !== status) onMove(t.id, status)
    else if (t) {
      const to = slotPlacement(column, t.id, at)
      if (to) onPlace(t.id, to)
    }
    endDrag()
  }
  const frame = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // After Move up / Move down the card's control keeps the focus, wherever the card went.
  const refocus = useRef<{ id: number; dir: 'up' | 'down' } | null>(null)
  useEffect(() => {
    const want = refocus.current
    if (!want) return
    const card = scroller.current?.querySelector(`[data-card="${want.id}"]`)
    const button =
      card?.querySelector<HTMLButtonElement>(`[data-move="${want.dir}"]:not(:disabled)`) ??
      card?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)')
    if (button && document.activeElement !== button) button.focus()
    refocus.current = null
  }, [items])
  const edges = useScrollEdges(scroller)
  useFillHeight(frame)
  useRememberedScroll(`features.board.${projectId}`, scroller, stages.length > 0)
  // One column (w-72) plus the gap (gap-3), landing on a column's left edge.
  const step = (dir: -1 | 1) => {
    const el = scroller.current
    if (!el) return
    const col = 288 + 12
    el.scrollTo({ left: (Math.round(el.scrollLeft / col) + dir) * col, behavior: 'smooth' })
  }
  return (
    <div ref={frame} className="flex min-h-80 flex-col">
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
      {/* Fixed-width columns side by side, scrolling sideways; each one as tall as the board, scrolling its own cards. */}
      <div ref={scroller} className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {stages.map(({ key: status, name, kind }) => {
          const column = stageColumn(items, status)
          const own = dragging !== null && draggedStatus === status
          // The line where a card dragged in its own column would land; none where it would not move.
          const line = own && slot !== null && slotPlacement(column, dragging, slot) ? slot : null
          const after = kind === 'review' ? mergeAfter(column) : null
          const move = (t: TicketRow, dir: 'up' | 'down') => {
            const i = column.indexOf(t)
            const other = column[dir === 'up' ? i - 1 : i + 1]
            if (!other) return
            refocus.current = { id: t.id, dir }
            onPlace(t.id, { anchor: other.id, side: dir === 'up' ? 'above' : 'below' })
          }
          // Taking both dragenter and dragover is what marks the column as a place to drop.
          const dragOver = (e: DragEvent<HTMLDivElement>) => {
            if (dragging === null) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (over !== status) setOver(status)
            if (own) {
              const at = slotAt(e.currentTarget, e.clientY)
              if (at !== slot) setSlot(at)
            }
          }
          return (
            <div
              key={status}
              onDragEnter={dragOver}
              onDragOver={dragOver}
              onDragLeave={(e) => {
                // Leaving for a card inside the same column is not leaving the column.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setOver(null)
                setSlot(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(status, column, slotAt(e.currentTarget, e.clientY))
              }}
              className={`flex w-72 shrink-0 flex-col rounded-lg bg-muted/40 p-2 transition-colors ${
                over === status && draggedStatus !== status ? 'bg-primary/10 ring-2 ring-primary/40' : ''
              }`}
            >
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span className="truncate">{name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {onArchiveAll && isClosed(kind) && column.length > 0 && (
                    <ArchiveAll stage={name} n={column.length} onConfirm={() => onArchiveAll(status)} />
                  )}
                  <span className="tabular-nums">{column.length}</span>
                </span>
              </div>
              <div data-column={status} className="min-h-12 flex-1 space-y-2 overflow-y-auto">
                {column.map((t, i) => (
                  <div key={t.id} data-card={t.id} className="group/card relative">
                    {line === i && <DropLine at={i === 0 ? 'top-0' : '-top-[5px]'} />}
                    <Tip content={t.title}>
                      <Link
                        to="/projects/$id/features/$ticketId"
                        params={{ id: projectId, ticketId: String(t.id) }}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', `#${t.id} ${t.title}`)
                          setDragging(t.id)
                        }}
                        onDragEnd={endDrag}
                        // As tall as what it shows, up to a cap: a bare ticket stays small, a busy one stops growing.
                        className={`flex max-h-40 cursor-grab flex-col overflow-hidden rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing ${
                          dragging === t.id ? 'opacity-40' : ''
                        }`}
                      >
                        <div className="flex items-start gap-1.5">
                          <ComplexityChip level={t.complexity} className="mt-0.5" />
                          {/* Room for Move up / Move down where they always show (touch). */}
                          <div className="line-clamp-2 min-w-0 font-medium leading-snug pointer-coarse:pr-14">
                            <span className="text-muted-foreground">#{t.id}</span> {t.title}
                          </div>
                        </div>
                        {(t.decisions > 0 ||
                          t.blockedTasks > 0 ||
                          t.stalled ||
                          t.needs.some((n) => !n.merged) ||
                          after?.has(t.id) ||
                          hasResumeBadge(t.resume)) && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {t.decisions > 0 && <DecisionBadge n={t.decisions} />}
                            {after?.has(t.id) && <MergeAfterBadge ids={after.get(t.id)!} />}
                            {t.blockedTasks > 0 && <BlockedTasksBadge n={t.blockedTasks} />}
                            <StalledBadge stalled={t.stalled} focusable={false} />
                            <NeedsBadge needs={t.needs} />
                            <ResumeBadges resume={t.resume} />
                          </div>
                        )}
                        {/* The time sits at the end of the last of these rows, so it always shares a line. */}
                        {(repoLabel(project, t.repoId) || t.assignee || t.branch) && (
                          <div className={INFO_ROW}>
                            {repoLabel(project, t.repoId) && (
                              <span className="shrink-0 rounded bg-muted px-1">
                                {repoLabel(project, t.repoId)}
                              </span>
                            )}
                            {/* A long name is cut short before its badge; the branch gives way first. */}
                            {t.assignee && <Actor name={t.assignee} truncate />}
                            {t.branch && (
                              <span className="inline-flex min-w-0 shrink-[1000] items-center gap-1 overflow-hidden font-mono">
                                {push?.has(t.id) && <PushDot push={push.get(t.id)!} />}
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
                    </Tip>
                    {column.length > 1 && (
                      <MoveButtons
                        id={t.id}
                        stage={name}
                        first={i === 0}
                        last={i === column.length - 1}
                        onMove={(dir) => move(t, dir)}
                      />
                    )}
                    {line === column.length && i === column.length - 1 && <DropLine at="bottom-0" />}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The gap among a column's cards (`[data-card]`) nearest the pointer at `y`: 0 above the first. */
function slotAt(column: HTMLElement, y: number) {
  const cards = [...column.querySelectorAll<HTMLElement>('[data-card]')]
  const i = cards.findIndex((card) => {
    const r = card.getBoundingClientRect()
    return y < r.top + r.height / 2
  })
  return i < 0 ? cards.length : i
}

/**
 * Where dropping card `id` into gap `at` of its own column puts it: above the card below the gap, or
 * below the last card. Null when that is where it already is.
 */
function slotPlacement(column: TicketRow[], id: number, at: number): Placement | null {
  const from = column.findIndex((t) => t.id === id)
  if (from < 0 || at === from || at === from + 1) return null
  const below = column[at]
  if (below) return { anchor: below.id, side: 'above' }
  const last = column.at(-1)
  return last ? { anchor: last.id, side: 'below' } : null
}

/** Where a card dragged in its own column would land. */
function DropLine({ at }: { at: string }) {
  return (
    <div
      data-drop-indicator
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary ${at}`}
    />
  )
}

/**
 * Move up / Move down, over the card's top right corner: shown while the card is hovered or one of
 * them has the keyboard's focus, always on a touch screen. Disabled at the ends of the column.
 */
function MoveButtons({
  id,
  stage,
  first,
  last,
  onMove,
}: {
  id: number
  stage: string
  first: boolean
  last: boolean
  onMove: (dir: 'up' | 'down') => void
}) {
  const button = (dir: 'up' | 'down', disabled: boolean) => (
    <Tip content={`Move #${id} ${dir} in ${stage}`}>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        data-move={dir}
        disabled={disabled}
        onClick={() => onMove(dir)}
        aria-label={dir === 'up' ? 'Move up' : 'Move down'}
        className="bg-card"
      >
        {dir === 'up' ? <ChevronUp /> : <ChevronDown />}
      </Button>
    </Tip>
  )
  return (
    <div
      data-move-buttons
      className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
    >
      {button('up', first)}
      {button('down', last)}
    </div>
  )
}

/** In a review column, a card placed above tickets it needs merged first: merge it after them. */
function MergeAfterBadge({ ids }: { ids: number[] }) {
  const list = ids.map((n) => `#${n}`).join(', ')
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-400">
      <ArrowDownUp className="size-3" /> merge after {list}
    </span>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The column's "Archive all", asking first. */
function ArchiveAll({ stage, n, onConfirm }: { stage: string; n: number; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <Tip content={`Archive the ${plural(n, 'ticket')} in ${stage}`}>
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 font-normal tracking-normal normal-case"
            />
          }
        >
          <Archive /> Archive all
        </AlertDialogTrigger>
      </Tip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {plural(n, 'ticket')}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every ticket in {stage} comes off the board, with its lanes. They stay under Archived, where each
            can be restored, and their pages still open.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Decisions an agent asked the human to make that are still open. */
export function DecisionBadge({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 ${className}`}
    >
      <Scale className="size-3" /> {n === 1 ? 'decision needed' : `${n} decisions needed`}
    </span>
  )
}

/** Tasks and subtasks (its lanes' with them) tagged blocked: each waits on the human. */
export function BlockedTasksBadge({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 ${className}`}
    >
      <Hand className="size-3" /> {n === 1 ? '1 task blocked' : `${n} tasks blocked`}
    </span>
  )
}

/** Shown from the second day of work on: a ticket that carries over. */
const multiDay = (resume: TicketRow['resume']) => resume.day !== null && resume.day > 1

const hasResumeBadge = (resume: TicketRow['resume']) => resume.noHandoff || multiDay(resume)

/**
 * A ticket that carried over to another day: which day of work this is, and "no handoff" when nobody
 * left a resume note for it since the last day it was worked.
 */
function ResumeBadges({ resume }: { resume: TicketRow['resume'] }) {
  return (
    <>
      {resume.noHandoff && (
        <Tip content="Worked on an earlier day, and nobody left a resume note on where it was left">
          <span className="inline-flex w-fit items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            <BookmarkX className="size-3" /> no handoff
          </span>
        </Tip>
      )}
      {multiDay(resume) && (
        <Tip content="Which day of work this is, counted from when it was started">
          <span className="inline-flex w-fit items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            day {resume.day}
          </span>
        </Tip>
      )}
    </>
  )
}

const INFO_ROW =
  'mt-1.5 flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground'

const Updated = ({ at }: { at: string }) => (
  <span data-testid="card-time" className="ml-auto shrink-0">
    {ago(at)}
  </span>
)

/**
 * Stretches the element down to the bottom of the window, whatever sits above it on the page. It
 * measures again when the window or the page around it changes size, e.g. a notice above it that
 * loads a moment later.
 */
function useFillHeight(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY
      // 24px: the page's bottom padding (main's py-6), so the board ends where the page does.
      const height = `${Math.max(320, window.innerHeight - top - 24)}px`
      if (el.style.height !== height) el.style.height = height
    }
    fit()
    const around = new ResizeObserver(fit)
    if (el.parentElement) around.observe(el.parentElement)
    window.addEventListener('resize', fit)
    return () => {
      around.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [ref])
}

type SavedScroll = { left?: number; top?: number; columns?: Record<string, number> }

function readScroll(key: string): SavedScroll | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as SavedScroll | null
  } catch {
    return null
  }
}

function writeScroll(key: string, value: SavedScroll) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (private mode, blocked): the board just starts at the top
  }
}

/**
 * Where the board was scrolled, sideways and in each column, for this tab: restored when the page
 * comes back, however it is reached (a link, the menu, Back). `ready` once the columns are drawn.
 */
function useRememberedScroll(key: string, scroller: RefObject<HTMLDivElement | null>, ready: boolean) {
  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !ready) return
    const columns = () => [...el.querySelectorAll<HTMLElement>('[data-column]')]
    if (!restored.current) {
      restored.current = true
      const saved = readScroll(key)
      if (saved) {
        el.scrollLeft = saved.left ?? 0
        for (const c of columns()) c.scrollTop = saved.columns?.[c.dataset.column!] ?? 0
      }
    }
    let pending = 0
    const save = () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() =>
        writeScroll(key, {
          left: el.scrollLeft,
          columns: Object.fromEntries(columns().map((c) => [c.dataset.column!, c.scrollTop])),
        }),
      )
    }
    // Scroll events do not bubble; listening while they travel down catches the columns' too.
    el.addEventListener('scroll', save, { capture: true, passive: true })
    return () => {
      cancelAnimationFrame(pending)
      el.removeEventListener('scroll', save, { capture: true })
    }
  }, [key, scroller, ready])
}

/** The page's own scroll position, for the list view: restored when the page comes back. */
function useRememberedPageScroll(key: string) {
  useEffect(() => {
    // After the router's own scroll handling for the navigation, which would put it back at the top.
    const restore = requestAnimationFrame(() => {
      const top = readScroll(key)?.top
      if (top) window.scrollTo(0, top)
    })
    let pending = 0
    const save = () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => writeScroll(key, { top: window.scrollY }))
    }
    window.addEventListener('scroll', save, { passive: true })
    return () => {
      cancelAnimationFrame(restore)
      cancelAnimationFrame(pending)
      window.removeEventListener('scroll', save)
    }
  }, [key])
}

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

export function Progress({ rollup, className = '' }: { rollup: TicketRow['rollup']; className?: string }) {
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

/** Where a search found a ticket in its content, and the words around it. */
function SearchHit({ ticket }: { ticket: TicketRow }) {
  if (!ticket.snippet || !ticket.match) return null
  const where = { id: '', title: '', body: 'Instructions', post: 'Post', reply: 'Reply' }[ticket.match]
  return (
    <div className="mt-1 line-clamp-2 text-xs break-words text-muted-foreground" data-testid="search-hit">
      <span className="font-medium">{where}:</span> {ticket.snippet}
    </div>
  )
}

/**
 * The same tickets as rows, stage by stage in board order, each stage in its column's order (placed
 * first, then newest first), like the lanes list. The rows of a search put the tickets found by name
 * first.
 */
export function TicketList({
  projectId,
  items,
  push,
}: {
  projectId: string
  items: TicketRow[]
  push?: Map<number, Push>
}) {
  useRememberedPageScroll(`features.list.${projectId}`)
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const stageIndex = (key: string) => {
    const i = stages.findIndex((s) => s.key === key)
    return i < 0 ? stages.length : i
  }
  const rows = [...items].sort(
    (a, b) => nameFirst(a) - nameFirst(b) || stageIndex(a.status) - stageIndex(b.status) || columnOrder(a, b),
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
              <Tip content={stage.name}>
                <span
                  className={`mt-px w-20 shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${stageBadge(stage)}`}
                >
                  {stage.name}
                </span>
              </Tip>
              <div className="min-w-0 flex-1">
                <div className="text-sm leading-snug">
                  <span className="text-muted-foreground">#{t.id}</span>{' '}
                  <span className={stage.kind === 'cancelled' ? 'text-muted-foreground line-through' : ''}>
                    {t.title}
                  </span>
                  {t.decisions > 0 && <DecisionBadge n={t.decisions} className="ml-2 align-[1px]" />}
                  {t.blockedTasks > 0 && (
                    <BlockedTasksBadge n={t.blockedTasks} className="ml-2 align-[1px]" />
                  )}
                  <StalledBadge stalled={t.stalled} focusable={false} className="ml-2 align-[1px]" />
                  <NeedsBadge needs={t.needs} className="ml-2 align-[1px]" />
                  {hasResumeBadge(t.resume) && (
                    <span className="ml-2 inline-flex gap-1 align-[1px]">
                      <ResumeBadges resume={t.resume} />
                    </span>
                  )}
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
                      {push?.has(t.id) && <PushDot push={push.get(t.id)!} />}
                      <GitBranch className="size-3 shrink-0" /> <span className="truncate">{t.branch}</span>
                    </span>
                  )}
                  {t.lanes.total > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Layers className="size-3" /> {t.lanes.total} lane{t.lanes.total === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <SearchHit ticket={t} />
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

/**
 * Archived tickets, last archived first (the ones a search found by name before the others), each with
 * who put it away and when, and Restore.
 */
export function ArchivedList({
  projectId,
  items,
  onRestore,
  restoring,
}: {
  projectId: string
  items: TicketRow[]
  onRestore: (ticketId: number) => void
  /** The ticket being restored right now, if any. */
  restoring?: number
}) {
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const rows = [...items].sort(
    (a, b) => nameFirst(a) - nameFirst(b) || (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''),
  )
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing archived.</p>
  return (
    <ul className="divide-y rounded-md border">
      {rows.map((t) => {
        const stage = stageOf(stages, t.status)
        return (
          <li key={t.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <Tip content={stage.name}>
              <span
                className={`w-20 shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${stageBadge(stage)}`}
              >
                {stage.name}
              </span>
            </Tip>
            <div className="min-w-0 flex-1">
              <Link
                to="/projects/$id/features/$ticketId"
                params={{ id: projectId, ticketId: String(t.id) }}
                className="text-sm leading-snug hover:underline"
              >
                <span className="text-muted-foreground">#{t.id}</span> {t.title}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  archived {ago(t.archivedAt)}
                  {t.archivedBy && (
                    <>
                      {' '}
                      by <Actor name={t.archivedBy} />
                    </>
                  )}
                </span>
                {t.lanes.total > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3" /> {plural(t.lanes.total, 'lane')}
                  </span>
                )}
              </div>
              <SearchHit ticket={t} />
            </div>
            <Button variant="outline" size="sm" disabled={restoring === t.id} onClick={() => onRestore(t.id)}>
              <ArchiveRestore /> Restore
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
