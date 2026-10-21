import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import {
  type AnyRouter,
  type RouterHistory,
  useElementScrollRestoration,
  useLocation,
} from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'

/**
 * Links that land on one thing in a page: the URL's #anchor names an element by its id, and once the
 * page's data has drawn it, the page scrolls it into view (below a stuck header, by its scroll margin)
 * and marks it for a moment with `data-revealed` (styled in styles.css).
 *
 * An anchor is an element's id (`post-12`, `pr-3`, `handoff`, `resume`, `reply-40`), or for a reply in
 * a thread that loads only once opened, the element that holds the thread and the reply's id:
 * `post-12-reply-40` is `reply-40` in the thread of `post-12`. So the URL alone says which thread to
 * open, and where to land if the reply is gone.
 */
export interface Anchor {
  hash: string
  /** The id of the element to bring into view. */
  target: string
  /** The id of the element whose thread holds the target, when it is a reply. */
  holder: string | null
}

export function parseAnchor(hash: string): Anchor | null {
  if (!hash) return null
  const reply = /^([a-z]+-\d+)-(reply-\d+)$/.exec(hash)
  return reply ? { hash, target: reply[2]!, holder: reply[1]! } : { hash, target: hash, holder: null }
}

/** The anchor of the page's URL, following it through links, back and forward, and #links on the page. */
export function useAnchor(): Anchor | null {
  const hash = useLocation({ select: (l) => l.hash })
  return useMemo(() => parseAnchor(hash), [hash])
}

/** The number in an anchor id like `post-12`, when it is of that kind. */
export function anchorId(id: string | null | undefined, kind: string): number | null {
  const m = id ? new RegExp(`^${kind}-(\\d+)$`).exec(id) : null
  return m ? Number(m[1]) : null
}

/** How the history last moved: by a link (PUSH, REPLACE) or back through it (BACK, FORWARD, GO). */
let moved: string | undefined

const returned = (action: string | undefined) => action === 'BACK' || action === 'FORWARD' || action === 'GO'

/**
 * Whether the history last moved back to an entry (Back, Forward) rather than by a link: read while
 * rendering the entry it moved to.
 */
export const cameBack = () => returned(moved)

/** What followHistory reads of the router. */
type Followed = Pick<AnyRouter, 'latestLocation' | 'stores'> & { history: RouterHistory }

/**
 * Follows the router's history, from its start, for useReveal to tell a return from an arrival. It
 * hears of each move before the router does (the router subscribes once it is mounted), while the
 * window is still where the reader left the entry they are leaving.
 *
 * The router keeps that place for the entry only if it has seen the window scroll since its last
 * render, and the browser tells of a scroll on its next frame: a scroll right before Back, Forward or
 * a link would go unseen, and coming back to that entry the router would land on its anchor instead.
 * So the router is told now that the window scrolled, and it keeps where the window is.
 *
 * Only when the reader is leaving an entry they can come back to, and the one the router keeps the
 * place for: not on a replace (the entry it leaves is gone from the history), and not while the last
 * move is still loading (a page putting a remembered filter in its URL as it first shows). The router
 * keeps the place for the entry it last finished loading, which is then the page the reader left: it
 * would keep the window of the page now shown for it, and Back to it would land there.
 */
export function followHistory(router: Followed) {
  if (typeof window === 'undefined') return
  router.history.subscribe(({ action }) => {
    moved = action.type
    if (action.type !== 'REPLACE' && settled(router)) document.dispatchEvent(new Event('scroll'))
    // Back where the reader was, nothing is marked: not even what the step left marked.
    if (returned(moved)) unmark()
  })
}

/**
 * Whether the router has finished loading the entry the history is leaving. It has not heard of the
 * move yet, so its latest location is still that entry.
 */
function settled(router: Followed) {
  const leaving = router.latestLocation
  const loaded = router.stores.resolvedLocation.get()
  return loaded?.href === leaving.href && loaded.state.__TSR_key === leaving.state.__TSR_key
}

