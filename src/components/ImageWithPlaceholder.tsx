import { useCallback, useState } from 'react'

import { Skeleton } from '#/components/ui/skeleton'
import { useDelayedFlag } from '#/lib/useDelayedFlag'

/**
 * A thumbnail with a skeleton behind it until it has loaded (or failed to: a broken image keeps its
 * alt text, never a skeleton). Put it in a box of fixed size that is `relative`, so the box does not
 * change when the picture lands.
 */
export function ImageWithPlaceholder({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
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
        className={className}
        loading="lazy"
        onLoad={() => setSettled(true)}
        onError={() => setSettled(true)}
      />
    </>
  )
}
