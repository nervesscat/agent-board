/**
 * The resume templates: the fixed command lines the board can run to continue a ticket's work, which an
 * agent may pick by id (src/server/resume.ts). A template is code, not text: a binary, its constant
 * arguments, and a model and an effort each mapped to constant tokens. The only values that vary per
 * run are the model and the effort, and both come from the enums below; nothing an agent wrote (a title,
 * a card, the instructions, a token) reaches the argument list or the command line. The prompt goes on
 * standard input and in its file, never here.
 *
 * The complexity table, the model and effort vocabulary (the run-report enums) and every map from them to
 * a CLI's flags are in this file, and nowhere else.
 */
import { z } from 'zod'

import { COMPLEXITIES, type Complexity } from './constants'

export const TEMPLATE_IDS = ['claude-code', 'codex-exec', 'opencode-run'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export type Model = (typeof MODELS)[number]

export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

/** Why a model and effort were chosen: the asking run's, the complexity table, or the table with the run's unrecorded. */
export const CHOICES = ['run', 'complexity', 'unrecorded'] as const
export type Choice = (typeof CHOICES)[number]

/** The model and effort for each complexity when no run of the asking agent records its own. */
export const COMPLEXITY_TABLE: Record<Complexity, { model: Model; effort: Effort }> = {
  low: { model: 'haiku', effort: 'medium' },
  mid: { model: 'haiku', effort: 'high' },
  high: { model: 'opus', effort: 'high' },
  max: { model: 'opus', effort: 'high' },
}

interface Template {
  id: TemplateId
  name: string
  /** The program, looked up on the board machine's PATH. */
  binary: string
  /** The arguments every run gets, before the model and effort ones. */
  args: readonly string[]
  /** Constants appended last: the prompt's placeholder (`-` reads stdin) or a fixed message. Never agent text. */
  trailing: readonly string[]
  model: Record<Model, readonly string[]>
  effort: Record<Effort, readonly string[]>
  /** Whether the CLI takes an effort at all: when not, the effort is not passed and the row says so. */
  effortPassed: boolean
  /** The environment every run gets (constants only). */
  env: Readonly<Record<string, string>>
  /** The environment a model adds (the subagent model follows the chosen model). */
  modelEnv: Record<Model, Readonly<Record<string, string>>>
}

const NO_EFFORT = { low: [], medium: [], high: [] } as const satisfies Record<Effort, readonly string[]>
const NO_ENV = {} as const

/**
 * Fixed message for a CLI that takes no prompt on stdin: it tells the run to read the prompt from the file the
 * board names in BOARD_RESUME_PROMPT_FILE (in env). The prompt itself never reaches argv.
 */
export const PROMPT_FILE_MESSAGE =
  'Read the file named by the environment variable BOARD_RESUME_PROMPT_FILE and follow the instructions in it.'

/**
 * The templates. Claude Code's flags were checked against `claude --help` on the board's machine. Codex
 * and OpenCode are not installed on it: their flags and model ids are unverified, and are named as such
 * where the review needs them.
 */
const TEMPLATES: Record<TemplateId, Template> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    binary: 'claude',
    args: ['-p', '--permission-mode', 'bypassPermissions'],
    trailing: [],
    model: {
      haiku: ['--model', 'haiku'],
      sonnet: ['--model', 'sonnet'],
      opus: ['--model', 'opus'],
    },
    effort: {
      low: ['--effort', 'low'],
      medium: ['--effort', 'medium'],
      high: ['--effort', 'high'],
    },
    effortPassed: true,
    // IS_SANDBOX lets bypassPermissions run as root; CLAUDE_CODE_SUBAGENT_MODEL is the model its subagents use.
    env: { IS_SANDBOX: '1' },
    modelEnv: {
      haiku: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
      sonnet: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
      opus: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' },
    },
  },
  'codex-exec': {
    id: 'codex-exec',
    name: 'Codex',
    binary: 'codex',
    // Flags from the Codex CLI reference (https://learn.chatgpt.com/docs/developer-commands?surface=cli, the page
    // developers.openai.com/codex/cli/reference redirects to): `exec`, `--approve-for-me` (automatic approval
    // review, workspace-write sandbox), `-m/--model`, and `-` ("Use - to pipe the prompt from stdin").
    // Not confirmed there: `--full-auto` and the `model_reasoning_effort` key, so no effort is passed.
    // The model ids are NOT confirmed against Codex's own list (not installed here).
    args: ['exec', '--approve-for-me'],
    trailing: ['-'],
    model: {
      haiku: ['-m', 'gpt-5-mini'],
      sonnet: ['-m', 'gpt-5'],
      opus: ['-m', 'gpt-5-codex'],
    },
    effort: NO_EFFORT,
    effortPassed: false,
    env: NO_ENV,
    modelEnv: { haiku: NO_ENV, sonnet: NO_ENV, opus: NO_ENV },
  },
  'opencode-run': {
    id: 'opencode-run',
    name: 'OpenCode',
    binary: 'opencode',
    // Flags from the OpenCode docs (https://opencode.ai/docs/cli/commands.md, https://opencode.ai/v2/docs/cli/commands/):
    // `run` takes its message as a positional argument, and `-m/--model provider/model`. The docs do not say that
    // `run` reads stdin, so the prompt is read from its file through a fixed message. The model ids are NOT
    // confirmed (opencode is not installed here; `opencode models anthropic` lists them on a machine that has it).
    args: ['run'],
    trailing: [PROMPT_FILE_MESSAGE],
    model: {
      haiku: ['-m', 'anthropic/claude-haiku-5-5'],
      sonnet: ['-m', 'anthropic/claude-sonnet-5-5'],
      opus: ['-m', 'anthropic/claude-opus-5-5'],
    },
    effort: NO_EFFORT,
    effortPassed: false,
    env: NO_ENV,
    modelEnv: { haiku: NO_ENV, sonnet: NO_ENV, opus: NO_ENV },
  },
}