/**
 * Whether the reader came back to this entry of the history (Back, Forward) rather than arrived (a
 * link followed, a URL opened afresh, a reload), and where they left it, if the router kept that for
 * the window.
 */
function useReturn() {
  const left = useElementScrollRestoration({ getElement: () => window })
  return returned(moved) ? { left } : null
}

/**
 * Brings the anchor's target into view once it is drawn, once per anchor on a page: the page's
 * refetches and re-renders leave the reader where they are. `ready` false until the page shows what
 * the anchor belongs to (not the previous ticket, kept while the next one loads; not a list about to
 * be filtered again), and `page` for what it shows when one route shows several things (a ticket):
 * the same anchor on the next one is another.
 *
 * Back or Forward, nothing is marked or scrolled to: the page goes back to where the reader left it,
 * once the target is drawn (the router's own restoring comes before a page that loads its data has
 * the height for it), or is left to the router when it kept no place for the window (a box of its
 * own, such as a dialog, it restores itself).
 */
export function useReveal(
  anchor: Anchor | null,
  { page, ready = true }: { page?: string | number; ready?: boolean } = {},
) {
  const client = useQueryClient()
  // How the reader got to this anchor, as it first shows: before the page is ready, the URL may be
  // replaced on the way (a remembered filter put in it), which is still the same arrival.
  const arrival = `${page ?? ''}#${anchor?.hash ?? ''}`
  const now = useReturn()
  const came = useRef<{ arrival: string; back: typeof now } | null>(null)
  useEffect(() => {
    if (came.current?.arrival !== arrival) came.current = { arrival, back: now }
  })
  const target = ready ? (anchor?.target ?? null) : null
  const holder = anchor?.holder ?? null
  useEffect(() => {
    if (!target) return
    // A new arrival: whatever the last one still holds in place is the reader's again.
    unpin()
    const back = came.current?.back
    if (back) unmark()
    const at = back?.left
    const stop = !back
      ? revealWhenDrawn(target, client, holder, (el) => el && reveal(el))
      : at
        ? revealWhenDrawn(target, client, null, () => window.scrollTo(at.scrollX, at.scrollY))
        : () => {}
    return () => {
      stop()
      unpin()
    }
  }, [client, target, holder, page])
}

/** How long nothing loads or changes before an anchor that is not drawn is given up on. */
const SETTLE_MS = 500
/** The longest an anchor is waited for. */
const WAIT_MS = 20_000
/** How long the mark stays on (its fade is in styles.css). */
export const MARK_MS = 3_000
/**
 * The reader turning the wheel, touching or typing: from then on the page is theirs, and a late target
 * is not scrolled to. A scrollbar dragged fires nothing but scroll: see readerScrolls.
 */
const READER = ['wheel', 'touchmove', 'keydown'] as const

/**
 * Calls `then` when the page or a box in it scrolls while nothing here has scrolled it: the reader,
 * by whatever means. Not the page pulled up to its new bottom as it gets shorter (the previous page
 * gone, this one still loading), nor a box scrolling only sideways (a row of tabs following its
 * selection). Returns a function that stops listening.
 */
function readerScrolls(then: () => void) {
  let y = window.scrollY
  const tops = new WeakMap<Element, number>()
  const onScroll = (e: Event) => {
    const box = e.target
    if (box === document || box === document.scrollingElement) {
      const now = window.scrollY
      const bottom = document.documentElement.scrollHeight - window.innerHeight
      if (Math.abs(now - y) <= 1 || (now < y && now >= bottom - 1)) y = now
      else then()
    } else if (box instanceof Element) {
      // A box drawn while waiting starts at its top.
      if (Math.abs(box.scrollTop - (tops.get(box) ?? 0)) > 1) then()
      else tops.set(box, box.scrollTop)
    }
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => document.removeEventListener('scroll', onScroll, { capture: true })
}

/** What scrolls to bring the element into view: its scrolling ancestors and the page itself. */
function scrollers(el: HTMLElement) {
  const boxes: Element[] = []
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement)
    if (/auto|scroll|overlay/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)
      boxes.push(p)
  boxes.push(document.scrollingElement ?? document.documentElement)
  return boxes
}

