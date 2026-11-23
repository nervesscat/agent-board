import { useCallback, useState } from 'react'

import { Skeleton } from '#/components/ui/skeleton'
import { useDelayedFlag } from '#/lib/useDelayedFlag'
import { cn } from 'cn'

/**
 * A thumbnail with a skeleton behind it until it has loaded (or failed to: a broken image keeps its
 * alt text, never a skeleton). The skeleton fills the nearest `relative` ancestor; `loadingClassName`
 * gives the picture a size while it has none yet (a tile whose parent already sets the size needs none).
 */
export function ImageWithPlaceholder({
  src,
  alt,
  className,
  loadingClassName,
}: {
  src: string
  alt: string
  className?: string
  loadingClassName?: string
}) {
  const [settled, setSettled] = useState(false)
  const slow = useDelayedFlag(!settled)
  // A picture that was cached may be done before React attached onLoad.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete) setSettled(true)
  }, [])
  return (
    <>
      {slow && <Skeleton aria-hidden className="absolute inset-0 rounded-none" />}
      <img
        ref={ref}
        src={src}
        alt={alt}
        className={cn(className, !settled && loadingClassName)}
        loading="lazy"
        onLoad={() => setSettled(true)}
        onError={() => setSettled(true)}
      />
    </>
  )
}
