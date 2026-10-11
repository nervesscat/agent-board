import * as React from 'react'
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from 'cn'

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
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
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
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
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * The app's tooltip on one element, where a `title` would go: it shows `content` on hover and on
 * keyboard focus. The element stays what it is (a span stays a span, a link a link, a button is not
 * wrapped in another): it becomes the trigger through `render`, so it must take a ref and spread the
 * props it is given. With no `content` the tooltip is off and nothing shows. Like a native title it
 * closes as the pointer leaves the element, and never catches the pointer itself. Line breaks in the
 * text are kept, and a long path or URL wraps inside the bubble.
 */
function Tip({ content, children }: { content: React.ReactNode; children: React.ReactElement }) {
  const off = content === undefined || content === null || content === false || content === ''
  // The trigger takes the element's own id if it has one: base-ui tells its triggers apart by it.
  const { id } = children.props as { id?: string }
  return (
    <Tooltip disabled={off} disableHoverablePopup>
      <TooltipTrigger id={id} data-tip={off ? undefined : ''} render={children} />
      {!off && <TooltipContent className="whitespace-pre-line wrap-anywhere">{content}</TooltipContent>}
    </Tooltip>
  )
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
 * When that control is a `Tip`, focus goes to the first one that is not, or to the popup itself.
 * Returns the `ref` and `initialFocus` to give the popup; an `initialFocus` of the caller's wins.
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
    return tabbable.find((c) => !isTip(c)) ?? el
  }, [])
  return { ref: setRef, initialFocus: initialFocus ?? pastTips }
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Tip, useFocusPastTips }
