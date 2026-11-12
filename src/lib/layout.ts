/**
 * A project's layout: which of its elements show and where, as the human arranges them on the
 * project's settings page. The elements are the pages of the project's menu, the cards of its
 * Overview and the sections of a ticket's page. A project keeps no layout of its own until one is
 * saved (null: the defaults); what is handed out is always the effective one (`mergeLayout`).
 */

/**
 * Where an element can go. The menu and the Overview are one ordered list each; a ticket's page has
 * a main column and a side column (one above the other on a phone).
 */
export const LAYOUT_AREAS = ['nav', 'overview', 'ticket.main', 'ticket.side'] as const
export type LayoutArea = (typeof LAYOUT_AREAS)[number]

const TICKET_AREAS: readonly LayoutArea[] = ['ticket.main', 'ticket.side']

/**
 * Every element, in its default area and default order. `locked` is why it is never hidden (it can
 * still be moved). An element added here later reaches every project, saved layout or not.
 */
export const LAYOUT_ELEMENTS = [
  // The project's menu.
  { id: 'nav.overview', label: 'Overview', area: 'nav', locked: "The project's landing page" },
  { id: 'nav.prs', label: 'PR queue', area: 'nav' },
  { id: 'nav.features', label: 'Ongoing features', area: 'nav', locked: "The project's board" },
  { id: 'nav.roadmap', label: 'Roadmap', area: 'nav' },
  { id: 'nav.previews', label: 'Previews', area: 'nav' },
  { id: 'nav.gallery', label: 'Gallery', area: 'nav' },
  { id: 'nav.agents', label: 'Team', area: 'nav' },
  { id: 'nav.runReports', label: 'Run reports', area: 'nav' },
  { id: 'nav.daily', label: 'Daily', area: 'nav' },
  { id: 'nav.cleanup', label: 'Cleanup', area: 'nav' },
  { id: 'nav.repositories', label: 'Repositories', area: 'nav' },
  { id: 'nav.instructions', label: 'Instructions', area: 'nav' },
  {
    id: 'nav.settings',
    label: 'Settings',
    area: 'nav',
    locked: 'The settings page, where this layout is changed',
  },
  // The Overview's cards (and each project's block on Home).
  { id: 'overview.needsYou', label: 'Needs you', area: 'overview' },
  { id: 'overview.inProgress', label: 'In progress', area: 'overview' },
  { id: 'overview.doneToday', label: 'Done today', area: 'overview' },
  { id: 'overview.next', label: 'Next', area: 'overview' },
  { id: 'overview.carryingOver', label: 'Carrying over', area: 'overview' },
  // A ticket's page.
  { id: 'ticket.instructions', label: 'Instructions', area: 'ticket.main', locked: "The ticket's own text" },
  { id: 'ticket.tasks', label: 'Tasks', area: 'ticket.main', locked: 'Where blocked-task links land' },
  { id: 'ticket.timeline', label: 'Timeline', area: 'ticket.main' },
  { id: 'ticket.lanes', label: 'Lanes', area: 'ticket.main' },
  {
    id: 'ticket.activity',
    label: 'Activity',
    area: 'ticket.main',
    locked: 'Decisions and threads that wait on you are here',
  },
  { id: 'ticket.runs', label: 'Runs', area: 'ticket.side' },
  { id: 'ticket.details', label: 'Details', area: 'ticket.side' },
  { id: 'ticket.branch', label: 'Branch', area: 'ticket.side' },
  { id: 'ticket.workspaces', label: 'Workspaces', area: 'ticket.side' },
] as const satisfies readonly { id: string; label: string; area: LayoutArea; locked?: string }[]

export type LayoutId = (typeof LAYOUT_ELEMENTS)[number]['id']
export type LayoutElement = {
  id: LayoutId
  label: string
  /** Its default area. */
  area: LayoutArea
  /** Why it cannot be hidden; absent when it can. */
  locked?: string
}

const ELEMENTS = new Map<string, LayoutElement>(LAYOUT_ELEMENTS.map((e) => [e.id, e]))

export const layoutElement = (id: LayoutId): LayoutElement => ELEMENTS.get(id)!

/** The areas an element may be put in: a ticket's section goes in either column, the rest stay put. */
export const allowedAreas = (id: LayoutId): readonly LayoutArea[] => {
  const area = layoutElement(id).area
  return TICKET_AREAS.includes(area) ? TICKET_AREAS : [area]
}

