import { cn } from 'cn'
import { Check } from 'lucide-react'
import { toast } from 'sonner'

import type { Handoff, Reach, TicketFull, TicketGit } from '#/lib/api'

type HandoffCheck = Handoff['checks'][number]

const REACHED: Record<Exclude<Reach['state'], 'unique'>, string> = {
  merged: 'Merged into',
  rebased: 'Rebased into',
  edited: 'Squashed or edited into',
}

/**
 * The Merged item, with what the page's git state adds: a branch whose work reached its base counts as
 * merged too (a merge the PR queue has not seen yet, or one into a local base). Only into the ticket's
 * own base, local or origin's: reach is the best verdict over the whole base chain (a lane's parents'
 * bases, the repo's), and work that reached one of those (a backport whose fix is already on main) is
 * not this PR merged. Only with a PR: a branch with no commits of its own sits in its base as well.
 * And only when the branch reach was read from holds the PR's commits: origin has a copy of the branch
 * and the local branch has all of it (pushed, or ahead), or there is only origin's (remote-only), which
 * reach then reads. Reach reads the local branch first, so one left behind (the PR's commits pushed
 * from elsewhere), or one whose copy on origin is gone (the PR closed and its branch deleted), would
 * answer for commits that are not the PR's.
 */
function withReach(c: HandoffCheck, git: TicketGit | undefined, pr: TicketFull['pr']): HandoffCheck {
  const reach = git?.info.reach
  if (c.code !== 'not_merged' || c.ok || !pr || !reach || reach.state === 'unique') return c
  const base = git.baseBranch
  if (!base || (reach.into !== base && reach.into !== `origin/${base}`)) return c
  const { state, behind } = git.info.push
  const holdsOrigin = state === 'remote-only' || ((state === 'pushed' || state === 'ahead') && !behind)
  if (!holdsOrigin) return c
  return { ...c, ok: true, text: `${REACHED[reach.state]} ${reach.into}` }
}

/**
 * The hand-off checklist of a ticket in review, as the board sees it: a green tick per item that is
 * there, an amber dot per item that is missing, a hollow dot while the branch waits to be merged (the
 * human's step), what was found in each item's line. Every item there, merged too: a green border.
 */
export function HandoffCard({
  handoff,
  git,
  pr,
}: {
  handoff: Handoff
  /** The ticket's git state, when the page has it. */
  git?: TicketGit
  pr: TicketFull['pr']
}) {
  const missing = handoff.missing.length
  const checks = handoff.checks.map((c) => withReach(c, git, pr))
  const done = checks.every((c) => c.ok)
  return (
    <section
      className={cn('rounded-lg border p-3', done && 'border-emerald-500/60 dark:border-emerald-400/60')}
      aria-label="Hand-off"
    >
      <h2 className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        Hand-off
        <span
          className={
            missing
              ? 'text-xs font-normal text-amber-700 dark:text-amber-400'
              : 'text-xs font-normal text-emerald-700 dark:text-emerald-400'
          }
        >
          {missing ? `${missing} missing` : 'complete'}
        </span>
      </h2>
      <ul className="space-y-1.5 text-xs">
        {checks.map((c) => (
          <li key={c.code} data-code={c.code} data-ok={c.ok} className="flex items-start gap-2">
            {c.ok ? (
              <Check
                role="img"
                aria-label="done"
                className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            ) : c.code === 'not_merged' ? (
              <span
                role="img"
                aria-label="pending"
                className="flex size-3.5 shrink-0 items-center justify-center"
              >
                <span className="size-2 rounded-full border border-muted-foreground" />
              </span>
            ) : (
              <span
                role="img"
                aria-label="missing"
                className="flex size-3.5 shrink-0 items-center justify-center"
              >
                <span className="size-2 rounded-full bg-amber-500" />
              </span>
            )}
            <span className="min-w-0">
              <span className="font-medium">{c.label}</span>
              <span className="block break-words text-muted-foreground">{c.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** After a move to review: what the hand-off still lacks, as a warning that does not undo the move. */
export function toastHandoff(res: unknown) {
  const handoff = (res as { handoff?: Handoff } | null)?.handoff
  if (!handoff?.missing.length) return
  toast.warning('In review, but the hand-off lacks:', {
    description: handoff.missing.map((m) => m.text).join('; '),
    duration: 10_000,
  })
}
