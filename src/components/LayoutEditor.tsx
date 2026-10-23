import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronUp,
  EyeOff,
  GripVertical,
  LayoutDashboard,
  Lock,
  PanelLeft,
  RotateCcw,
  SquareKanban,
} from 'lucide-react'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { LAYOUT_ICONS } from '#/components/layoutIcons'
import { Button } from '#/components/ui/button'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, patch } from '#/lib/api'
import {
  type Layout,
  type LayoutArea,
  type LayoutId,
  type LayoutItem,
  allowedAreas,
  inArea,
  layoutElement,
  moveInLayout,
  sameLayout,
} from '#/lib/layout'
import { cn } from '#/lib/utils'

/** How each area reads in the editor: its list's name, and the words that place an element in it. */
const AREAS: Record<LayoutArea, { name: string; where: string }> = {
  nav: { name: 'Project menu', where: 'in the menu' },
  overview: { name: 'Overview cards', where: 'on the Overview' },
  'ticket.main': { name: 'Ticket page, main column', where: 'on the ticket page' },
  'ticket.side': { name: 'Ticket page, side column', where: 'on the ticket page' },
}

/** A control of a tile, as the focus follows a moved tile to it. */
type Control = 'up' | 'down' | 'column'

/** Where a dragged tile would land: before the `index`th tile of `area` (its length: at the end). */
type DropPoint = { area: LayoutArea; index: number }

/**
 * The project's layout, edited on a small picture of what it arranges: the project's menu, its
 * Overview's cards and a ticket page's two columns. Each element is a tile: its switch shows or hides
 * it, dragging it (or its arrows) moves it, and a ticket section goes to the other column by drag or
 * by its column button. Locked elements move but always show. Nothing applies until Save; Reset to
 * default saves the defaults at once, as the other sections of this page do.
 */
export function LayoutEditor({ projectId, saved }: { projectId: string; saved: Layout }) {
  const qc = useQueryClient()
  const [items, setItems] = useState(saved)
  const dirty = !sameLayout(items, saved)
  const save = useMutation({
    mutationFn: (layout: Layout | null) =>
      patch<{ layout: Layout }>(`/api/projects/${projectId}`, { layout }),
    onSuccess: async (row) => {
      setItems(row.layout)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['project', projectId] }),
        // The Overview's cards, on the project's Overview and on Home.
        qc.invalidateQueries({ queryKey: ['summary'] }),
      ])
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const root = useRef<HTMLDivElement>(null)
  // After a move, the control to focus on the moved tile: the same one, or the other arrow when the
  // tile reached the end that turns this one off.
  const [focusAfterMove, setFocusAfterMove] = useState<{ id: LayoutId; control: Control } | null>(null)
  useEffect(() => {
    if (!focusAfterMove) return
    const { id, control } = focusAfterMove
    const find = (c: Control) =>
      root.current?.querySelector<HTMLButtonElement>(`[data-control="${c}:${id}"]`) ?? null
    let el = find(control)
    if (!el || el.disabled) el = find(control === 'up' ? 'down' : control === 'down' ? 'up' : control)
    el?.focus()
    setFocusAfterMove(null)
  }, [focusAfterMove])

  const [dragging, setDragging] = useState<LayoutId | null>(null)
  const [drop, setDrop] = useState<DropPoint | null>(null)

  const move = (id: LayoutId, area: LayoutArea, index: number, control?: Control) => {
    setItems((now) => moveInLayout(now, id, area, index))
    if (control) setFocusAfterMove({ id, control })
  }
  const setHidden = (id: LayoutId, hidden: boolean) =>
    setItems((now) => now.map((it) => (it.id === id ? { ...it, hidden } : it)))

  const area = (a: LayoutArea, grid = false) => (
    <Area
      area={a}
      items={inArea(items, a)}
      grid={grid}
      dragging={dragging}
      drop={drop?.area === a ? drop.index : null}
      onDropPoint={(index) => setDrop(index === null ? null : { area: a, index })}
      onDrop={(id, index) => {
        move(id, a, index)
        setDragging(null)
        setDrop(null)
      }}
      tile={(it, i, n) => (
        <Tile
          key={it.id}
          item={it}
          index={i}
          count={n}
          dragged={dragging === it.id}
          dropBefore={drop?.area === a && drop.index === i}
          dropAfter={drop?.area === a && drop.index === n && i === n - 1}
          grid={grid}
          onHidden={(hidden) => setHidden(it.id, hidden)}
          onMove={(dir) => move(it.id, a, dir === 'up' ? i - 1 : i + 2, dir)}
          onColumn={
            allowedAreas(it.id).length > 1
              ? () => {
                  const other = allowedAreas(it.id).find((x) => x !== a)!
                  move(it.id, other, inArea(items, other).length, 'column')
                }
              : undefined
          }
          onDragStart={() => setDragging(it.id)}
          onDragEnd={() => {
            setDragging(null)
            setDrop(null)
          }}
        />
      )}
    />
  )

  const hidden = items.filter((it) => it.hidden).length
  return (
    <section id="layout" aria-label="Layout" className="max-w-5xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Layout</h2>
        <p className="text-sm text-muted-foreground">
          What shows in this project, and where: the pages of its menu, the cards of its Overview (and of its
          block on Home) and the sections of a ticket&apos;s page. Switch a tile off to hide it, drag it or
          use its arrows to move it, and move a ticket section to the other column. A hidden page still opens
          by its link. <Lock className="inline size-3 align-[-1px]" aria-hidden /> Locked ones move but always
          show.
        </p>
      </div>
      <div ref={root} className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Panel icon={PanelLeft} name="Menu" items={inArea(items, 'nav')}>
          {area('nav')}
        </Panel>
        <div className="min-w-0 space-y-4">
          <Panel icon={LayoutDashboard} name="Overview" items={inArea(items, 'overview')}>
            {area('overview', true)}
          </Panel>
          <Panel
            icon={SquareKanban}
            name="Ticket page"
            items={[...inArea(items, 'ticket.main'), ...inArea(items, 'ticket.side')]}
          >
            {/* The ticket's title and controls stay where they are: a still bar above the columns. */}
            <div
              aria-hidden
              className="mb-2 flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5"
            >
              <span className="h-2 w-28 rounded-full bg-muted-foreground/25" />
              <span className="ml-auto h-2 w-10 rounded-full bg-muted-foreground/15" />
              <span className="h-2 w-14 rounded-full bg-muted-foreground/15" />
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <Column label="Main column">{area('ticket.main')}</Column>
              <Column label="Side column">{area('ticket.side')}</Column>
            </div>
          </Panel>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {dirty ? 'Unsaved changes.' : 'No changes.'}
          {hidden > 0 && ` ${hidden} hidden.`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate(null)}
        >
          <RotateCcw data-icon="inline-start" /> Reset to default
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(items)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  )
}