/** The element, when it is there and shown (not in a hidden tab). */
function drawn(id: string) {
  const el = document.getElementById(id)
  return el && el.getClientRects().length > 0 ? el : null
}

/**
 * Waits for the element `id` to be drawn, then lands on it. Data comes in asynchronously (a thread's
 * replies in a second request, after the thread opens), so it watches the page and the queries: once
 * nothing is loading and the page has stopped changing without it, it gives up quietly, landing on
 * `fallback` instead if that is there (or on nothing). Returns a function that stops waiting.
 */
function revealWhenDrawn(
  id: string,
  client: QueryClient,
  fallback: string | null,
  land: (el: HTMLElement | null) => void,
) {
  let quiet: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    const el = drawn(id)
    if (el) {
      stop()
      return land(el)
    }
    clearTimeout(quiet)
    if (client.isFetching()) return
    quiet = setTimeout(() => {
      if (client.isFetching() || drawn(id)) return check()
      stop()
      land(fallback ? drawn(fallback) : null)
    }, SETTLE_MS)
  }
  const observer = new MutationObserver(check)
  const unsubscribe = client.getQueryCache().subscribe(check)
  const timeout = setTimeout(() => stop(), WAIT_MS)
  const unlisten = readerScrolls(() => stop())
  function stop() {
    observer.disconnect()
    unsubscribe()
    unlisten()
    clearTimeout(quiet)
    clearTimeout(timeout)
    for (const e of READER) window.removeEventListener(e, stop)
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  for (const e of READER) window.addEventListener(e, stop, { passive: true })
  check()
  return stop
}

let marked: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null
let unpin = () => {}

/** Takes the mark off whatever has it. */
function unmark() {
  if (!marked) return
  clearTimeout(marked.timer)
  marked.el.removeAttribute('data-revealed')
  marked = null
}

/** Scrolls to the element and marks it for a moment; only one element is marked at a time. */
function reveal(el: HTMLElement) {
  el.scrollIntoView({ block: 'start' })
  if (marked) {
    clearTimeout(marked.timer)
    marked.el.removeAttribute('data-revealed')
    // Marked again a moment after: start the fade over.
    void el.offsetWidth
  }
  el.setAttribute('data-revealed', '')
  marked = { el, timer: setTimeout(() => el.removeAttribute('data-revealed'), MARK_MS) }
  pin(el)
}

/** How long a revealed element is kept in place while what is above it settles. */
const PIN_MS = 2_000

/**
 * Keeps the element where it was scrolled to while the page settles (a font coming in reflows every
 * post above it), until the reader scrolls or types, for a moment at most.
 */
function pin(el: HTMLElement) {
  unpin()
  const until = performance.now() + PIN_MS
  const boxes = scrollers(el)
  let at = boxes.map((b) => b.scrollTop)
  let top = el.getBoundingClientRect().top
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const e of READER) window.removeEventListener(e, stop)
  }
  const step = () => {
    // The page, or a box it is in, scrolled by someone else (a scrollbar dragged): it is theirs.
    const moved = boxes.some((b, i) => Math.abs(b.scrollTop - at[i]!) > 1)
    if (!el.isConnected || performance.now() > until || moved) return stop()
    if (Math.abs(el.getBoundingClientRect().top - top) > 1) {
      el.scrollIntoView({ block: 'start' })
      at = boxes.map((b) => b.scrollTop)
      top = el.getBoundingClientRect().top
    }
    frame = requestAnimationFrame(step)
  }
  for (const e of READER) window.addEventListener(e, stop, { passive: true })
  frame = requestAnimationFrame(step)
  unpin = stop
}
