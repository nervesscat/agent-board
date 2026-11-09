import type { AgentTokenRow, HostTools, ProjectRow } from '#/lib/api'

/**
 * Getting started: the four steps a new user takes before an agent works on the board, each ticked by
 * a fact the board already has. Nothing here is stored on the server; this browser remembers only
 * that the checklist was dismissed or once reached 4 of 4, per user.
 */
export type StepId = 'tools' | 'project' | 'agent' | 'ticket'

/** The tools an agent's work needs on the board's machine; node and pnpm are for previews only. */
export const NEEDED_TOOLS = ['git', 'gh', 'claude'] as const

/**
 * What the board answered, per source: undefined while it has not answered, null when it could not
 * (an error): a step whose source failed is shown not done, never left loading.
 */
export interface Facts {
  tools: HostTools | null | undefined
  projects: ProjectRow[] | null | undefined
  tokens: AgentTokenRow[] | null | undefined
}

export interface Step {
  id: StepId
  done: boolean
  /** The board has not answered for this step yet. */
  pending: boolean
  /** The board could not answer for this step: shown not done. */
  failed: boolean
}

export function steps(f: Facts): Step[] {
  const tools = f.tools?.tools.filter((t) => (NEEDED_TOOLS as readonly string[]).includes(t.name))
  const repos = f.projects?.some((p) => p.repos.length > 0)
  const tickets = f.projects?.some((p) => p.counts.tickets > 0)
  const step = (id: StepId, source: unknown, done: boolean | undefined): Step => ({
    id,
    done: Boolean(done),
    pending: source === undefined,
    failed: source === null,
  })
  return [
    step('tools', f.tools, tools ? tools.length === NEEDED_TOOLS.length && tools.every((t) => t.ok) : false),
    step('project', f.projects, repos),
    step('agent', f.tokens, f.tokens ? f.tokens.length > 0 : false),
    step('ticket', f.projects, tickets),
  ]
}

/** The needed tools that are missing or (gh) signed out, with their fix. */
export function missingTools(tools: HostTools | null | undefined) {
  return (tools?.tools ?? []).filter((t) => (NEEDED_TOOLS as readonly string[]).includes(t.name) && !t.ok)
}

/**
 * What this browser remembers for one user: `dismissed` (they closed it) or `done` (it once reached
 * 4 of 4: a fact that stops holding later, a revoked token or a deleted project, does not bring it
 * back). Either hides the top-bar entry for good.
 */
export type Remembered = 'dismissed' | 'done'

const key = (user: string) => `getting-started:${user}`

export function recallOnboarding(user: string): Remembered | null {
  try {
    const v = localStorage.getItem(key(user))
    return v === 'dismissed' || v === 'done' ? v : null
  } catch {
    return null
  }
}

/** Storage can be unavailable: then it is remembered for this page only, by the caller's state. */
export function rememberOnboarding(user: string, value: Remembered) {
  try {
    localStorage.setItem(key(user), value)
  } catch {}
}
