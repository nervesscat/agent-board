import type { CSSProperties } from 'react'

import type { PetState } from '#/lib/agentsAtWork'
import { cn } from '#/lib/utils'

/**
 * A tiny round robot-cat at an open laptop, drawn for this board: an antenna with a bulb, two pointed
 * ears, a face plate with two eyes, and paws on the laptop's keys, seen over the back of its screen.
 * Its pose says what it is doing: typing (working), one paw up with a "?" (waiting on the human), eyes
 * shut with "z z" and dimmed (asleep), waving with a tick (done). The paint is the theme's own
 * (`var(--foreground)` and friends), so it reads in light and dark; the motion is CSS keyframes on
 * transform and opacity (styles.css, `.pet`), stilled under reduced motion. Decorative: the link around
 * it carries the words.
 */
export function AgentPet({
  state,
  small = false,
  index = 0,
  className,
}: {
  state: PetState
  /** A subagent: the same character, smaller. */
  small?: boolean
  /** Its place in the strip: shifts its animation so they do not all move together. */
  index?: number
  className?: string
}) {
  const raised = state === 'waiting' || state === 'done'
  const width = small ? 26 : 40
  return (
    <svg
      viewBox="0 0 32 28"
      width={width}
      height={(width * 28) / 32}
      aria-hidden="true"
      focusable="false"
      data-pet={state}
      className={cn('pet shrink-0', state === 'asleep' && 'opacity-60', className)}
      style={{ '--pet-delay': `${-((index * 0.37) % 1.6).toFixed(2)}s` } as CSSProperties}
    >
      {/* The antenna and its bulb. */}
      <path d="M16 5V2" stroke="var(--muted-foreground)" strokeWidth="1.2" strokeLinecap="round" />
      <circle className="pet-bulb" cx="16" cy="1.8" r="1.4" fill="var(--foreground)" />
      {/* The ears, then the head over them. */}
      <path d="M8.5 8 9 2.5 14 5.5ZM23.5 8 23 2.5 18 5.5Z" fill="var(--muted-foreground)" />
      <rect x="7" y="4.5" width="18" height="13" rx="5.5" fill="var(--muted-foreground)" />
      <rect x="9.5" y="7.5" width="13" height="8" rx="3.5" fill="var(--card)" />
      {state === 'asleep' ? (
        <path
          d="M11.8 11.6q1.4 1.5 2.8 0M17.4 11.6q1.4 1.5 2.8 0"
          fill="none"
          stroke="var(--foreground)"
          strokeWidth="1"
          strokeLinecap="round"
        />
      ) : (
        <>
          <circle cx="13.2" cy="11.4" r="1.2" fill="var(--foreground)" />
          <circle cx="18.8" cy="11.4" r="1.2" fill="var(--foreground)" />
        </>
      )}
      {/* The laptop, seen from behind: its screen's back, and the base with the keys under the paws. */}
      <rect
        x="6"
        y="15.5"
        width="20"
        height="8"
        rx="1.8"
        fill="var(--muted)"
        stroke="var(--muted-foreground)"
        strokeWidth="1"
      />
      <rect x="2.5" y="23" width="27" height="3.2" rx="1.6" fill="var(--foreground)" />
      {/* The paws on the keys: they take turns when it works, rest when it waits, sleeps or is done. */}
      <circle
        className={cn(state === 'working' && 'pet-paw-l')}
        cx="11"
        cy="22"
        r="2.2"
        fill="var(--muted-foreground)"
      />
      {raised ? (
        <g className={cn(state === 'done' ? 'pet-wave' : 'pet-raise')}>
          <path d="M21 22.4 27 11" stroke="var(--muted-foreground)" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="27.2" cy="10.4" r="2.2" fill="var(--muted-foreground)" />
        </g>
      ) : (
        <circle
          className={cn(state === 'working' && 'pet-paw-r')}
          cx="21"
          cy="22"
          r="2.2"
          fill="var(--muted-foreground)"
        />
      )}
      {state === 'waiting' && (
        <text
          className="pet-ask"
          x="1.5"
          y="9"
          fontSize="9"
          fontWeight="700"
          fontFamily="sans-serif"
          fill="var(--foreground)"
        >
          ?
        </text>
      )}
      {state === 'done' && (
        <path
          d="m2.5 7 2.6 2.6L9 4.6"
          fill="none"
          stroke="var(--foreground)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {state === 'asleep' && (
        <>
          <text
            className="pet-z"
            x="25"
            y="7"
            fontSize="6"
            fontWeight="700"
            fontFamily="sans-serif"
            fill="var(--foreground)"
          >
            z
          </text>
          <text
            className="pet-z pet-z-late"
            x="28"
            y="3.5"
            fontSize="4"
            fontWeight="700"
            fontFamily="sans-serif"
            fill="var(--foreground)"
          >
            z
          </text>
        </>
      )}
    </svg>
  )
}
