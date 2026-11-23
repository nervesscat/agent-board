/**
 * Whether an element has been scrolled up out of view, under a bar that covers the window's top: not
 * while it is in view at its place, nor partly. `barBottom` is where the bar ends, in px from the window's
 * top. Read from an IntersectionObserver entry whose root margin is that bar's height.
 */
export function scrolledAway(
  entry: Pick<IntersectionObserverEntry, 'isIntersecting' | 'boundingClientRect'>,
  barBottom: number,
) {
  return !entry.isIntersecting && entry.boundingClientRect.bottom <= barBottom
}
