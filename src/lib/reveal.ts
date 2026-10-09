import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'

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

/**
 * Brings the anchor's target into view once it is drawn, once per anchor on a page: the page's
 * refetches and re-renders leave the reader where they are. Pass null until the page shows the data
 * the anchor belongs to (not the previous page's, kept while the next one loads), and `page` for what
 * it shows when one route shows several things (a ticket): the same anchor on the next one is another.
 */
export function useReveal(anchor: Anchor | null, page?: string | number) {
  const client = useQueryClient()
  const target = anchor?.target ?? null
  const holder = anchor?.holder ?? null
  useEffect(() => {
    if (!target) return
    // A new arrival: whatever the last one still holds in place is the reader's again.
    unpin()
    const stop = revealWhenDrawn(target, client, holder)
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
 * Waits for the element `id` to be drawn, then reveals it. Data comes in asynchronously (a thread's
 * replies in a second request, after the thread opens), so it watches the page and the queries: once
 * nothing is loading and the page has stopped changing without it, it gives up quietly, revealing
 * `fallback` instead if that is there. Returns a function that stops waiting.
 */
function revealWhenDrawn(id: string, client: QueryClient, fallback: string | null) {
  let quiet: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    const el = drawn(id)
    if (el) {
      stop()
      return reveal(el)
    }
    clearTimeout(quiet)
    if (client.isFetching()) return
    quiet = setTimeout(() => {
      if (client.isFetching() || drawn(id)) return check()
      stop()
      const instead = fallback && drawn(fallback)
      if (instead) reveal(instead)
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
