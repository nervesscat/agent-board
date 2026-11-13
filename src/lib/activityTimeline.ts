import type { StageKind } from './constants'
import type { StageLike } from './stages'
import type { WorkTimelineLike } from './workStatus'
import type { Activity, Stalled } from './workTimeline'

/**
 * The Overview's and the board's view of a ticket's work. Their rows carry the ticket's `activity` (its open
 * spans and waits, and who was last heard from) and its `stalled`, not a full timeline; these build the
 * timeline the shared answers (`currentActivity`, `stallReason`, the components) read, from those alone.
 * An activity carries only the span that ended last: a stall with nothing open is dated by its ended work.
 */

/** A timeline as far as an activity says: its open spans and waits, the last heard, and the stall. */
export function timelineFromActivity(
  activity: Activity | null | undefined,
  stalled: Stalled | null | undefined,
  live = true,
): WorkTimelineLike {
  return {
    spans: [
      ...(activity?.spans ?? []).map((s, i) => ({
        id: i,
        phase: s.phase,
        round: null,
        agent: s.agent,
        by: '',
        start: s.since,
        end: s.since,
        open: true,
      })),
      // The span that ended last, so a stall with nothing open is dated by when its work ended.
      ...(activity?.lastClosedSpan
        ? [
            {
              id: -1,
              phase: activity.lastClosedSpan.phase,
              round: null,
              agent: activity.lastClosedSpan.agent,
              by: '',
              start: activity.lastClosedSpan.start,
              end: activity.lastClosedSpan.end,
              open: false,
            },
          ]
        : []),
    ],
    waits: (activity?.waits ?? []).map((w, i) => ({
      id: i,
      reason: w.reason,
      agent: w.agent,
      on: w.on,
      note: '',
      start: w.since,
      end: w.since,
      open: true,
    })),
    totals: { workingMs: 0, waitingMs: 0, blockedOnHumanMs: 0 },
    stalled: stalled ?? null,
    live,
    start: null,
    end: null,
    lastHeard: activity?.lastHeard ?? null,
    now: activity?.now,
    liveness: activity?.liveness ?? null,
    // The other facts the one work-state line reads, carried beside the activity by the same read.
    stage: activity?.stage,
    progressAt: activity?.progressAt ?? null,
    waitingOnHuman: activity?.waitingOnHuman ?? false,
  }
}

/** Whether a stage's kind has work to show: open, done and cancelled stages have none. */
export const hasWork = (kind: StageKind) => kind === 'active' || kind === 'blocked' || kind === 'review'

/**
 * The stage a stall names when it is not the project's first active stage (where work is claimed by default),
 * else null: the why then says "in Review, no agent heard from since ...".
 */
export function stallStage(stages: StageLike[], status: string): string | null {
  const first = stages.find((s) => s.kind === 'active')
  const stage = stages.find((s) => s.key === status)
  if (!stage || !first || stage.key === first.key) return null
  return stage.name
}
