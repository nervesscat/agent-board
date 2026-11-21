import type { CSSProperties } from 'react'

import type { PetState } from '#/lib/agentsAtWork'
import { PET_COLORS, PET_FRAMES, PET_HEIGHT, PET_WIDTH, framePaths } from '#/lib/petSprites'
import { cn } from '#/lib/utils'

/** The frames as paths, worked out once: each pose is two frames (`lib/petSprites.ts`). */
const PAINTED = Object.fromEntries(
  Object.entries(PET_FRAMES).map(([state, frames]) => [state, frames.map(framePaths)]),
) as Record<PetState, ReturnType<typeof framePaths>[]>

/**
 * A tiny pixel-art robot-cat at an open laptop, drawn for this board on a small grid
 * (`lib/petSprites.ts`) and painted as crisp SVG paths: one art pixel is 3 screen pixels (2 for a
 * subagent), never smoothed. Its pose says what it is doing: typing (working), one paw up with a "?"
 * (waiting on the human), eyes shut with "z" drifting up and dimmed (asleep). The paint is the theme's
 * own (`var(--foreground)` and friends), so it reads in light and dark. Each pose is two frames flipped in
 * turn by CSS (styles.css, `.pet`), a step at a time; under reduced motion it holds the first frame.
 * Decorative: the link around it carries the words.
 */
export function AgentPet({
  state,
  small = false,
  index = 0,
  className,
}: {
  state: PetState
  /** A subagent: the same character, at two thirds of the size. */
  small?: boolean
  /** Its place in the strip: shifts its animation so they do not all move together. */
  index?: number
  className?: string
}) {
  const scale = small ? 2 : 3
  return (
    <svg
      viewBox={`0 0 ${PET_WIDTH} ${PET_HEIGHT}`}
      width={PET_WIDTH * scale}
      height={PET_HEIGHT * scale}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-pet={state}
      className={cn('pet shrink-0', state === 'asleep' && 'opacity-60', className)}
      style={{ '--pet-delay': `${-((index * 0.37) % 1.6).toFixed(2)}s` } as CSSProperties}
    >
      {PAINTED[state].map((paths, frame) => (
        <g key={frame} className={frame === 0 ? 'pet-frame-a' : 'pet-frame-b'}>
          {paths.map(({ letter, d }) => (
            <path key={letter} d={d} fill={PET_COLORS[letter]} />
          ))}
        </g>
      ))}
    </svg>
  )
}
