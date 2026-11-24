/**
 * The resume command (src/server/resume.ts): what the board runs to continue a ticket's work once the human
 * answers a decision card or moves the ticket back to an active stage. Shared by the server and the
 * Settings page.
 */

export interface ResumePreset {
  id: string
  /** The agent CLI's name as people say it. */
  name: string
  /** The program the command starts, looked up on the board machine's PATH. */
  binary: string
  /** The command: it reads the prompt from its standard input. */
  command: string
}

/** The CLIs the Connect an agent page knows (`src/lib/agents.ts`). The human can edit any of them. */
export const RESUME_PRESETS: readonly ResumePreset[] = [
  { id: 'claude', name: 'Claude Code', binary: 'claude', command: 'claude -p' },
  { id: 'codex', name: 'Codex', binary: 'codex', command: 'codex exec' },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', command: 'opencode run' },
]

export const RESUME_COMMAND_MAX = 1_000
/** Minutes a resumed run may go on before the board stops it: 240 (four hours) by default, up to a week. */
export const RESUME_TIMEOUT = { min: 1, max: 10_080, default: 240 } as const

/** What the command is called on the ticket: its first word, without a folder or quotes. */
export function resumeCommandName(command: string): string {
  const first = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  const word = first?.[1] ?? first?.[2] ?? first?.[3] ?? ''
  return word.split(/[\\/]/).pop() || word
}

/** Why a command cannot be saved, or null: one line, not too long, no control characters. */
export function resumeCommandProblem(command: string): string | null {
  if (command.length > RESUME_COMMAND_MAX) return `the command is at most ${RESUME_COMMAND_MAX} characters`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command))
    return 'the command is one line: no line breaks or control characters'
  return null
}