/** One of the three pictures: a page's frame with its name and how many of its elements show. */
function Panel({
  icon: Icon,
  name,
  items,
  children,
}: {
  icon: typeof PanelLeft
  name: string
  items: LayoutItem[]
  children: ReactNode
}) {
  const shown = items.filter((it) => !it.hidden).length
  return (
    <div className="min-w-0 rounded-xl border bg-muted/30 p-3 shadow-xs">
      <div className="mb-2 flex items-center gap-2 px-0.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        <span className="uppercase tracking-wide">{name}</span>
        <span className="ml-auto font-normal tabular-nums">
          {shown} of {items.length} shown
        </span>
      </div>
      {children}
    </div>
  )
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 px-1 text-[11px] text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

/**
 * An area's tiles, a drop target for the tiles that may go in it. The drop point is worked out from
 * the pointer: in a list, before the first tile whose middle is below it; in the Overview's grid, in
 * reading order (a row above it, or its own row left of it, comes first).
 */
function Area({
  area,
  items,
  grid,
  dragging,
  drop,
  onDropPoint,
  onDrop,
  tile,
}: {
  area: LayoutArea
  items: LayoutItem[]
  grid: boolean
  dragging: LayoutId | null
  drop: number | null
  onDropPoint: (index: number | null) => void
  onDrop: (id: LayoutId, index: number) => void
  tile: (item: LayoutItem, index: number, count: number) => ReactNode
}) {
  const takes = dragging !== null && allowedAreas(dragging).includes(area)
  const pointAt = (e: DragEvent<HTMLElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-tile]')]
    const { clientX: x, clientY: y } = e
    return tiles.filter((t) => {
      const r = t.getBoundingClientRect()
      if (!grid) return y > r.top + r.height / 2
      return y > r.bottom || (y >= r.top && x > r.left + r.width / 2)
    }).length
  }
  return (
    <ul
      aria-label={AREAS[area].name}
      data-area={area}
      onDragOver={(e) => {
        if (!takes) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const index = pointAt(e)
        if (index !== drop) onDropPoint(index)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDropPoint(null)
      }}
      onDrop={(e) => {
        if (!takes || !dragging) return
        e.preventDefault()
        onDrop(dragging, pointAt(e))
      }}
      className={cn(
        'min-h-12 rounded-lg p-1 transition-colors',
        grid ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'space-y-1.5',
        takes && 'bg-primary/5 outline-1 outline-primary/30 outline-dashed',
        drop !== null && 'bg-primary/10 outline-2 outline-primary/50',
        dragging !== null && !takes && 'opacity-60',
      )}
    >
      {items.map((it, i) => tile(it, i, items.length))}
      {!items.length && (
        <li className="flex h-10 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
          {takes ? 'Drop here' : 'Empty: drag sections here'}
        </li>
      )}
    </ul>
  )
}

