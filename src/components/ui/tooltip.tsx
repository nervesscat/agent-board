import * as React from 'react'
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from 'cn'

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

/**
 * A tooltip that closes as soon as anything scrolls while it is open (a board column, a list, the
 * page), the way a native title does: its trigger has moved from under it, and the bubble would float
 * where the trigger was. The next hover or focus opens it again. `onScrollClose` tells the caller that
 * it was a scroll that closed it, for a tooltip that must come back while the pointer rests.
 */
function Tooltip({
  actionsRef,
  onOpenChange,
  onScrollClose,
  ...props
}: TooltipPrimitive.Root.Props & { onScrollClose?: () => void }) {
  const ownActions = React.useRef<TooltipPrimitive.Root.Actions | null>(null)
  const actions = actionsRef ?? ownActions
  const [opened, setOpen] = React.useState(false)
  // Held open from outside, it opens without a change event: that counts too.
  const open = props.open ?? opened
  const scrollClose = React.useRef(onScrollClose)
  scrollClose.current = onScrollClose
  React.useEffect(() => {
    if (!open) return
    const close = () => {
      actions.current?.close()
      scrollClose.current?.()
    }
    // From the next frame on: focus scrolls its element into view, and that scroll, which comes as the
    // tooltip opens, is not one to close it for. In the capture phase, a scroll of any element reaches
    // the window, not only the page's own.
    const frame = requestAnimationFrame(() =>
      window.addEventListener('scroll', close, { capture: true, passive: true }),
    )
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', close, { capture: true })
    }
  }, [open, actions])
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      actionsRef={actions}
      onOpenChange={(next, details) => {
        setOpen(next)
        onOpenChange?.(next, details)
      }}
      {...props}
    />
  )
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  arrow = true,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & {
    /** The little pointer toward the anchor: off where the anchor is the mouse pointer itself. */
    arrow?: boolean
  }) {
  return (
    <TooltipPrimitive.Portal>
      {/* Fixed, so an open tooltip near an edge never makes the page longer or scroll it. */}
      <TooltipPrimitive.Positioner
        positionMethod="fixed"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        >
          {children}
          {arrow && (
            <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
          )}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/** Where a bubble sits against the pointer: below it and to its right, clear of the text under it. */
const POINTER_PLACEMENT = {
  side: 'bottom',
  align: 'start',
  sideOffset: 14,
  alignOffset: 10,
  arrow: false,
} as const

/**
 * The app's tooltip on one element, where a `title` would go: it shows `content` on hover and on
 * keyboard focus. The element stays what it is (a span stays a span, a link a link, a button is not
 * wrapped in another): it becomes the trigger through `render`, so it must take a ref and spread the
 * props it is given. With no `content` the tooltip is off and nothing shows. Like a native title it
 * closes as the pointer leaves the element, and never catches the pointer itself. Line breaks in the
 * text are kept, and a long path or URL wraps inside the bubble. `open` and `onOpenChange` hold it open
 * from outside, for a surface that opens it on a tap.
 */
function Tip({
  content,
  children,
  open,
  onOpenChange,
  keepOnClick = false,
  followPointer = false,
}: {
  content: React.ReactNode
  children: React.ReactElement
  /** Held by the caller when it opens the tip itself (a touch tap); uncontrolled otherwise. */
  open?: boolean
  onOpenChange?: (open: boolean, details: { reason: string }) => void
  /** A click (the one a tap sends) leaves the tip open: the caller opened it, so the click does not dismiss it. */
  keepOnClick?: boolean
  /**
   * For an element big enough that its edge is far from where the pointer is (a card of text): the
   * bubble opens at the pointer, a little below and to the right of it, and follows it over the
   * element, like a native title, instead of sitting on the element's edge. It flips and shifts to
   * stay in the window. Keyboard focus has no pointer, so it still opens at the element.
   */
  followPointer?: boolean
}) {
  // Opened from the keyboard there is no pointer to follow: it sits at the element, as every tip does.
  const [byKeyboard, setByKeyboard] = React.useState(false)
  const atPointer = followPointer && !byKeyboard
  const off = content === undefined || content === null || content === false || content === ''
  // The trigger takes the element's own id if it has one: base-ui tells its triggers apart by it.
  const { id } = children.props as { id?: string }
  const tipId = React.useId()
  // A pointer-following tip is held open from here, so it can open again by itself after a scroll.
  const [shown, setShown] = React.useState(false)
  const [scrolledAway, setScrolledAway] = React.useState(false)
  const held = open ?? (followPointer ? shown : undefined)
  useReopenAfterScroll(followPointer, scrolledAway, tipId, () => {
    setScrolledAway(false)
    setShown(true)
  })
  return (
    <Tooltip
      disabled={off}
      disableHoverablePopup
      open={held}
      onOpenChange={(next, details) => {
        if (next) setByKeyboard(details.reason === 'trigger-focus')
        setShown(next)
        if (next) setScrolledAway(false)
        onOpenChange?.(next, details)
      }}
      onScrollClose={() => {
        if (atPointer) setScrolledAway(true)
      }}
      trackCursorAxis={atPointer ? 'both' : 'none'}
    >
      <TooltipTrigger
        id={id}
        data-tip={off ? undefined : ''}
        data-tip-id={tipId}
        closeOnClick={!keepOnClick}
        render={children}
      />
      {!off && (
        <TooltipContent className="whitespace-pre-line wrap-anywhere" {...(atPointer && POINTER_PLACEMENT)}>
          {content}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

/** How long after the last scroll it counts as stopped. */
const SCROLL_STOPPED_MS = 120

/**
 * A scroll closed a pointer-following tip, and the pointer has not left the element: the browser sends
 * no new enter, so nothing would open it until the pointer left and came back. While `waiting`, it
 * opens again (`reopen`) on the next pointer move over the element, or once the scrolling has stopped,
 * whichever comes first, at the pointer's place then; and not at all when the scroll took the element
 * from under the pointer, so no tip is left floating.
 */
function useReopenAfterScroll(enabled: boolean, waiting: boolean, tipId: string, reopen: () => void) {
  const reopenRef = React.useRef(reopen)
  reopenRef.current = reopen
  // Where the mouse pointer was last seen: the scroll that closes the tip comes with no pointer event.
  const pointer = React.useRef<{ x: number; y: number } | null>(null)
  const track = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') pointer.current = { x: e.clientX, y: e.clientY }
  }
  React.useEffect(() => {
    if (!enabled) return
    window.addEventListener('pointermove', track, { capture: true, passive: true })
    return () => window.removeEventListener('pointermove', track, { capture: true })
  }, [enabled])
  React.useEffect(() => {
    if (!waiting) return
    let lastScroll = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      const at = pointer.current
      const el = at && document.elementFromPoint(at.x, at.y)
      const trigger = el?.closest(`[data-tip-id="${tipId}"]`)
      if (!at || !trigger) return
      reopenRef.current()
      // base-ui places the bubble from the last mouse move it saw, and the scroll has moved the element
      // since: tell it where the pointer is now, once the bubble has mounted and is listening.
      const nudge = () =>
        trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: at.x, clientY: at.y }))
      requestAnimationFrame(() => requestAnimationFrame(nudge))
    }
    const onScroll = () => {
      lastScroll = performance.now()
      clearTimeout(timer)
      timer = setTimeout(settle, SCROLL_STOPPED_MS)
    }
    // Mid-scroll the next scroll would close it again: the end of the scroll opens it.
    const onMove = () => {
      if (performance.now() - lastScroll >= SCROLL_STOPPED_MS) settle()
    }
    const options = { capture: true, passive: true } as const
    window.addEventListener('scroll', onScroll, options)
    window.addEventListener('pointermove', onMove, options)
    // The scroll that closed it may be the last one: settle after it if no other comes.
    timer = setTimeout(settle, SCROLL_STOPPED_MS)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('scroll', onScroll, options)
      window.removeEventListener('pointermove', onMove, options)
    }
  }, [waiting, tipId])
}

