import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  Bookmark,
  BookmarkX,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  GitPullRequest,
  Hand,
  Hourglass,
  Inbox,
  Layers,
  ListTodo,
  MessageSquare,
  Play,
  Scale,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Actor, ClaimedActor } from '#/components/Actor'
import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
import { GettingStarted } from '#/components/GettingStarted'
import { useSettleInstructions } from '#/components/InstructionsHistory'
import { BlockedTasksBadge, DecisionBadge, Progress } from '#/components/TicketBoard'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { cn } from 'cn'
import { Skeleton } from '#/components/ui/skeleton'
import { Tip } from '#/components/ui/tooltip'
import { StalledBadge } from '#/components/WorkTimeline'
import { threadAnchor } from '#/lib/anchors'
import type { AreaId } from '#/lib/layout'
import { errorMessage, get, type CarryOver, type ProjectSummary, type Summary as Payload } from '#/lib/api'
import { ago, clock } from '#/lib/format'
import { stageBadge, stageOf } from '#/lib/stages'
import { formatDuration } from '#/lib/workTimeline'

/**
 * Where things stand, for one project (its Overview) or every project (Home, one block each): what
 * waits on the human, what is in progress, what got done today, what is next, and what carries over
 * from before today. Refreshed every 30 seconds while the page is visible.
 */
export function Summary({ projectId }: { projectId?: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['summary', projectId ?? 'all'],
    queryFn: () => get<Payload>(`/api/summary${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: 30_000,
  })
  if (isLoading)
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    )
  if (error || !data) return <Empty>Could not load the summary: {errorMessage(error)}</Empty>
  if (!data.projects.length) return <GettingStarted />
  if (projectId) return <ProjectBlock p={data.projects[0]!} />
  return (
    <div className="space-y-10">
      {/* The top bar's Getting started entry folds into the Pages menu on a phone, which leads here. */}
      <div className="empty:hidden md:hidden">
        <GettingStarted dismissable />
      </div>
      {data.projects.map((p) => (
        <section key={p.project.id} className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              <Tip content={`${p.project.name}: overview`}>
                <Link to="/projects/$id" params={{ id: String(p.project.id) }} className="hover:underline">
                  {p.project.name}
                </Link>
              </Tip>
            </h2>
            <span className="text-xs text-muted-foreground">{headline(p)}</span>
          </div>
          <ProjectBlock p={p} />
        </section>
      ))}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The block's counts in one line, beside the project's name on Home. */
const headline = (p: ProjectSummary) =>
  [
    p.needsYou.total ? `${p.needsYou.total} waiting on you` : null,
    `${p.inProgress.length} in progress`,
    `${p.doneToday.tickets.length} done today`,
  ]
    .filter(Boolean)
    .join(' · ')

/** Each card of the block; which show and in what order is the project's layout. */
const CARDS: Record<AreaId<'overview'>, (props: { p: ProjectSummary }) => ReactNode> = {
  'overview.needsYou': NeedsYou,
  'overview.inProgress': InProgress,
  'overview.doneToday': DoneToday,
  'overview.next': Next,
  'overview.carryingOver': CarryingOver,
}

function ProjectBlock({ p }: { p: ProjectSummary }) {
  if (!p.project.overview.length)
    return (
      <Empty>
        Every card of this overview is hidden.{' '}
        <Link
          to="/projects/$id/settings"
          params={{ id: String(p.project.id) }}
          hash="layout"
          className="underline"
        >
          Show them again in the layout settings
        </Link>
        .
      </Empty>
    )
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {p.project.overview.map((card) => {
        const Shown = CARDS[card]
        return <Shown key={card} p={p} />
      })}
    </div>
  )
}

// --- building blocks ---

function Section({
  icon: Icon,
  title,
  count,
  extra,
  className = '',
  scroll = false,
  children,
}: {
  icon: typeof Inbox
  title: string
  count?: number
  /** After the count: what among them needs attention. */
  extra?: ReactNode
  className?: string
  /** A fixed height (a cap on a phone) with the content scrolling under the header. */
  scroll?: boolean
  children: ReactNode
}) {
  return (
    <Card size="sm" className={cn(scroll && 'max-h-[28rem] lg:h-[28rem]', className)}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon className="size-4 text-muted-foreground" /> {title}
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
          {extra}
        </CardTitle>
      </CardHeader>
      <CardContent
        data-scroll={scroll ? '' : undefined}
        className={cn('space-y-3', scroll && 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-2')}
      >
        {children}
      </CardContent>
    </Card>
  )
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

/** One line of a section: an icon, what it is (usually a link), and the details under it. */
function Row({
  icon,
  title,
  meta,
  side,
}: {
  icon?: ReactNode
  title: ReactNode
  meta?: ReactNode
  side?: ReactNode
}) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      {icon && <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-snug">{title}</div>
        {meta && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      {side && <div className="flex shrink-0 items-center gap-1.5">{side}</div>}
    </li>
  )
}

const Rows = ({ children }: { children: ReactNode }) => <ul className="space-y-3">{children}</ul>

function TicketLink({ p, id, title, hash }: { p: ProjectSummary; id: number; title: string; hash?: string }) {
  return (
    <Link
      to="/projects/$id/features/$ticketId"
      params={{ id: String(p.project.id), ticketId: String(id) }}
      hash={hash}
      className="hover:underline"
    >
      <span className="text-muted-foreground">#{id}</span> {title}
    </Link>
  )
}

/** Who holds it: one of the project's agents with its picture, anyone else as the board shows them. */
function Who({ p, name }: { p: ProjectSummary; name: string }) {
  if (!name) return <span>unassigned</span>
  const agent = p.agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
  if (!agent) return <Actor name={name} />
  return (
    <Tip content={`${agent.name} (one of the project's agents)`}>
      <span className="inline-flex items-center gap-1 font-medium">
        <AgentAvatar agent={agent} />
        {agent.name}
      </span>
    </Tip>
  )
}

function StageBadge({ p, status }: { p: ProjectSummary; status: string }) {
  const stage = stageOf(p.stages, status)
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] leading-none font-medium ${stageBadge(stage)}`}>
      {stage.name}
    </span>
  )
}

/** "since 09:40" today, "since Tue 3" this week, "since Sep 28" before. */
function since(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `since ${clock(iso)}`
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 6) return `since ${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`
  return `since ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

function LastPost({ post }: { post: CarryOver['lastPost'] }) {
  if (!post) return null
  return (
    <p className="mt-1 line-clamp-2 border-l-2 pl-2 text-xs text-muted-foreground">
      {post.text}{' '}
      <span className="whitespace-nowrap">
        — {post.author}, {ago(post.createdAt)}
      </span>
    </p>
  )
}

/** Whole minutes since `since`: the summary carries the moment, the page counts up to now. */
const silentMinutes = (since: string) => Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000))

/** A stalled ticket's details, from the Needs you list that names it. */
function stalledOf(p: ProjectSummary, id: number) {
  const s = p.needsYou.stalled.find((x) => x.ticketId === id)
  return s
    ? {
        since: s.lastSignalAt,
        minutes: silentMinutes(s.lastSignalAt),
        lastAgent: s.lastAgent,
        lastBy: s.lastBy,
        lastFrom: s.lastFrom,
      }
    : null
}

function Stale() {
  return (
    <Tip content="No progress post in over 24 hours">
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] leading-none font-medium text-amber-700 dark:text-amber-400">
        <Hourglass className="size-3" /> stale
      </span>
    </Tip>
  )
}

