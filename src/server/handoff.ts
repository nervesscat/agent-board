import { listActors } from './actors'
import type { getTicketWithPush } from './features'
import { memo } from './cleanup'
import { committedAt } from './git'
import { currentRefs } from './listings'
import { isLocalUrl, previewState } from './preview'
import type { CiState } from './prs'
import type { Push } from './push'
import { ticketRepo } from './repos'
import type { RefsOf } from './resume'

/**
 * What a ticket handed to review still lacks: the parts of the hand-off the board can see for itself
 * (a PR, the branch on origin, a preview that runs, a hand-off post after the last commit, CI that is
 * not red). Warnings only: moving to review is never refused for them. Above them, whether the branch
 * is merged yet: merging is the human's step, so it is listed but never missing.
 */

/** Stable codes, for agents to act on; the text is for people. */
export type HandoffCode =
  | 'not_merged'
  | 'no_pr'
  | 'not_pushed'
  | 'no_preview'
  | 'no_handoff_post'
  | 'checks_unknown'

export interface HandoffCheck {
  code: HandoffCode
  /** The item as the ticket page's checklist names it. */
  label: string
  ok: boolean
  /** What was found, or what is missing. */
  text: string
}

export interface Handoff {
  /** The checks that failed, in checklist order; never `not_merged`, which waits on the human. */
  missing: { code: HandoffCode; text: string }[]
  /** Every item, met or not, Merged first; CI only when the PR has checks. */
  checks: HandoffCheck[]
}

