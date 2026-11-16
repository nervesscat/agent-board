/**
 * The PR queue's choices and what its counters count, as pure predicates so the tabs, the chips and
 * the list cannot disagree: one function decides which rows a filter shows, and both the counter and
 * the chips count through it.
 */

/** The two sides of the queue: others' PRs for me to review, and mine waiting on others. */
export const PR_FILTERS = ['me', 'others'] as const
export type PrFilter = (typeof PR_FILTERS)[number]

/** A row's stage on GitHub (a hold or a merge overrides it), as `status` on the queue's rows. */
export const PR_STAGES = ['pending', 'reviewed', 'on_hold', 'done'] as const
export type PrStage = (typeof PR_STAGES)[number]

/**
 * The To review switch: every PR of that side, or only the ones whose review GitHub still asks of me
 * (`requested`, from its `review-requested:@me` search). Waiting on others has no switch.
 */
export const PR_REVIEWERS = ['all', 'mine'] as const
export type PrReviewer = (typeof PR_REVIEWERS)[number]

/**
 * The stages a counter adds up: a PR still waits on someone while it is pending or its comments are
 * on hold. A reviewed or merged one waits on nobody.
 */
export const WAITING_STAGES = ['pending', 'on_hold'] as const

/** What the queue reads of a row. */
export interface QueueRow {
  waitingOn: PrFilter
  status: PrStage
  requested: boolean
}

/** Whether the PR is on the filter's side of the queue. */
export const onSide = (row: Pick<QueueRow, 'waitingOn'>, filter: PrFilter) => row.waitingOn === filter

/** Whether the switch shows the PR: All PRs shows every one of the side, Just me only the requested ones. */
export const inReviewer = (row: Pick<QueueRow, 'requested'>, reviewer: PrReviewer) =>
  reviewer === 'all' || row.requested

/**
 * Whether a filter shows the PR: its side of the queue, narrowed by the switch where the switch
 * belongs. The two options are the whole In review list's narrowing, so Waiting on others always
 * shows every row of its side, whatever the switch says.
 */
export const inQueue = (row: QueueRow, filter: PrFilter, reviewer: PrReviewer) =>
  onSide(row, filter) && (filter !== 'me' || inReviewer(row, reviewer))

/** What a filter's counter says: the rows that still wait on someone, under the switch it shows. */
export const waitingCount = (rows: readonly QueueRow[], filter: PrFilter, reviewer: PrReviewer) =>
  WAITING_STAGES.reduce((count, stage) => count + stageCount(rows, filter, reviewer, stage), 0)

/** What a stage's chip counts: the rows the list shows under it. */
export const stageCount = (
  rows: readonly QueueRow[],
  filter: PrFilter,
  reviewer: PrReviewer,
  stage: PrStage,
) => rows.filter((row) => inQueue(row, filter, reviewer) && row.status === stage).length