const iconButton =
  'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30'

/** One element: drag it by itself, move it with its arrows, show or hide it with its switch. */
function Tile({
  item,
  index,
  count,
  dragged,
  dropBefore,
  dropAfter,
  grid,
  onHidden,
  onMove,
  onColumn,
  onDragStart,
  onDragEnd,
}: {
  item: LayoutItem
  index: number
  count: number
  dragged: boolean
  dropBefore: boolean
  dropAfter: boolean
  grid: boolean
  onHidden: (hidden: boolean) => void
  onMove: (dir: 'up' | 'down') => void
  /** Moves a ticket section to the other column; absent for the elements that have one area. */
  onColumn?: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const el = layoutElement(item.id)
  const Icon = LAYOUT_ICONS[item.id]
  const where = AREAS[item.area].where
  const toSide = item.area === 'ticket.main'
  // The drop line sits in the gap beside the tile: above or below it in a list, left or right in the grid.
  const line = (end: boolean) => (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute rounded-full bg-primary',
        grid
          ? cn('inset-y-1 w-0.5', end ? '-right-[5px]' : '-left-[5px]')
          : cn('inset-x-1 h-0.5', end ? '-bottom-[4px]' : '-top-[4px]'),
      )}
    />
  )
  return (
    <li
      data-tile
      data-hidden={item.hidden || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', el.label)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex cursor-grab flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border bg-card px-1.5 py-1.5 text-sm shadow-xs transition-[opacity,background-color] active:cursor-grabbing',
        // The Overview's cards and the ticket's activity are big on the page: a little taller here.
        grid && 'min-h-14',
        item.id === 'overview.carryingOver' && 'sm:col-span-2',
        item.id === 'ticket.activity' && 'min-h-16',
        item.hidden && 'border-dashed bg-transparent shadow-none',
        dragged && 'opacity-40',
      )}
    >
      {dropBefore && line(false)}
      {dropAfter && line(true)}
      <span
        className={cn(
          'flex min-w-[7rem] flex-1 items-center gap-1.5',
          item.hidden && 'text-muted-foreground',
        )}
      >
        <GripVertical aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', item.hidden ? 'opacity-50' : 'text-muted-foreground')}
        />
        <span className={cn('truncate', item.hidden && 'line-through decoration-muted-foreground/60')}>
          {el.label}
        </span>
        {item.hidden && <EyeOff aria-hidden className="size-3 shrink-0" />}
        {el.locked && (
          <Tip content={el.locked}>
            <span className="inline-flex shrink-0">
              <Lock aria-hidden className="size-3 text-muted-foreground/70" />
            </span>
          </Tip>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <Tip content="Move up">
          <button
            type="button"
            data-control={`up:${item.id}`}
            className={iconButton}
            disabled={index === 0}
            onClick={() => onMove('up')}
            aria-label={`Move ${el.label} up ${where}`}
          >
            <ChevronUp className="size-3.5" />
          </button>
        </Tip>
        <Tip content="Move down">
          <button
            type="button"
            data-control={`down:${item.id}`}
            className={iconButton}
            disabled={index === count - 1}
            onClick={() => onMove('down')}
            aria-label={`Move ${el.label} down ${where}`}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </Tip>
        {onColumn && (
          <Tip content={toSide ? 'Move to the side column' : 'Move to the main column'}>
            <button
              type="button"
              data-control={`column:${item.id}`}
              className={iconButton}
              onClick={onColumn}
              aria-label={`Move ${el.label} to the ${toSide ? 'side' : 'main'} column`}
            >
              {toSide ? <ArrowRightToLine className="size-3.5" /> : <ArrowLeftToLine className="size-3.5" />}
            </button>
          </Tip>
        )}
        <Tip content={el.locked ? `Always shown: ${el.locked.toLowerCase()}` : item.hidden ? 'Show' : 'Hide'}>
          {/* A wrapper, so a disabled switch still has its tooltip. */}
          <span className="ml-1 inline-flex">
            <Switch
              size="sm"
              checked={!item.hidden}
              disabled={!!el.locked}
              onCheckedChange={(on) => onHidden(!on)}
              aria-label={`Show ${el.label} ${where}`}
            />
          </span>
        </Tip>
      </span>
    </li>
  )
}
