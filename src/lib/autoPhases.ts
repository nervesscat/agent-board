/**
 * The hand-off phases the board ticks itself, from git, GitHub and the previews: a top-level task named
 * one of these (trimmed, any case) is ticked while its fact holds and unticked when it stops holding,
 * and nobody ticks it by hand. A subtask of the same name is an ordinary task, and so is a phase
 * reworded away from these names. Implementation and its steps stay ticked by hand.
 */
export const AUTO_PHASES = ['Pushed', 'PR', 'CI', 'Preview', 'Merged'] as const

export type AutoPhase = (typeof AUTO_PHASES)[number]

const BY_NAME = new Map<string, AutoPhase>(AUTO_PHASES.map((p) => [p.toLowerCase(), p]))

/** The automatic phase a task is, or null: only a top-level task whose text names one. */
export function autoPhaseOf(task: { parentId: number | null; text: string }): AutoPhase | null {
  if (task.parentId) return null
  return BY_NAME.get(task.text.trim().toLowerCase()) ?? null
}

/** What the board checks for each phase, for its tooltip and for the error a manual tick gets. */
export const AUTO_PHASE_RULE: Record<AutoPhase, string> = {
  Pushed: 'from git (the branch is on origin with every local commit)',
  PR: 'from GitHub (an open or merged PR for the ticket)',
  CI: `from GitHub (the PR's checks green, or a "CI run locally: green" comment on the head SHA)`,
  Preview: "from the previews (one of the ticket's workspaces runs a preview, or its preview link answers)",
  Merged: 'from GitHub and git (the PR merged, or the branch merged into its base)',
}

/** The tooltip on an automatic phase's marker. */
export const autoPhaseTip = (phase: AutoPhase) => `Ticked by the board ${AUTO_PHASE_RULE[phase]}`
