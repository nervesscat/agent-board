import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

/**
 * The trash icon on every delete button in the board: lucide's `Trash2` outline, drawn here so its lid
 * (the bar and the handle above it) is a group of its own and can lift and swing open from its hinge
 * on hover while the can stays put. The red and the motion live beside it in `styles.css`
 * (`.trash-icon`), so a delete button gets
 * both by showing this and nothing else; its size still follows the button's own `[&_svg]` rules.
 */
export function TrashIcon({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('lucide lucide-trash-2 trash-icon', className)}
      {...props}
    >
      <g data-trash-part="lid" className="trash-icon-lid">
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </g>
      <g data-trash-part="can">
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </g>
    </svg>
  )
}
