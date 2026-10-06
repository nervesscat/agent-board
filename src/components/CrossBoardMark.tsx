/**
 * CrossBoard's mark: two rows of three sockets with a patch cable from the top-left one to the
 * bottom-right one. The sockets take the current text colour, the cable and its plugs `--brand`.
 * Size it through `className`.
 */
export function CrossBoardMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={3.5}>
        <circle cx="13" cy="13" r="6" />
        <circle cx="32" cy="13" r="6" />
        <circle cx="51" cy="13" r="6" />
        <circle cx="13" cy="51" r="6" />
        <circle cx="32" cy="51" r="6" />
        <circle cx="51" cy="51" r="6" />
      </g>
      <path
        d="M13 13 C 13 42, 51 22, 51 51"
        fill="none"
        stroke="var(--brand)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <circle cx="13" cy="13" r="3.5" fill="var(--brand)" />
      <circle cx="51" cy="51" r="3.5" fill="var(--brand)" />
    </svg>
  )
}
