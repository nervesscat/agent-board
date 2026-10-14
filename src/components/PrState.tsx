import { CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, GitMerge } from 'lucide-react'
import { cn } from 'cn'
import type { ReactNode } from 'react'

import { Badge } from '#/components/ui/badge'
import { Tip } from '#/components/ui/tooltip'
import type { PrRow } from '#/lib/api'
import { stamp } from '#/lib/format'

type Tone = 'good' | 'wait' | 'bad' | 'muted'

const TONE: Record<Tone, { variant: 'secondary' | 'destructive' | 'outline'; className: string }> = {
  good: { variant: 'secondary', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  wait: { variant: 'secondary', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  bad: { variant: 'destructive', className: '' },
  muted: { variant: 'outline', className: 'text-muted-foreground' },
}

const MERGE: Record<PrRow['merge'], { label: string; title: string; tone: Tone }> = {
  clean: { label: 'mergeable', title: 'No conflicts with the base.', tone: 'good' },
  conflicts: {
    label: 'conflicts',
    title: 'Conflicts with the base branch: it needs a rebase or a merge before it can land.',
    tone: 'bad',
  },
  behind: {
    label: 'behind base',
    title: 'The base moved on and branch protection wants the branch up to date first.',
    tone: 'wait',
  },
  blocked: {
    label: 'blocked',
    title: 'Branch protection: a required review or check is still missing.',
    tone: 'wait',
  },
  checking: {
    label: 'checking',
    title: 'GitHub is still working out whether it merges (usually right after a push). Refresh in a moment.',
    tone: 'muted',
  },
}

const CI: Record<PrRow['ci'], { label: string; tone: Tone; icon: ReactNode }> = {
  passing: { label: 'CI passing', tone: 'good', icon: <CircleCheck data-icon="inline-start" /> },
  failing: { label: 'CI failing', tone: 'bad', icon: <CircleX data-icon="inline-start" /> },
  pending: { label: 'CI running', tone: 'wait', icon: <Clock data-icon="inline-start" /> },
  none: { label: 'no CI', tone: 'muted', icon: <CircleDashed data-icon="inline-start" /> },
}

const REVIEW: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: 'approved', tone: 'good' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'bad' },
  REVIEW_REQUIRED: { label: 'review required', tone: 'wait' },
}

/** One state as a badge, with `tip` as its tooltip if it has one. */
function Pill({ tone, tip, children }: { tone: Tone; tip?: string; children: ReactNode }) {
  return (
    <Tip content={tip}>
      <Badge variant={TONE[tone].variant} className={TONE[tone].className}>
        {children}
      </Badge>
    </Tip>
  )
}

type State = Pick<PrRow, 'merge' | 'mergeCheck' | 'ci' | 'checks' | 'reviewDecision' | 'isDraft'>

/** The merge chip's hover: what the state means, and where it came from and when. */
function mergeTitle({ merge, mergeCheck: c }: Pick<State, 'merge' | 'mergeCheck'>) {
  const when = c.at ? `, ${stamp(c.at)}` : ''
  if (c.source === 'local') return `${MERGE[merge].title} Checked here against origin/${c.base}${when}.`
  if (c.outdated)
    return `origin/${c.base} moved after GitHub's word${c.at ? ` of ${stamp(c.at)}` : ''}: waiting for GitHub to look again.`
  return `${MERGE[merge].title} GitHub's word as of ${c.at ? stamp(c.at) : 'the last refresh'}.`
}

/**
 * Where a PR stands on GitHub as of the last refresh: draft, merge state, CI, and the review
 * decision, with links to the checks that failed.
 */
export function PrState({ pr, className }: { pr: State; className?: string }) {
  const merge = MERGE[pr.merge]
  const ci = CI[pr.ci]
  const review = pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined
  const count = (state: string) => pr.checks.filter((c) => c.state === state).length
  const failed = pr.checks.filter((c) => c.state === 'fail')
  const ciTitle = pr.checks.length
    ? `${count('pass')} passed · ${failed.length} failed · ${count('pending')} running · ${count('skipped')} skipped`
    : 'No checks on the head commit.'
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)}>
      {pr.isDraft && <Pill tone="muted">draft</Pill>}
      <Pill tone={merge.tone} tip={mergeTitle(pr)}>
        <GitMerge data-icon="inline-start" />
        {merge.label}
      </Pill>
      <Pill tone={ci.tone} tip={ciTitle}>
        {ci.icon}
        {ci.label}
        {pr.ci === 'pending' && ` · ${count('pending')}`}
      </Pill>
      {review && <Pill tone={review.tone}>{review.label}</Pill>}
      {failed.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          failed:
          {failed.map((c, i) =>
            c.url ? (
              <a
                key={i}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="text-destructive hover:underline"
              >
                {c.name}
              </a>
            ) : (
              <span key={i} className="text-destructive">
                {c.name}
              </span>
            ),
          )}
        </span>
      )}
    </div>
  )
}

/** A red mark for a list row whose PR has conflicts or failing CI; nothing otherwise. */
export function PrAlert({ pr }: { pr: Pick<PrRow, 'merge' | 'ci'> }) {
  const problems = [
    pr.merge === 'conflicts' && 'merge conflicts',
    pr.ci === 'failing' && 'CI failing',
  ].filter(Boolean)
  if (!problems.length) return null
  return (
    <Tip content={problems.join(' · ')}>
      <span className="inline-flex shrink-0 text-destructive">
        <CircleAlert className="size-3.5" aria-label={problems.join(', ')} />
      </span>
    </Tip>
  )
}