// What the browser would stop at on Tab, before the checks on each element below.
const TABBABLE =
  'a[href], button, input, select, textarea, summary, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]'

type InitialFocus = DialogPrimitive.Popup.Props['initialFocus']
type OpenType = Parameters<Extract<InitialFocus, (...args: never[]) => unknown>>[0]

/**
 * Keeps a dialog or popover from opening onto a `Tip`. base-ui focuses the popup's first tabbable
 * control as it opens; opened from the keyboard that focus is focus-visible, so the control's tooltip
 * would open with it, unasked, and the first Escape would close only that tooltip, not the popup.
 * When that control is a `Tip`, focus goes to the popup itself, as base-ui does on touch: not to a
 * control further down, which could scroll the popup away from its top or raise a phone's keyboard.
 * Tab from there reaches the first control. Returns the `ref` and `initialFocus` to give the popup;
 * an `initialFocus` of the caller's wins.
 */
function useFocusPastTips<T extends HTMLElement>(ref: React.Ref<T> | undefined, initialFocus?: InitialFocus) {
  const popup = React.useRef<T | null>(null)
  const setRef = React.useCallback(
    (el: T | null) => {
      popup.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    },
    [ref],
  )
  const pastTips = React.useCallback((openType: OpenType) => {
    const el = popup.current
    // base-ui's own choice on touch, kept: the popup itself (and nothing is focus-visible on touch).
    if (openType === 'touch') return el
    if (!el) return true
    const tabbable = [...el.querySelectorAll<HTMLElement>(TABBABLE)].filter(
      (c) =>
        Number(c.getAttribute('tabindex') ?? 0) >= 0 &&
        !c.matches(':disabled') &&
        !c.closest('[inert]') &&
        c.checkVisibility({ visibilityProperty: true }),
    )
    const isTip = (c: HTMLElement) => c.closest('[data-tip]') !== null
    if (!tabbable[0] || !isTip(tabbable[0])) return true
    return el
  }, [])
  return { ref: setRef, initialFocus: initialFocus ?? pastTips }
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Tip, useFocusPastTips }
