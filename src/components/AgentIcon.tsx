import type { AgentClient } from '#/lib/constants'

/**
 * A small mark per agent CLI, drawn in the current colour so it follows the theme: Claude's
 * starburst, a terminal prompt for Codex, and OpenCode's open square.
 */
export function AgentIcon({ client, className = 'size-4' }: { client: AgentClient; className?: string }) {
  switch (client) {
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * Math.PI) / 6
            const r = i % 2 ? 7 : 10
            return (
              <line
                key={i}
                x1={12 + 2 * Math.cos(a)}
                y1={12 + 2 * Math.sin(a)}
                x2={12 + r * Math.cos(a)}
                y2={12 + r * Math.sin(a)}
                strokeWidth={2.2}
                strokeLinecap="round"
              />
            )
          })}
        </svg>
      )
    case 'codex':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor">
          <rect x="2.5" y="4" width="19" height="16" rx="3.5" strokeWidth={1.8} />
          <path d="m7 9 3 3-3 3M12.5 15H17" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'opencode':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
          <path d="M4 3h16v18H4zm4 4v10h8V7z" fillRule="evenodd" />
          <path d="M8 13h8v4H8z" opacity={0.45} />
        </svg>
      )
  }
}
