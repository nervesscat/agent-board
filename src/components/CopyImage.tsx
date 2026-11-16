import { CheckIcon, CopyIcon, CopyXIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Tip } from '#/components/ui/tooltip'
import { copyImage } from '#/lib/clipboardImage'
import { cn } from 'cn'

const SHOWN_FOR = 1500

/**
 * Places a `CopyImageButton` over a thumbnail: out of the way on a desktop until its `group/thumb`
 * ancestor is hovered or the button is focused, and always there on a phone, big enough to tap.
 * Deliberately without a z-index: positioned, it paints over the picture it comes after, and under
 * whatever the page paints above that picture — a sticky header, the step controls riding in it —
 * as the thumbnail scrolls beneath them.
 */
export const COPY_IMAGE_OVERLAY =
  'absolute top-2 right-2 sm:pointer-events-none sm:opacity-0 sm:group-hover/thumb:pointer-events-auto sm:group-hover/thumb:opacity-100 sm:focus-visible:pointer-events-auto sm:focus-visible:opacity-100'

/**
 * A small button that puts an image on the clipboard, from the bytes at its URL. It says so for a
 * moment with a check, and with a toast when the browser has no Clipboard API or the copy failed.
 * Meant to sit over a thumbnail, so it never takes the click that opens the image.
 */
export function CopyImageButton({
  src,
  mime,
  name,
  className,
}: {
  src: string
  mime: string
  name: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function copy() {
    if (busy.current) return
    busy.current = true
    const result = await copyImage(src, mime)
    busy.current = false
    if (timer.current) clearTimeout(timer.current)
    setState(result === 'copied' ? 'copied' : 'failed')
    timer.current = setTimeout(() => setState('idle'), SHOWN_FOR)
    if (result === 'unsupported') toast.error('This browser cannot copy images to the clipboard')
    else if (result === 'failed') toast.error(`Could not copy ${name}`)
  }

  const tip = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy image'

  return (
    <Tip content={tip}>
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label="Copy image"
        data-slot="copy-image"
        data-state={state}
        onClick={copy}
        // 44px on a phone, small on a desktop; the caller places it and decides when it shows.
        className={cn('size-11 shadow-sm sm:size-7', state !== 'idle' && 'opacity-100', className)}
      >
        <span aria-live="polite" className="sr-only">
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : ''}
        </span>
        {state === 'copied' ? (
          <CheckIcon />
        ) : state === 'failed' ? (
          <CopyXIcon className="text-destructive" />
        ) : (
          <CopyIcon />
        )}
      </Button>
    </Tip>
  )
}
