import { Link } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Hammer,
  Hand,
  Hourglass,
  Layers,
  Scale,
  UserRound,
} from 'lucide-react'
import { type DragEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Actor } from '#/components/Actor'
import { ComplexityChip } from '#/components/Complexity'
import { NeedsBadge } from '#/components/Needs'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { NowLine, StallNotice } from '#/components/WorkStatus'
import type { TicketRow } from '#/lib/api'
import { hasWork, nowBrief, nowWords, stallStage, timelineFromActivity } from '#/lib/activityTimeline'
import { ago } from '#/lib/format'
import { useProject } from '#/lib/project'
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
import { useNow, useServerOffset } from '#/lib/useNow'
import { onServerClock } from '#/lib/workStatus'

/** Where a card goes in its own column: right above or below another card of it. */
export type Placement = { anchor: number; side: 'above' | 'below' }

/**
 * Tickets in the project's stage columns. Drag a card onto another column to change its stage, or up
 * and down its own column to change its place there (a line shows where it lands). In a review column
 * the order is the merge order, read top to bottom, and a card placed above a ticket it needs says
 * "merge after" it. Clicking a card opens
 * the ticket. A done or cancelled column can archive all its tickets at once.
 */
export function TicketBoard({
  projectId,
  items,
  onMove,
  onPlace,
  onArchiveAll,
}: {
  projectId: string
  items: TicketRow[]
  onMove: (ticketId: number, status: string) => void
  /** Put a card right above or below another card of its column (of the ones shown). */
  onPlace: (ticketId: number, to: Placement) => void
  onArchiveAll?: (status: string) => void
}) {
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const tick = useNow(60_000)
  // The rows of one read share the server's time: the board's now is read on that clock, not the browser's.
  const now = onServerClock(tick, useServerOffset(items[0]?.activity.now))
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // Dragging within its own column: the gap it would land in, 0 above the first card.
  const [slot, setSlot] = useState<number | null>(null)
  // A phone shows one stage at a time; this is the one picked (none: the first with tickets).
  const [pickedStage, pickStage] = useRememberedStage(`features.board.stage.${projectId}`, stages)
  const activeStage =
    stages.find((s) => s.key === pickedStage)?.key ??
    stages.find((s) => stageColumn(items, s.key).length > 0)?.key ??
    stages[0]?.key
  const stageItems = Object.fromEntries(
    stages.map((s) => [s.key, `${s.name} (${stageColumn(items, s.key).length})`]),
  )
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
    <div ref={frame} className="flex flex-col md:min-h-80">
      {stages.length > 0 && activeStage && (
        <div className="mb-2 md:hidden">
          <Select value={activeStage} onValueChange={(v) => v && pickStage(v)} items={stageItems}>
            <SelectTrigger className="w-full" aria-label="Stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name} ({stageColumn(items, s.key).length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {(edges.left || edges.right) && (
        <div className="mb-2 hidden justify-end gap-1 md:flex">
          <Button
            variant="outline"
            size="icon"
            disabled={!edges.left}
            onClick={() => step(-1)}
            aria-label="Previous stage"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!edges.right}
            onClick={() => step(1)}
            aria-label="Next stage"
          >
            <ChevronRight />
          </Button>
        </div>
      )}
      {/* Fixed-width columns side by side, scrolling sideways; each one as tall as the board, scrolling its own cards. */}
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-auto pb-2 md:flex-row">
        {stages.map(({ key: status, name, kind }) => {
          const column = stageColumn(items, status)
          const own = dragging !== null && draggedStatus === status
          // The line where a card dragged in its own column would land; none where it would not move.
          const line = own && slot !== null && slotPlacement(column, dragging, slot) ? slot : null
          const after = kind === 'review' ? mergeAfter(column) : null
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
              className={`flex w-full shrink-0 flex-col rounded-lg bg-muted/40 p-2 transition-colors md:w-72 ${
                status !== activeStage ? 'max-md:hidden' : ''
              } ${over === status && draggedStatus !== status ? 'bg-primary/10 ring-2 ring-primary/40' : ''}`}
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
              <div data-column={status} className="min-h-12 flex-1 space-y-2 md:overflow-y-auto">
                {column.map((t, i) => {
                  // The card's work, from what its row carries: the now, and the stall (as the list and the ticket page word them).
                  const work = timelineFromActivity(t.activity, t.stalled, hasWork(kind))
                  // The now shows on a card with no other badge: a busy card is capped in height, and its time must not clip.
                  const badged =
                    t.decisions > 0 ||
                    t.blockedNext ||
                    !!t.stalled ||
                    t.needs.some((n) => !n.merged) ||
                    after?.has(t.id)
                  const words = nowWords(work, now)
                  const brief = badged ? null : nowBrief(work, now)
                  return (
                    <div key={t.id} data-card={t.id} className="relative">
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
                          className={`flex max-h-40 cursor-grab flex-col overflow-hidden rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing max-md:max-h-none ${
                            dragging === t.id ? 'opacity-40' : ''
                          }`}
                        >
                          <div className="flex items-start gap-1.5">
                            <ComplexityChip level={t.complexity} className="mt-0.5" />
                            <div className="line-clamp-2 min-w-0 font-medium leading-snug max-md:line-clamp-none">
                              <span className="text-muted-foreground">#{t.id}</span> {t.title}
                            </div>
                          </div>
                          {(t.decisions > 0 ||
                            t.blockedNext ||
                            t.stalled ||
                            brief ||
                            t.needs.some((n) => !n.merged) ||
                            after?.has(t.id)) && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              {brief && <NowBadge brief={brief} words={words} />}
                              {t.decisions > 0 && <DecisionBadge n={t.decisions} />}
                              {after?.has(t.id) && <MergeAfterBadge ids={after.get(t.id)!} />}
                              {t.blockedNext && <BlockedTasksBadge n={t.blockedTasks} />}
                              <StallNotice
                                timeline={work}
                                stage={stallStage(stages, t.status)}
                                nowLine={words}
                                focusable={false}
                              />
                              <NeedsBadge needs={t.needs} />
                            </div>
                          )}
                          {/* The time sits at the end of the row, so it always shares a line. */}
                          <div className={INFO_ROW}>
                            {t.tags.length > 0 && (
                              // Tags clip on their own, so a long list never pushes the time out of view.
                              <div className="flex min-w-0 gap-1 overflow-hidden">
                                {[...t.tags].sort(compareTags).map((tag) => (
                                  <Tag key={tag} tag={tag} className="shrink-0" />
                                ))}
                              </div>
                            )}
                            <Updated at={t.updatedAt} />
                          </div>
                          {t.lanes.total > 0 && <LaneCount lanes={t.lanes} stages={stages} />}
                          {t.rollup.total > 0 && <Progress rollup={t.rollup} className="mt-auto pt-2" />}
                        </Link>
                      </Tip>
                      {line === column.length && i === column.length - 1 && <DropLine at="bottom-0" />}
                    </div>
                  )
                })}
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

/** The card's now in little: an icon and how long, with the whole line (what, who, since when) in its tooltip. */
function NowBadge({ brief, words }: { brief: { kind: string; text: string }; words: string }) {
  const Icon =
    brief.kind === 'waiting-human' ? UserRound : brief.kind === 'waiting-agent' ? Hourglass : Hammer
  return (
    <Tip content={words}>
      <span
        data-testid="card-now"
        className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 tabular-nums"
      >
        <Icon className="size-3" aria-hidden />
        {brief.text}
      </span>
    </Tip>
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
    // Only the desktop board fills the window: a phone shows one stage and scrolls the page.
    const wide = window.matchMedia('(min-width: 768px)')
    const fit = () => {
      if (!wide.matches) {
        el.style.height = ''
        return
      }
      const top = el.getBoundingClientRect().top + window.scrollY
      // 24px: the page's bottom padding (main's py-6), so the board ends where the page does.
      const height = `${Math.max(320, window.innerHeight - top - 24)}px`
      if (el.style.height !== height) el.style.height = height
    }
    fit()
    const around = new ResizeObserver(fit)
    if (el.parentElement) around.observe(el.parentElement)
    window.addEventListener('resize', fit)
    wide.addEventListener('change', fit)
    return () => {
      around.disconnect()
      window.removeEventListener('resize', fit)
      wide.removeEventListener('change', fit)
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

function readStage(key: string) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStage(key: string, stage: string) {
  try {
    sessionStorage.setItem(key, stage)
  } catch {
    // storage unavailable (private mode, blocked): the board just starts at the first stage
  }
}

/**
 * The stage a phone was showing, for this tab: restored when the board comes back, however it is
 * reached (a ticket's Back, the menu, a link), and across a reload. `stages` once the project's
 * columns are known, since a stage that no longer exists must not hide every column.
 */
function useRememberedStage(key: string, stages: StageLike[]): [string | undefined, (stage: string) => void] {
  const [stage, setStage] = useState<string>()
  const restoredFor = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    // Once per board: the saved stage of this project, or none (the first with tickets) when it has
    // no say, is gone, or another project's board took this one's place.
    if (!stages.length || restoredFor.current === key) return
    restoredFor.current = key
    const saved = readStage(key)
    setStage(saved && stages.some((s) => s.key === saved) ? saved : undefined)
  }, [key, stages])
  const pick = (next: string) => {
    setStage(next)
    writeStage(key, next)
  }
  return [stage, pick]
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
      pending = requestAnimationFrame(() => {
        const before = readScroll(key)
        // A value the element coerces to 0 because it cannot scroll there is not where the reader
        // was (a phone shows one column, with nothing sideways and nothing scrolling in it): keep
        // what was saved, so a visit at phone width does not lose the desktop's position.
        const sideways = el.scrollWidth > el.clientWidth
        writeScroll(key, {
          left: sideways ? el.scrollLeft : (before?.left ?? 0),
          columns: Object.fromEntries(
            columns().map((c) => {
              const name = c.dataset.column!
              const down = c.scrollHeight > c.clientHeight
              return [name, down ? c.scrollTop : (before?.columns?.[name] ?? 0)]
            }),
          ),
        })
      })
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
export function TicketList({ projectId, items }: { projectId: string; items: TicketRow[] }) {
  useRememberedPageScroll(`features.list.${projectId}`)
  const { data: project } = useProject(projectId)
  const stages = project?.stages ?? []
  const tick = useNow(60_000)
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
        const work = timelineFromActivity(t.activity, t.stalled, hasWork(stage.kind))
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
                  {t.blockedNext && <BlockedTasksBadge n={t.blockedTasks} className="ml-2 align-[1px]" />}
                  <StallNotice
                    timeline={work}
                    stage={stallStage(stages, t.status)}
                    focusable={false}
                    className="ml-2 align-[1px]"
                  />
                  <NeedsBadge needs={t.needs} className="ml-2 align-[1px]" />
                  {t.tags.length > 0 && (
                    <span className="ml-2 inline-flex flex-wrap gap-1 align-[1px]">
                      {[...t.tags].sort(compareTags).map((tag) => (
                        <Tag key={tag} tag={tag} />
                      ))}
                    </span>
                  )}
                </div>
                {hasWork(stage.kind) && <NowLine timeline={work} now={tick} className="mt-0.5" />}
                {t.lanes.total > 0 && (
                  <div
                    data-testid="row-meta"
                    className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Layers className="size-3" /> {t.lanes.total} lane{t.lanes.total === 1 ? '' : 's'}
                    </span>
                  </div>
                )}
                <SearchHit ticket={t} />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums text-muted-foreground">
                {t.rollup.total > 0 && (
                  <span>
                    {t.rollup.done}/{t.rollup.total}
                  </span>
                )}
                <span data-testid="row-time">{ago(t.updatedAt)}</span>
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
