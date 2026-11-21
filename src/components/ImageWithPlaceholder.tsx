import { useCallback, useState } from 'react'

import { Skeleton } from '#/components/ui/skeleton'
import { useDelayedFlag } from '#/lib/useDelayedFlag'
import { cn } from 'cn'

/**
 * A thumbnail with a skeleton behind it until it has loaded (or failed to: a broken image keeps its
 * alt text, never a skeleton). It sits in its own box: `boxClassName` is the box's, `loadingBoxClassName`
 * gives the box a size while the picture has none yet (a tile whose parent already sets the size needs
 * neither).
 */
export function ImageWithPlaceholder({
  src,
  alt,
  className,
  boxClassName,
  loadingBoxClassName,
}: {
  src: string
  alt: string
  className?: string
  boxClassName?: string
  loadingBoxClassName?: string
}) {
  const [settled, setSettled] = useState(false)
  const slow = useDelayedFlag(!settled)
  // A picture that was cached may be done before React attached onLoad.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete) setSettled(true)
  }, [])
  return (
    <span className={cn('relative block', boxClassName, !settled && loadingBoxClassName)}>
      {slow && <Skeleton aria-hidden className="absolute inset-0 rounded-none" />}
      <img
        ref={ref}
        src={src}
        alt={alt}
        className={className}
        loading="lazy"
        onLoad={() => setSettled(true)}
        onError={() => setSettled(true)}
      />
    </span>
  )
}