// --- the sections ---

function NeedsYou({ p }: { p: ProjectSummary }) {
  const { decisions, prs, threads, reviews, blockedTasks, instructionChanges, stalled, total } = p.needsYou
  const pid = String(p.project.id)
  const settle = useSettleInstructions(pid)
  return (
    <Section icon={Inbox} title="Needs you" count={total} scroll>
      {!total ? (
        <Quiet>Nothing waiting on you.</Quiet>
      ) : (
        <Rows>
          {decisions.map((d) => (
            <Row
              key={`d${d.postId}`}
              icon={<Scale className="text-amber-600 dark:text-amber-400" />}
              title={
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: pid, ticketId: String(d.ticketId) }}
                  hash={`post-${d.postId}`}
                  className="hover:underline"
                >
                  Decide: {d.question}
                </Link>
              }
              meta={
                <>
                  <span className="truncate">
                    {d.prTicket ? d.ticketTitle : `#${d.ticketId} ${d.ticketTitle}`}
                  </span>
                  <span>
                    {plural(d.options, 'option')} · asked by {d.author} {ago(d.createdAt)}
                  </span>
                </>
              }
            />
          ))}
          {prs.map((pr) => (
            <Row
              key={`p${pr.id}`}
              icon={<GitPullRequest />}
              title={
                <Link
                  to="/projects/$id/prs"
                  params={{ id: pid }}
                  hash={`pr-${pr.id}`}
                  className="hover:underline"
                >
                  Review PR #{pr.number} {pr.title}
                </Link>
              }
              meta={
                <>
                  {pr.repo && <span className="rounded bg-muted px-1">{pr.repo}</span>}
                  {pr.isDraft && <span>draft</span>}
                  <span>
                    by {pr.author} · updated {ago(pr.updatedAt)}
                  </span>
                </>
              }
              side={
                <Tip content="Open on GitHub">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Open on GitHub"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </Tip>
              }
            />
          ))}
          {threads.map((th) => (
            <Row
              key={`t${th.parentType}${th.parentId}`}
              icon={<MessageSquare />}
              title={
                th.ticketId !== null ? (
                  <Link
                    to="/projects/$id/features/$ticketId"
                    params={{ id: pid, ticketId: String(th.ticketId) }}
                    hash={threadAnchor(th)}
                    className="hover:underline"
                  >
                    {th.parentType === 'ticket' && !th.prTicket ? `#${th.ticketId} ${th.title}` : th.title}
                  </Link>
                ) : (
                  <Link
                    to="/projects/$id/prs"
                    params={{ id: pid }}
                    search={th.parentType === 'review' ? { result: th.parentId } : {}}
                    hash={threadAnchor(th)}
                    className="hover:underline"
                  >
                    {th.title}
                  </Link>
                )
              }
              meta={
                <>
                  <span className="min-w-0 truncate">
                    {th.last.author}: {th.last.text}
                  </span>
                  <span className="shrink-0">
                    {th.waiting > 1 ? `${th.waiting} new · ` : ''}
                    {ago(th.last.createdAt)}
                  </span>
                </>
              }
            />
          ))}
          {blockedTasks.map((task) => (
            <Row
              key={`b${task.taskId}`}
              icon={<Hand className="text-amber-600 dark:text-amber-400" />}
              title={
                <span>
                  <span className="mr-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                    blocked
                  </span>
                  {task.parentTask && <span className="text-muted-foreground">{task.parentTask} › </span>}
                  {task.text}
                  {task.reason && <span className="text-muted-foreground">: {task.reason}</span>}
                </span>
              }
              meta={
                <>
                  <span className="truncate">
                    <TicketLink
                      p={p}
                      id={task.ticketId}
                      title={task.ticketTitle}
                      hash={`task-${task.taskId}`}
                    />
                  </span>
                  {task.parent && <span className="truncate">lane of #{task.parent.id}</span>}
                </>
              }
            />
          ))}
          {instructionChanges.map((c) => (
            <Row
              key={`i${c.changeId}`}
              icon={<FileText className="text-amber-600 dark:text-amber-400" />}
              title={
                <span>
                  <Link
                    to="/projects/$id/settings"
                    params={{ id: pid }}
                    hash="instructions-history"
                    className="hover:underline"
                  >
                    Project instructions changed
                  </Link>{' '}
                  by <Actor name={c.changedBy} />
                </span>
              }
              meta={
                <>
                  {c.excerpt && <span className="min-w-0 truncate">{c.excerpt}</span>}
                  <span className="shrink-0">{ago(c.createdAt)}</span>
                  <span className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={settle.isPending}
                      onClick={() => settle.mutate({ id: c.changeId, action: 'review' })}
                    >
                      Reviewed
                    </Button>
                    <Tip
                      content={
                        c.revertable
                          ? 'Put the instructions back as they were before this change'
                          : 'The instructions changed again since: revert the later change first'
                      }
                    >
                      <span className="inline-flex">
                        <Button
                          type="button"
                          variant="destructive"
                          size="xs"
                          disabled={settle.isPending || !c.revertable}
                          onClick={() => settle.mutate({ id: c.changeId, action: 'revert' })}
                        >
                          Revert
                        </Button>
                      </span>
                    </Tip>
                  </span>
                </>
              }
            />
          ))}
          {stalled.map((s) => (
            <Row
              key={`s${s.ticketId}`}
              icon={<AlertTriangle className="text-amber-600 dark:text-amber-400" />}
              title={
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: pid, ticketId: String(s.ticketId) }}
                  className="hover:underline"
                >
                  Stalled: #{s.ticketId} {s.title}
                </Link>
              }
              meta={
                <>
                  <StageBadge p={p} status={s.status} />
                  {s.parent && <span className="truncate">lane of #{s.parent.id}</span>}
                  <Tip content={`No heartbeat or event since ${clock(s.lastSignalAt)}`}>
                    <span className="min-w-0">
                      silent {formatDuration(silentMinutes(s.lastSignalAt) * 60_000)}
                      {s.lastAgent && (
                        <>
                          {' · last '}
                          {s.lastFrom === 'assignee' ? (
                            // No event named anyone: the assignee, which nobody signed in recorded, so no badge.
                            <span data-testid="last-assignee" className="font-medium wrap-anywhere">
                              {s.lastAgent}
                            </span>
                          ) : (
                            <ClaimedActor name={s.lastAgent} by={s.lastBy} />
                          )}
                        </>
                      )}
                    </span>
                  </Tip>
                </>
              }
            />
          ))}
          {reviews.map((t) => (
            <Row
              key={`r${t.id}`}
              icon={<Eye />}
              title={<TicketLink p={p} id={t.id} title={t.title} hash="tasks" />}
              meta={
                <>
                  <StageBadge p={p} status={t.status} />
                  {t.parent && <span className="truncate">lane of #{t.parent.id}</span>}
                  {t.assignee && <Who p={p} name={t.assignee} />}
                  {t.prNumber && <span>PR #{t.prNumber}</span>}
                  <span>{ago(t.updatedAt)}</span>
                </>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  )
}

function InProgress({ p }: { p: ProjectSummary }) {
  const items = p.inProgress
  return (
    <Section icon={Play} title="In progress" count={items.length} scroll>
      {!items.length ? (
        <Quiet>Nothing in progress.</Quiet>
      ) : (
        <Rows>
          {items.map((t) => (
            <Row
              key={t.id}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
              side={
                <>
                  {t.kind === 'blocked' && <StageBadge p={p} status={t.status} />}
                  {t.stalled && <StalledBadge stalled={stalledOf(p, t.id)} />}
                  {t.stale && <Stale />}
                </>
              }
              meta={
                <div className="w-full min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Who p={p} name={t.assignee} />
                    <Tip content={new Date(t.since).toLocaleString()}>
                      <span>{since(t.since)}</span>
                    </Tip>
                    {t.lanes > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Layers className="size-3" /> {plural(t.lanes, 'lane')}
                      </span>
                    )}
                    {t.decisions > 0 && <DecisionBadge n={t.decisions} />}
                    {t.blockedTasks > 0 && <BlockedTasksBadge n={t.blockedTasks} />}
                    {t.preview && (
                      <Tip content={`Preview of ${t.preview.workspace}`}>
                        <a
                          href={t.preview.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-foreground hover:underline"
                        >
                          <ExternalLink className="size-3" /> Preview
                        </a>
                      </Tip>
                    )}
                  </div>
                  {t.rollup.total > 0 && <Progress rollup={t.rollup} className="mt-1.5" />}
                  <LastPost post={t.lastPost} />
                </div>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  )
}

function DoneToday({ p }: { p: ProjectSummary }) {
  const { tickets, prs, activity } = p.doneToday
  return (
    <Section icon={CheckCircle2} title="Done today" count={tickets.length + prs.length}>
      {!tickets.length && !prs.length ? (
        <Quiet>Nothing finished yet today.</Quiet>
      ) : (
        <Rows>
          {tickets.map((t) => (
            <Row
              key={`t${t.id}`}
              icon={<CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
              meta={
                <>
                  {t.parent && <span className="truncate">lane of #{t.parent.id}</span>}
                  {t.assignee && <Who p={p} name={t.assignee} />}
                  <span>{clock(t.doneAt)}</span>
                </>
              }
            />
          ))}
          {prs.map((pr) => (
            <Row
              key={`p${pr.id}`}
              icon={<GitPullRequest className="text-violet-600 dark:text-violet-400" />}
              title={
                <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
                  PR #{pr.number} {pr.title}
                </a>
              }
              meta={
                <>
                  {pr.repo && <span className="rounded bg-muted px-1">{pr.repo}</span>}
                  <Tip content="Merged or closed: it left the review queue">
                    <span>closed {clock(pr.closedAt)}</span>
                  </Tip>
                  {pr.tickets.map((t) => (
                    <TicketLink key={t.id} p={p} id={t.id} title={t.title} />
                  ))}
                </>
              }
            />
          ))}
        </Rows>
      )}
      <Link
        to="/projects/$id/daily"
        params={{ id: String(p.project.id) }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {plural(activity, 'thing')} happened today: Daily <ArrowRight className="size-3" />
      </Link>
    </Section>
  )
}

function Next({ p }: { p: ProjectSummary }) {
  const { stage, tickets, total, blocked, backlog } = p.next
  const pid = String(p.project.id)
  return (
    <Section icon={ListTodo} title={stage ? `Next: ${stage.name}` : 'Next'} count={total}>
      {!tickets.length ? (
        <Quiet>Nothing lined up{stage ? ` in ${stage.name}` : ''}.</Quiet>
      ) : (
        <Rows>
          {tickets.map((t) => (
            <Row
              key={t.id}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
              meta={
                (t.assignee || t.rollup.total > 0) && (
                  <>
                    {t.assignee && <Who p={p} name={t.assignee} />}
                    {t.rollup.total > 0 && (
                      <span className="tabular-nums">
                        {t.rollup.done}/{t.rollup.total} tasks
                      </span>
                    )}
                  </>
                )
              }
            />
          ))}
        </Rows>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {total > tickets.length && <span>{total - tickets.length} more</span>}
        {blocked > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3" /> {blocked} blocked
          </span>
        )}
        <span>{backlog} in the backlog</span>
        <Link
          to="/projects/$id/features"
          params={{ id: pid }}
          className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
        >
          Board <ArrowRight className="size-3" />
        </Link>
      </div>
    </Section>
  )
}

function CarryingOver({ p }: { p: ProjectSummary }) {
  const items = p.carryingOver
  const missing = items.filter((t) => t.resume.noHandoff).length
  return (
    <Section
      icon={Clock}
      title="Carrying over"
      count={items.length}
      extra={
        missing > 0 && (
          <Tip content="Worked on an earlier day, and nobody left a resume note on where it was left">
            <span className="inline-flex items-center gap-1 text-xs font-normal text-amber-700 dark:text-amber-400">
              <BookmarkX className="size-3" /> {missing} without a handoff
            </span>
          </Tip>
        )
      }
      className="lg:col-span-2"
    >
      {!items.length ? (
        <Quiet>Nothing carried over from before today.</Quiet>
      ) : (
        <Rows>
          {items.map((t) => (
            <Row
              key={t.id}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
              side={
                <>
                  <StageBadge p={p} status={t.status} />
                  {t.stale && <Stale />}
                </>
              }
              meta={
                <div className="w-full min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Who p={p} name={t.assignee} />
                    <Tip content={`Work on it started ${new Date(t.since).toLocaleString()}`}>
                      <span>{t.days ? `${plural(t.days, 'day')} in progress` : since(t.since)}</span>
                    </Tip>
                    {t.resume.noHandoff && <NoHandoff p={p} id={t.id} />}
                  </div>
                  <Resume p={p} t={t} />
                </div>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  )
}

/** The ticket page, scrolled to its "Resume here" card. */
function ResumeLink({
  p,
  id,
  className,
  tip,
  children,
}: {
  p: ProjectSummary
  id: number
  className: string
  /** Its tooltip, if any. */
  tip?: string
  children: ReactNode
}) {
  return (
    <Tip content={tip}>
      <Link
        to="/projects/$id/features/$ticketId"
        params={{ id: String(p.project.id), ticketId: String(id) }}
        hash="resume"
        className={className}
      >
        {children}
      </Link>
    </Tip>
  )
}

function NoHandoff({ p, id }: { p: ProjectSummary; id: number }) {
  return (
    <ResumeLink
      p={p}
      id={id}
      className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] leading-none font-medium text-amber-700 hover:underline dark:text-amber-400"
      tip="Worked on an earlier day, and nobody left a resume note on where it was left: open it to write one"
    >
      <BookmarkX className="size-3" /> no handoff
    </ResumeLink>
  )
}

/**
 * Where the last session left off: the ticket's resume note, with its last progress post under it
 * when that came later; the last progress post alone when there is no note.
 */
function Resume({ p, t }: { p: ProjectSummary; t: CarryOver }) {
  const r = t.resume
  if (!r.note) return <LastPost post={t.lastPost} />
  return (
    <>
      <ResumeLink
        p={p}
        id={t.id}
        className="mt-1 line-clamp-2 border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground hover:text-foreground"
        tip="Its resume note: open it on the ticket"
      >
        <Bookmark className="mr-1 inline size-3 align-[-1px]" />
        {r.note}
        {r.at && (
          <span className="whitespace-nowrap">
            {' '}
            — {r.by ? `${r.by}, ` : ''}
            {ago(r.at)}
          </span>
        )}
      </ResumeLink>
      {r.stale && (
        <>
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
            Progress posted since this note:
          </p>
          <LastPost post={t.lastPost} />
        </>
      )}
    </>
  )
}