/** What the checks go by, gathered from the ticket, git, the previews and the PR queue. */
export interface HandoffFacts {
  branch: string
  /**
   * The PR it was opened as (by prNumber or its branch), with CI from the PR queue when it is there,
   * and whether the queue saw it merged on GitHub.
   */
  pr: { number: number; ci: CiState | null; merged: boolean } | null
  push: Pick<Push, 'state' | 'ahead' | 'into'>
  /** Each workspace's preview: its link, and whether the board runs it or it answers. */
  previews: { url: string; running: boolean }[]
  /** When the branch's last commit was made; null without a branch, or when git cannot tell. */
  lastCommitAt: string | null
  /** What a hand-off post must come after when there is no commit to go by: when work last started. */
  since: string
  /** The ticket's own posts. */
  posts: { author: string; progress: boolean; handoff: boolean; createdAt: string }[]
  /** The names the human signs in under: their posts are not hand-offs. */
  humans: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const time = (iso: string) => Date.parse(iso)

/** The checklist for a ticket, from what is known about it. */
export function handoffOf(f: HandoffFacts): Handoff {
  const checks: HandoffCheck[] = []
  const check = (code: HandoffCode, label: string, ok: boolean, text: string) =>
    checks.push({ code, label, ok, text })

  const p = f.push
  check(
    'not_merged',
    'Merged',
    Boolean(f.pr?.merged) || p.state === 'merged',
    f.pr?.merged
      ? `PR #${f.pr.number} merged`
      : p.state === 'merged'
        ? `Merged into ${p.into ?? 'its base'}`
        : 'Not merged yet',
  )

  check(
    'no_pr',
    'PR',
    Boolean(f.pr),
    f.pr ? `PR #${f.pr.number}` : 'No PR: none set and none open on the branch',
  )

  check(
    'not_pushed',
    'Pushed',
    p.state === 'pushed' || p.state === 'merged' || p.state === 'remote-only',
    p.state === 'pushed'
      ? 'Branch pushed'
      : p.state === 'merged'
        ? `Merged into ${p.into ?? 'its base'}`
        : p.state === 'remote-only'
          ? 'On origin (no local branch)'
          : p.state === 'ahead'
            ? `${plural(p.ahead, 'commit')} not pushed`
            : p.state === 'local-only'
              ? 'Branch not on origin'
              : f.branch
                ? `Branch ${f.branch} not found`
                : 'No branch set',
  )

  const running = f.previews.find((v) => v.running)
  check(
    'no_preview',
    'Preview',
    Boolean(running),
    running
      ? `Running at ${running.url}`
      : f.previews.length
        ? 'Preview not running'
        : 'No preview: none started, or say in the hand-off post why it cannot be tried',
  )

  const after = f.lastCommitAt ?? f.since
  const post = f.posts.find(
    (u) => u.progress && !u.handoff && !f.humans.includes(u.author) && time(u.createdAt) >= time(after),
  )
  const since = f.lastCommitAt ? 'the last commit' : 'work started'
  check(
    'no_handoff_post',
    'Hand-off post',
    Boolean(post),
    post ? `Posted by ${post.author} after ${since}` : `No progress post since ${since}`,
  )

  const ci = f.pr?.ci
  if (ci === 'failing' || ci === 'pending')
    check(
      'checks_unknown',
      'CI',
      false,
      ci === 'failing' ? "The PR's CI is failing" : "The PR's CI is still running",
    )
  else if (ci === 'passing') check('checks_unknown', 'CI', true, "The PR's CI passed")

  // Merging is the human's step: a branch not merged yet is pending, not something the hand-off lacks.
  const missing = checks.filter((c) => !c.ok && c.code !== 'not_merged')
  return { missing: missing.map(({ code, text }) => ({ code, text })), checks }
}

type TicketWithPush = Awaited<ReturnType<typeof getTicketWithPush>>

/** Every running preview counts: one the board runs, or a link that answers (one off this machine is taken on trust). */
async function previewsOf(t: TicketWithPush): Promise<HandoffFacts['previews']> {
  return Promise.all(
    t.workspaces
      .filter((w) => w.previewUrl || w.managedPreview?.status === 'running')
      .map(async (w) => {
        const url = w.managedPreview?.url ?? w.previewUrl
        if (w.managedPreview?.status === 'running') return { url, running: true }
        if (!isLocalUrl(w.previewUrl)) return { url, running: true }
        return { url, running: (await previewState(w.previewUrl)).running }
      }),
  )
}

/** When a commit was made, by its sha: that never changes. */
const COMMITTED_MEMO_MAX = 2000
const committedMemo = new Map<string, Promise<string>>()

/**
 * When the branch's last commit was made (committer date): the local branch's head, else origin's, as
 * the repo's listing has them now. Null when it is on neither, or git cannot tell.
 */
async function lastCommitAt(repoPath: string, branch: string, refsOf: RefsOf): Promise<string | null> {
  const refs = await refsOf(repoPath)
  for (const sha of [refs?.local.get(branch), refs?.remote.get(branch)]) {
    if (!sha) continue
    const at = await memo(committedMemo, COMMITTED_MEMO_MAX, `${repoPath}\0${sha}`, () =>
      committedAt(repoPath, sha),
    ).catch(() => '')
    if (at) return at
  }
  return null
}

/**
 * The checklist for a ticket read with `getTicketWithPush` (its feed, workspaces, PR and push state).
 * `refsOf` is the read's own ref listing, when it has one.
 */
export async function ticketHandoff(t: TicketWithPush, refsOf: RefsOf = currentRefs): Promise<Handoff> {
  const repo = ticketRepo(t)
  const [previews, last] = await Promise.all([
    previewsOf(t),
    repo && t.branch ? lastCommitAt(repo.repoPath, t.branch, refsOf).catch(() => null) : null,
  ])
  return handoffOf({
    branch: t.branch,
    pr: t.pr
      ? { number: t.pr.number, ci: t.pr.queue?.ci ?? null, merged: t.pr.queue?.status === 'done' }
      : null,
    push: t.push,
    previews,
    lastCommitAt: last,
    since: t.startedAt ?? t.createdAt,
    posts: t.updates.filter((u) => u.ticketId === t.id),
    humans: listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : [])),
  })
}
