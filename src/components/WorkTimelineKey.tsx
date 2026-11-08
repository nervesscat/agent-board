import type { CSSProperties, ReactNode } from 'react'
import {
  ArrowRight,
  CircleDot,
  Eye,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hourglass,
  Lock,
  Pause,
  Plug,
  User,
  type LucideIcon,
} from 'lucide-react'

/*
 * The chart's visual language, in one place: the chart draws with these classes and the key below shows
 * the same ones, so a sample on the key is what the chart draws.
 */

/** Work, by phase: solid, with its name as the label. */
export const PHASE: Record<string, string> = {
  spec: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-sky-950',
  build: 'bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950',
  review: 'bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950',
  verify: 'bg-teal-600 text-white dark:bg-teal-400 dark:text-teal-950',
  pr: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950',
  preview: 'bg-pink-600 text-white dark:bg-pink-400 dark:text-pink-950',
  merge: 'bg-lime-700 text-white dark:bg-lime-400 dark:text-lime-950',
}
export const OTHER_PHASE = 'bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-900'

/** A plain wait: hatched outline in its text colour, on the waiting agent's row only. */
export const PLAIN_WAIT = 'border border-foreground/70 bg-card text-foreground'
/** A wait on the human: solid amber, the one filled wait. */
export const HUMAN_WAIT = 'bg-amber-500 text-amber-950 dark:bg-amber-400 dark:text-amber-950'
/** Delegated work: a thin connector in the text colour, not a bar. */
export const DELEGATION = 'text-foreground'
/** Diagonal stripes in the element's own text colour, faded so its label stays readable. */
export const HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg, color-mix(in oklab, currentColor 30%, transparent) 0 3px, transparent 3px 7px)',
}
/** A blocked stage: a band behind every row, and a chip on the board's rail. */
export const BLOCKED_BAND = 'bg-amber-500/10 dark:bg-amber-400/10'
export const BLOCKED_CHIP =
  'border border-dashed border-amber-700/70 bg-amber-500/30 text-amber-950 dark:border-amber-300/70 dark:bg-amber-400/25 dark:text-amber-50'
export const HANDOFF_LINE = 'border-muted-foreground'
export const NOW_LINE = 'bg-foreground'
export const GRID_LINE = 'bg-border'
export const ARROW = 'border bg-card text-foreground'

export const WAIT_ICON: Record<string, LucideIcon> = { lock: Lock, mcp: Plug, other: Hourglass }
export const NEUTRAL_WAIT_ICON = Pause
export const HUMAN_ICON = User
export const ARROW_ICON = ArrowRight

/** The board's own events: a name for the label and an icon. */
export const MARK: Record<string, { name: string; icon: LucideIcon }> = {
  push: { name: 'push', icon: GitCommitHorizontal },
  pr: { name: 'pull request', icon: GitPullRequest },
  preview: { name: 'preview', icon: Eye },
  merge: { name: 'merge', icon: GitMerge },
}
export const OTHER_MARK = { name: 'board event', icon: CircleDot }

/** The icon of a wait's reason; the human's and any other reason's are the same as the rest. */
export const waitIcon = (reason: string): LucideIcon => WAIT_ICON[reason] ?? NEUTRAL_WAIT_ICON

const SAMPLE = 'inline-flex h-4 items-center gap-1 rounded-sm px-1 text-[10px] leading-none whitespace-nowrap'

function Item({ sample, children }: { sample: ReactNode; children?: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      {sample}
      {children && <span>{children}</span>}
    </li>
  )
}

/** The chart's key: each mark and its meaning, drawn from the same classes as the chart. */
export function WorkTimelineKey() {
  const phases = Object.keys(PHASE)
  const plain: { reason: string; text: string }[] = [
    { reason: 'lock', text: 'waiting: lock' },
    { reason: 'mcp', text: 'waiting: mcp' },
    { reason: 'other', text: 'waiting: other' },
    { reason: '', text: 'waiting, any other reason' },
  ]
  return (
    <ul
      aria-label="Timeline key"
      data-testid="work-timeline-key"
      className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground"
    >
      {phases.map((p) => (
        <Item key={p} sample={<span className={`${SAMPLE} ${PHASE[p]}`}>{p}</span>} />
      ))}
      {plain.map(({ reason, text }) => {
        const Icon = waitIcon(reason)
        return (
          <Item
            key={reason || 'other-reason'}
            sample={
              <span className={`${SAMPLE} ${PLAIN_WAIT}`} style={HATCH}>
                <Icon className="size-3" aria-hidden />
                <span className="rounded-sm bg-card px-0.5">{reason || 'reason'}</span>
              </span>
            }
          >
            {text}
          </Item>
        )
      })}
      <Item
        sample={
          <span className={`${SAMPLE} ${HUMAN_WAIT}`}>
            <HUMAN_ICON className="size-3" aria-hidden />
            human
          </span>
        }
      >
        waiting on the human
      </Item>
      <Item sample={<span aria-hidden className={`h-px w-6 bg-current ${DELEGATION}`} />}>
        delegated to another agent
      </Item>
      <Item
        sample={
          <span className={`grid size-4 place-items-center rounded-full ${ARROW}`}>
            <ARROW_ICON className="size-2.5" aria-hidden />
          </span>
        }
      >
        hand-off, on the row it lands on
      </Item>
      <Item sample={<span aria-hidden className={`h-4 w-0 border-l border-dashed ${HANDOFF_LINE}`} />}>
        hand-off, from the row it leaves
      </Item>
      {Object.entries(MARK).map(([kind, { name, icon: Icon }]) => (
        <Item key={kind} sample={<Icon className="size-3.5" aria-hidden />}>
          {name}
        </Item>
      ))}
      <Item sample={<span className={`${SAMPLE} rounded-none ${BLOCKED_CHIP}`}>blocked</span>}>
        blocked stage
      </Item>
      <Item
        sample={
          <span
            aria-hidden
            className={`${SAMPLE} ${PHASE.build} rounded-r-none`}
            style={{ maskImage: 'linear-gradient(to right, #000 60%, transparent)' }}
          >
            open
          </span>
        }
      >
        still open, growing
      </Item>
      <Item sample={<span aria-hidden className={`h-4 w-0.5 ${NOW_LINE}`} />}>now</Item>
    </ul>
  )
}

/** A style for a segment's box, with its share of the axis. */
export const boxStyle = (left: number, width: number, top: number, height: number): CSSProperties => ({
  left: `${left * 100}%`,
  width: `max(6px, ${width * 100}%)`,
  top,
  height,
})