/** One element in a layout: where it is and whether it shows. A layout lists them in order. */
export type LayoutItem = { id: LayoutId; area: LayoutArea; hidden: boolean }
export type Layout = LayoutItem[]

/** Every element in its default area and order, shown. */
export const defaultLayout = (): Layout =>
  LAYOUT_ELEMENTS.map((e) => ({ id: e.id, area: e.area, hidden: false }))

/** A layout as it may be saved: ids and areas the catalogue may no longer know. */
export type SavedLayout = readonly { id: string; area: string; hidden?: boolean }[]

/**
 * The layout in effect for what a project saved (null: the defaults), in area order and, within an
 * area, in order. Saved order and visibility are kept for every element still in the catalogue. An
 * id it no longer has is dropped, and a repeated one keeps its first place. An element put in an area
 * it may not go in returns to its default one. A locked element always shows. An element the saved
 * layout lacks (one added later) shows, in its default area, after the nearest element before it in
 * the default order that is in that area, or first in the area when there is none.
 */
export function mergeLayout(saved: SavedLayout | null | undefined): Layout {
  const areas = new Map<LayoutArea, LayoutItem[]>(LAYOUT_AREAS.map((a) => [a, []]))
  const placed = new Map<LayoutId, LayoutArea>()
  for (const s of saved ?? []) {
    const el = ELEMENTS.get(s.id)
    if (!el || placed.has(el.id)) continue
    const area = allowedAreas(el.id).find((a) => a === s.area) ?? el.area
    areas.get(area)!.push({ id: el.id, area, hidden: !el.locked && s.hidden === true })
    placed.set(el.id, area)
  }
  LAYOUT_ELEMENTS.forEach((el, i) => {
    if (placed.has(el.id)) return
    const list = areas.get(el.area)!
    // The nearest earlier element in the catalogue that is in this area, now placed in the list.
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const before = LAYOUT_ELEMENTS[j]!.id
      if (placed.get(before) !== el.area) continue
      at = list.findIndex((it) => it.id === before) + 1
      break
    }
    list.splice(at, 0, { id: el.id, area: el.area, hidden: false })
    placed.set(el.id, el.area)
  })
  return LAYOUT_AREAS.flatMap((a) => areas.get(a)!)
}

/** The elements in an area, in order, hidden ones too. */
export const inArea = (layout: Layout, area: LayoutArea) => layout.filter((it) => it.area === area)

/** The ids of the elements that show in an area, in order. */
export const shownIn = <A extends LayoutArea>(layout: Layout, area: A) =>
  layout.filter((it) => it.area === area && !it.hidden).map((it) => it.id) as AreaId<A>[]

/** The ids an area takes by default (a ticket's sections: those of both columns). */
export type AreaId<A extends LayoutArea> = A extends 'ticket.main' | 'ticket.side'
  ? Extract<(typeof LAYOUT_ELEMENTS)[number], { area: 'ticket.main' | 'ticket.side' }>['id']
  : Extract<(typeof LAYOUT_ELEMENTS)[number], { area: A }>['id']

/** Whether two layouts are the same arrangement. */
export const sameLayout = (a: Layout, b: Layout) =>
  a.length === b.length &&
  a.every((it, i) => it.id === b[i]!.id && it.area === b[i]!.area && it.hidden === b[i]!.hidden)

/**
 * The layout with an element moved to `index` of `area` (counted among that area's elements as they
 * are before the move, the moved one included, as a drop point is). The order of the other areas is
 * untouched. Unchanged when the element may not go there.
 */
export function moveInLayout(layout: Layout, id: LayoutId, area: LayoutArea, index: number): Layout {
  if (!allowedAreas(id).includes(area)) return layout
  const from = layout.find((it) => it.id === id)
  if (!from) return layout
  const target = inArea(layout, area)
  const old = target.findIndex((it) => it.id === id)
  const rest = target.filter((it) => it.id !== id)
  const at = Math.max(0, Math.min(rest.length, old !== -1 && old < index ? index - 1 : index))
  rest.splice(at, 0, { ...from, area })
  return LAYOUT_AREAS.flatMap((a) => (a === area ? rest : inArea(layout, a).filter((it) => it.id !== id)))
}
