import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AgentChip, ChangedChip, Chip } from '#/components/WorkflowChips'
import { Tip } from '#/components/ui/tooltip'
import type { Complexity } from '#/lib/constants'
import type { ResolvedReview, ResolvedStep, ResolvedWorkflow } from '#/lib/workflow'
import {
  loopLabel,
  parallelColumns,
  phaseView,
  roundRows,
  stepView,
  type NodeView,
  type RoundRow,
} from '#/lib/workflowGraph'
import { cn } from '#/lib/utils'

/**
 * The workflow as a vertical graph: each step a node card, joined by arrows from top to bottom, and the review
 * step opened into its round: the phases in order, those that run side by side forking and joining again, and
 * the fix pass and the gate drawn as the way back to the start of the round, labelled with how many rounds the
 * complexity gets. The layout is automatic: nothing is dragged and no position is kept. A node is one button: it
 * selects the node, and its settings open beside the graph (the page owns them).
 */
export function WorkflowGraph({
  workflow,
  selected,
  onSelect,
}: {
  workflow: ResolvedWorkflow
  /** The id of the node whose settings are open. */
  selected: string | null
  /** Called with the node's id, and whether the keyboard did it (it moves the focus on to the settings). */
  onSelect: (id: string, byKeyboard: boolean) => void
}) {
  const { t } = useTranslation()
  const complexity = workflow.complexity ?? 'mid'
  const pick = { selected, onSelect }
  return (
    <div
      data-graph
      role="group"
      aria-label={t('workflowGraph.label', {
        label: workflow.label,
        complexity: t(`workflowGraph.complexity.${complexity}`),
      })}
      className="mx-auto w-full max-w-2xl"
    >
      <ol className="flex flex-col items-center">
        {workflow.steps.map((step, i) => {
          const next = workflow.steps[i + 1]
          const dim = step.skipped !== null
          return (
            <li key={step.id} className="flex w-full flex-col items-center">
              <Node view={stepView(step)} {...pick} className="max-w-80" />
              {step.review && (
                <>
                  <Edge from={step.id} to={`${step.id}.round`} />
                  <Round review={step.review} step={step} complexity={complexity} dim={dim} {...pick} />
                </>
              )}
              {next && (
                <Edge
                  from={step.review ? `${step.id}.round` : step.id}
                  to={next.id}
                  label={step.review && !dim ? t('workflowGraph.roundSurvives') : undefined}
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The head of an arrow, pointing down. */
function Arrowhead() {
  return (
    <svg width="10" height="7" viewBox="0 0 10 7" aria-hidden className="block shrink-0 fill-current">
      <path d="M0 0h10L5 7z" />
    </svg>
  )
}

/** A line with its arrowhead, running down from `top` (a stretch of it) to the node below. */
function Stub({ className }: { className?: string }) {
  return (
    <span className={cn('flex flex-col items-center', className)}>
      <span className="w-0.5 flex-1 bg-current" />
      <Arrowhead />
    </span>
  )
}

const LINE = 'text-muted-foreground/70'

/** An arrow from one node to the next, top to bottom; its label (outside the arrow, readable) says when it is taken. */
function Edge({ from, to, label }: { from: string; to: string; label?: string }) {
  return (
    <div className={cn('relative flex shrink-0 justify-center', LINE)}>
      <div data-edge={`${from}>${to}`} aria-hidden className="flex h-7 flex-col items-center">
        <span className="w-0.5 flex-1 bg-current" />
        <Arrowhead />
      </div>
      {label && (
        <span className="absolute top-1/2 left-1/2 ml-3 -translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground">
          {label}
        </span>
      )}
    </div>
  )
}

/** A node card: its number, label, who runs it, its effort and what state it is in. One button; the whole card selects it. */
function Node({
  view,
  selected,
  onSelect,
  className,
  compact = false,
}: {
  view: NodeView
  selected: string | null
  onSelect: (id: string, byKeyboard: boolean) => void
  className?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const on = selected === view.id
  const off = view.skipped !== null
  return (
    <button
      type="button"
      data-step={view.id}
      data-skipped={off || undefined}
      data-changed={view.changed ? '' : undefined}
      aria-label={view.name}
      aria-pressed={on}
      aria-current={on ? 'true' : undefined}
      onClick={(e) => onSelect(view.id, e.detail === 0)}
      className={cn(
        'relative z-[1] flex w-full min-w-0 flex-col gap-2 rounded-xl border bg-card text-left shadow-xs transition-colors outline-none hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50',
        compact ? 'p-2.5' : 'p-3',
        off && 'border-dashed bg-card/60 opacity-70 shadow-none',
        on && 'border-primary shadow-md ring-2 ring-primary/60',
        className,
      )}
    >
      <span className="flex items-start gap-2">
        {view.number !== null || !compact ? (
          <span
            data-number
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              compact ? 'h-5 min-w-5 px-1 font-mono' : 'size-6',
              off
                ? 'border-dashed bg-background text-muted-foreground'
                : 'border-primary bg-primary text-primary-foreground',
            )}
          >
            {view.number ?? '–'}
          </span>
        ) : null}
        <span
          className={cn(
            'min-w-0 flex-1 leading-snug font-semibold wrap-break-word',
            compact ? 'text-[13px]' : 'text-sm',
          )}
        >
          {view.label}
        </span>
        {view.lock && (
          <Tip content={view.lockReason ?? undefined}>
            <span
              role="img"
              aria-label={view.lockReason ?? t('workflowChips.locked')}
              data-lock={view.lock}
              className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            >
              <Lock className="size-3.5" aria-hidden />
            </span>
          </Tip>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <AgentChip agent={view.role} label={view.agentLabel} team={view.team} plain />
        {view.effort !== null && <Chip tone="effort">{view.effort}</Chip>}
        {view.skipped && <Chip tone="skipped">{view.skipped}</Chip>}
        {!view.skipped && view.skipsOnLow && <Chip tone="skipped">{t('workflowChips.skippedOnLow')}</Chip>}
        {view.changed && <ChangedChip what={view.changed} plain />}
      </span>
    </button>
  )
}

/** The graph's own width classes for a row of `n` parallel phases: side by side from a width that fits them, stacked below it. */
const FAN = {
  2: {
    grid: '@sm:grid-cols-2',
    show: 'hidden @sm:block',
    hide: '@sm:hidden',
    label: '@sm:absolute @sm:top-1 @sm:left-1/2 @sm:mb-0 @sm:ml-4', // i18n-ignore: CSS classes
    box: '@sm:gap-y-0 @sm:border-transparent @sm:p-0',
  },
  3: {
    grid: '@md:grid-cols-3',
    show: 'hidden @md:block',
    hide: '@md:hidden',
    label: '@md:absolute @md:top-1 @md:left-1/2 @md:mb-0 @md:ml-4', // i18n-ignore: CSS classes
    box: '@md:gap-y-0 @md:border-transparent @md:p-0',
  },
  4: {
    grid: '@lg:grid-cols-4',
    show: 'hidden @lg:block',
    hide: '@lg:hidden',
    label: '@lg:absolute @lg:top-1 @lg:left-1/2 @lg:mb-0 @lg:ml-4', // i18n-ignore: CSS classes
    box: '@lg:gap-y-0 @lg:border-transparent @lg:p-0',
  },
} as const

/** The space between the cards of a row, which the fork and the join bars are cut to. */
const GAP = 'gap-x-2'

/**
 * Phases that run side by side: an arrow forks from the phase before to each of them and they join again into
 * the next one. Where the room is short they stack inside a dashed box that says they run in parallel.
 */
function Parallel({
  group,
  steps,
  before,
  after,
  selected,
  onSelect,
}: {
  group: string
  steps: ResolvedReviewPhases
  before: string
  after: string | null
  selected: string | null
  onSelect: (id: string, byKeyboard: boolean) => void
}) {
  const { t } = useTranslation()
  const n = steps.length
  const fan = FAN[parallelColumns(n)]
  const cells = steps.map((_, i) => i)
  const cell = 'absolute top-0 bottom-0 left-1/2 -translate-x-1/2'
  return (
    <div data-parallel={group} className="@container relative flex w-full flex-col items-center">
      <div className={cn('flex w-full justify-center', fan.hide)}>
        <Edge from={before} to={steps[0]!.id} />
      </div>
      <div data-edge={`${before}>fork`} aria-hidden className={cn('relative h-11 w-full', LINE, fan.show)}>
        <span className="absolute top-0 left-1/2 h-5 w-0.5 -translate-x-1/2 bg-current" />
        <div className={cn('absolute inset-x-0 top-5 bottom-0 grid', GAP, fan.grid)}>
          {cells.map((i) => (
            <div key={i} className="relative">
              {i > 0 && <span className="absolute top-0 -left-1 h-0.5 w-[calc(50%+0.25rem)] bg-current" />}
              {i < n - 1 && (
                <span className="absolute top-0 left-1/2 h-0.5 w-[calc(50%+0.25rem)] bg-current" />
              )}
              <Stub className={cell} />
            </div>
          ))}
        </div>
      </div>
      <p
        className={cn(
          'z-[2] mb-1.5 flex items-center gap-1 text-[11px] font-medium text-sky-700 dark:text-sky-400',
          fan.label,
        )}
      >
        {t('workflowGraph.inParallel')}
      </p>
      <div
        className={cn(
          'grid w-full grid-cols-1 rounded-lg border border-dashed border-sky-500/40 p-1.5',
          GAP,
          'gap-y-1.5',
          fan.grid,
          fan.box,
        )}
      >
        {steps.map((step) => (
          <div key={step.id} className="flex min-w-0 justify-center">
            <Node view={phaseView(step)} selected={selected} onSelect={onSelect} compact />
          </div>
        ))}
      </div>
      <div
        data-edge={after === null ? undefined : `join>${after}`}
        aria-hidden
        className={cn('relative h-11 w-full', LINE, fan.show)}
      >
        <div className={cn('absolute inset-x-0 top-0 h-6 grid', GAP, fan.grid)}>
          {cells.map((i) => (
            <div key={i} className="relative">
              {i > 0 && <span className="absolute bottom-0 -left-1 h-0.5 w-[calc(50%+0.25rem)] bg-current" />}
              {i < n - 1 && (
                <span className="absolute bottom-0 left-1/2 h-0.5 w-[calc(50%+0.25rem)] bg-current" />
              )}
              <span className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-current" />
            </div>
          ))}
        </div>
        <Stub className="absolute bottom-0 left-1/2 h-5 -translate-x-1/2" />
      </div>
      <div className={cn('flex w-full justify-center', fan.hide)}>
        <Edge from={steps.at(-1)!.id} to={after ?? 'end'} />
      </div>
    </div>
  )
}

type ResolvedReviewPhases = ResolvedReview['phases']

/** The id a row starts and ends at, for the arrows that join it to its neighbours. */
const rowId = (row: RoundRow, end: 'first' | 'last'): string =>
  row.kind === 'parallel'
    ? (end === 'first' ? row.steps[0]! : row.steps.at(-1)!).id
    : row.kind === 'frame'
      ? row.step.id
      : row.step.id

/** The rows of a round (or of one full review in it), one under the other, arrows between. */
function Rows({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly RoundRow[]
  selected: string | null
  onSelect: (id: string, byKeyboard: boolean) => void
}) {
  const pick = { selected, onSelect }
  const out: ReactNode[] = []
  rows.forEach((row, i) => {
    const prev = rows[i - 1]
    const next = rows[i + 1]
    // A row of parallel phases brings its own arrows in and out.
    if (prev && row.kind !== 'parallel' && prev.kind !== 'parallel')
      out.push(<Edge key={`e${i}`} from={rowId(prev, 'last')} to={rowId(row, 'first')} />)
    if (row.kind === 'node')
      out.push(<Node key={row.step.id} view={phaseView(row.step)} {...pick} compact className="max-w-72" />)
    else if (row.kind === 'parallel')
      out.push(
        <Parallel
          key={row.group + i}
          group={row.group}
          steps={row.steps}
          before={prev ? rowId(prev, 'last') : 'round'}
          after={next ? rowId(next, 'first') : null}
          {...pick}
        />,
      )
    else
      out.push(
        <section
          key={row.step.id}
          data-group={row.step.id}
          aria-label={row.step.label}
          className="relative flex w-full flex-col items-center rounded-xl border bg-background/50 px-2 pt-8 pb-3"
        >
          <p className="absolute top-2 left-3 text-[11px] font-medium text-muted-foreground">
            {row.step.label}
          </p>
          <Rows rows={row.rows} {...pick} />
        </section>,
      )
  })
  return <>{out}</>
}

/**
 * The review step's round: its phases in order, and, when a round does not survive, the fix pass and the gate
 * with the arrow that goes back up to the start of the round, labelled with the rounds the complexity gets.
 */
function Round({
  review,
  step,
  complexity,
  dim,
  selected,
  onSelect,
}: {
  review: ResolvedReview
  step: ResolvedStep
  complexity: Complexity
  dim: boolean
  selected: string | null
  onSelect: (id: string, byKeyboard: boolean) => void
}) {
  const { t } = useTranslation()
  const rows = roundRows(review.phases)
  const label = loopLabel(review.roundsByComplexity[complexity], complexity)
  const last = rows.at(-1)
  return (
    <section
      data-round={step.id}
      aria-label={t('workflowGraph.reviewRound')}
      className={cn(
        'relative flex w-full flex-col items-center rounded-2xl border border-dashed bg-muted/30 px-6 pt-10 pb-9 sm:px-7',
        dim && 'opacity-60',
      )}
    >
      <p className="absolute top-2.5 left-4 text-[11px] font-medium text-muted-foreground">
        {t('workflowGraph.reviewRound')}
      </p>
      <div className={cn('pointer-events-none absolute top-7 right-3 bottom-5 left-1/2 sm:right-4', LINE)}>
        <div
          data-edge="loop"
          aria-hidden
          className="absolute inset-0 rounded-r-2xl border-2 border-l-0 border-current"
        >
          <span className="absolute bottom-0 left-0 h-4 w-0.5 -translate-x-1/2 bg-current" />
          <Stub className="absolute top-0 left-0 h-3 -translate-x-1/2" />
        </div>
        <span
          data-loop-label
          className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-foreground"
        >
          {label}
        </span>
      </div>
      <Rows rows={rows} selected={selected} onSelect={onSelect} />
      {review.between[0] && (
        <Edge
          from={last ? rowId(last, 'last') : 'round'}
          to={review.between[0].id}
          label={t('workflowGraph.roundFails')}
        />
      )}
      {review.between.map((phase, i) => (
        <div key={phase.id} className="flex w-full flex-col items-center">
          {i > 0 && <Edge from={review.between[i - 1]!.id} to={phase.id} />}
          <Node
            view={phaseView(phase)}
            selected={selected}
            onSelect={onSelect}
            compact
            className="max-w-72"
          />
        </div>
      ))}
    </section>
  )
}
