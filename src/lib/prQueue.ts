/**
 * The PR queue's choices and what its counters count, as pure predicates so the tabs, the chips and
 * the list cannot disagree: one function decides which rows a filter shows, and both the counter and
 * the chips count through it.
 */

/**
 * The queue's choices: others' PRs for me to review (`me`), mine waiting on others (`others`), and
 * every open PR of the repos, whoever wrote it and involving me or not (`all`).
 */
export const PR_FILTERS = ['me', 'others', 'all'] as const
export type PrFilter = (typeof PR_FILTERS)[number]

/** The two sides a PR waits on; `waitingOn` is one of them, never `all`. */
export type PrSide = Exclude<PrFilter, 'all'>

/** A row's stage on GitHub (a hold or a merge overrides it), as `status` on the queue's rows. */
export const PR_STAGES = ['pending', 'reviewed', 'on_hold', 'done'] as const
export type PrStage = (typeof PR_STAGES)[number]

/**
 * The To review switch: every PR of that side that involves me (shown as Involving me), or only the
 * ones whose review GitHub still asks of me (`requested`, from its `review-requested:@me` search).
 * Waiting on others and All PRs have no switch.
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
  waitingOn: PrSide
  status: PrStage
  requested: boolean
  /** One of my searches found it (authored, review requested, reviewed, assigned). */
  involvesMe: boolean
}

/** Whether the PR involves me and is on the side's of the queue. */
export const onSide = (row: Pick<QueueRow, 'waitingOn' | 'involvesMe'>, side: PrSide) =>
  row.involvesMe && row.waitingOn === side

/** Whether the switch shows the PR: Involving me shows every one of the side, Just me only the requested ones. */
export const inReviewer = (row: Pick<QueueRow, 'requested'>, reviewer: PrReviewer) =>
  reviewer === 'all' || row.requested

/**
 * Whether a filter shows the PR. All PRs: every open one, whatever the switch says. A side: the PRs
 * of mine on it, narrowed by the switch where the switch belongs (To review only), so Waiting on
 * others always shows every row of its side. A merged PR is in no queue stage but Done, which only
 * the sides have.
 */
export const inQueue = (row: QueueRow, filter: PrFilter, reviewer: PrReviewer) =>
  filter === 'all'
    ? row.status !== 'done'
    : onSide(row, filter) && (filter !== 'me' || inReviewer(row, reviewer))

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
