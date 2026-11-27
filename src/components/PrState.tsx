import { CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, GitMerge } from 'lucide-react'
import { cn } from 'cn'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

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

/** The texts of each state are `prState.merge.<state>` (label, title), `prState.ci.<state>` and `prState.review.<decision>`. */
const MERGE: Record<PrRow['merge'], { tone: Tone }> = {
  clean: { tone: 'good' },
  conflicts: { tone: 'bad' },
  behind: { tone: 'wait' },
  blocked: { tone: 'wait' },
  checking: { tone: 'muted' },
}

const CI: Record<PrRow['ci'], { tone: Tone; icon: ReactNode }> = {
  passing: { tone: 'good', icon: <CircleCheck data-icon="inline-start" /> },
  failing: { tone: 'bad', icon: <CircleX data-icon="inline-start" /> },
  pending: { tone: 'wait', icon: <Clock data-icon="inline-start" /> },
  none: { tone: 'muted', icon: <CircleDashed data-icon="inline-start" /> },
}

const REVIEW: Record<string, { tone: Tone }> = {
  APPROVED: { tone: 'good' },
  CHANGES_REQUESTED: { tone: 'bad' },
  REVIEW_REQUIRED: { tone: 'wait' },
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
function mergeTitle({ merge, mergeCheck: c }: Pick<State, 'merge' | 'mergeCheck'>, t: TFunction) {
  const title = t(`prState.merge.${merge}.title`)
  if (c.source === 'local')
    return c.at
      ? t('prState.checkedLocalAt', { title, base: c.base, when: stamp(c.at) })
      : t('prState.checkedLocal', { title, base: c.base })
  if (c.outdated)
    return c.at
      ? t('prState.outdatedAt', { base: c.base, when: stamp(c.at) })
      : t('prState.outdated', { base: c.base })
  return c.at ? t('prState.githubAt', { title, when: stamp(c.at) }) : t('prState.githubLast', { title })
}

/**
 * Where a PR stands on GitHub as of the last refresh: draft, merge state, CI, and the review
 * decision, with links to the checks that failed.
 */
export function PrState({ pr, className }: { pr: State; className?: string }) {
  const { t } = useTranslation()
  const merge = MERGE[pr.merge]
  const ci = CI[pr.ci]
  const review = pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined
  const count = (state: string) => pr.checks.filter((c) => c.state === state).length
  const failed = pr.checks.filter((c) => c.state === 'fail')
  const ciTitle = pr.checks.length
    ? t('prState.checks', {
        pass: count('pass'),
        failed: failed.length,
        pending: count('pending'),
        skipped: count('skipped'),
      })
    : t('prState.noChecks')
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)}>
      {pr.isDraft && <Pill tone="muted">{t('prState.draft')}</Pill>}
      <Pill tone={merge.tone} tip={mergeTitle(pr, t)}>
        <GitMerge data-icon="inline-start" />
        {t(`prState.merge.${pr.merge}.label`)}
      </Pill>
      <Pill tone={ci.tone} tip={ciTitle}>
        {ci.icon}
        {t(`prState.ci.${pr.ci}`)}
        {pr.ci === 'pending' && ` · ${count('pending')}`}
      </Pill>
      {review && pr.reviewDecision && (
        <Pill tone={review.tone}>
          {t(`prState.review.${pr.reviewDecision as 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'}`)}
        </Pill>
      )}
      {failed.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          {t('prState.failed')}
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
  const { t } = useTranslation()
  const problems = [
    pr.merge === 'conflicts' && t('prState.mergeConflicts'),
    pr.ci === 'failing' && t('prState.ci.failing'),
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
