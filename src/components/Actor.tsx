import { Bot, User } from 'lucide-react'

const AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'cursor', 'scheduler', 'agent', 'bot']

export const isAgent = (name: string) => AGENTS.some((a) => name.toLowerCase().includes(a))

/** Who did it: a bot glyph for agent tokens, a person glyph for the browser session. */
export function Actor({ name, className = '' }: { name: string; className?: string }) {
  const Icon = isAgent(name) ? Bot : User
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${className}`}>
      <Icon className="size-3.5 text-muted-foreground" />
      {name}
    </span>
  )
}