/** Tokens a template argument may hold: a flag, a model id, a key=value pair. Nothing with a space or a shell character. */
const TOKEN = /^[A-Za-z0-9._=:/-]+$/

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value)
}
export function parseModel(value: unknown): Model | null {
  return typeof value === 'string' && (MODELS as readonly string[]).includes(value) ? (value as Model) : null
}
export function parseEffort(value: unknown): Effort | null {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
    ? (value as Effort)
    : null
}

/** The program a template runs: the one place a template's binary is named (the presets read it too). */
export function templateBinary(id: TemplateId): string {
  return TEMPLATES[id].binary
}

/** The templates the Settings page and the API list: id, name, binary, and whether the CLI takes an effort. */
export function templateList() {
  return TEMPLATE_IDS.map((id) => {
    const t = TEMPLATES[id]
    return { id, name: t.name, binary: t.binary, effortPassed: t.effortPassed }
  })
}

export interface Assembled {
  id: TemplateId
  binary: string
  args: string[]
  env: Record<string, string>
  /** Whether the effort was passed (false for a CLI that takes none). */
  effortPassed: boolean
}

/**
 * The command of a template with a model and an effort: the binary, its arguments and the environment it
 * adds. Throws on anything outside the enums, so the only values in the result are constants and enum tokens.
 */
export function assemble(id: unknown, model: unknown, effort: unknown): Assembled {
  if (!isTemplateId(id)) throw new Error(`unknown resume template: ${String(id)}`)
  const m = parseModel(model)
  const e = parseEffort(effort)
  if (!m) throw new Error(`unknown model: ${String(model)}`)
  if (!e) throw new Error(`unknown effort: ${String(effort)}`)
  const t = TEMPLATES[id]
  const args = [...t.args, ...t.model[m], ...t.effort[e]]
  for (const a of args) if (!TOKEN.test(a)) throw new Error(`resume template token refused: ${a}`)
  return {
    id,
    binary: t.binary,
    // The constant trailing tokens follow the checked ones: `-` (stdin) or the fixed prompt-file message.
    args: [...args, ...t.trailing],
    env: { ...t.env, ...t.modelEnv[m] },
    effortPassed: t.effortPassed,
  }
}

/**
 * The line a Windows shell runs for the template (its `.cmd` shim is run through the shell). Every token is
 * a constant or an enum token, checked by `assemble`, so no quoting is needed.
 */
export function commandLine(a: Assembled): string {
  return [a.binary, ...a.args].join(' ')
}

export interface ChosenModel {
  model: Model
  effort: Effort
  choice: Choice
}

/**
 * The model and effort of one resume: the asking run's when it records valid ones, else the complexity
 * table. `run` is what the asking run recorded (`null`: no asking run to read), and its values are checked
 * against the enums here, so an invalid one is ignored.
 */
export function chooseModelEffort(
  complexity: unknown,
  run: { model: unknown; effort: unknown } | null,
): ChosenModel {
  if (typeof complexity !== 'string' || !(COMPLEXITIES as readonly string[]).includes(complexity))
    throw new Error(`unknown complexity: ${String(complexity)}`)
  const m = parseModel(run?.model)
  const e = parseEffort(run?.effort)
  if (run && m && e) return { model: m, effort: e, choice: 'run' }
  const row = COMPLEXITY_TABLE[complexity as Complexity]
  return { ...row, choice: run ? 'unrecorded' : 'complexity' }
}

/** A template as an agent or the Settings page names it: `null` is off. */
export const TemplateChoice = z.enum(TEMPLATE_IDS).nullable()

/** The body of `PUT /api/projects/:id/resume-template` and the `set_resume_template` tool: nothing else. */
export const ResumeTemplateBody = z.object({ template: TemplateChoice }).strict()
