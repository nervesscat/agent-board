import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
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
  MessageSquare,
  Play,
  Scale,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Actor, ClaimedActor } from '#/components/Actor'
import { AgentsAtWork } from '#/components/AgentsAtWork'
import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
import { GettingStarted } from '#/components/GettingStarted'
import { useSettleInstructions } from '#/components/InstructionsHistory'
import { Notes } from '#/components/Notes'
import { BlockedTasksBadge, DecisionBadge, Progress } from '#/components/TicketBoard'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { cn } from 'cn'
import { Skeleton } from '#/components/ui/skeleton'
import { Tip } from '#/components/ui/tooltip'
import { stallFor } from '#/components/StallLine'
import { WorkLine } from '#/components/WorkStatus'
import { timelineFromActivity, stallStage } from '#/lib/activityTimeline'
import { threadAnchor } from '#/lib/anchors'
import type { AreaId } from '#/lib/layout'
import {
  errorMessage,
  get,
  type CarryOver,
  type ProjectSummary,
  type SummaryPayload as Payload,
} from '#/lib/api'
import { currentLocale, shared } from '#/i18n'
import { ago, clock, stamp } from '#/lib/format'
import { needKeys, undismissed, useDismissedNeeds } from '#/lib/needsYou'
import { projectTabSearch } from '#/lib/settingsTabs'
import { carryingOverStages, stageBadge, stageOf } from '#/lib/stages'
import { useServerOffset } from '#/lib/useNow'
import { lastHeard, onServerClock, workDuration, type WorkTimelineLike } from '#/lib/workStatus'
import type { Stalled } from '#/lib/workTimeline'

/**
 * Where things stand, for one project (its Overview) or every project (Home, one block each): what
 * waits on the human, what is in progress, what got done today, what is next, and what carries over
 * from before today. Refreshed every 30 seconds while the page is visible.
 */
export function Summary({ projectId }: { projectId?: number }) {
  const { t: tr } = useTranslation()
  const { data, isLoading, error } = useQuery({
    queryKey: ['summary', projectId ?? 'all'],
    queryFn: () => get<Payload>(`/api/summary${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: 30_000,
  })
  // What this browser remembers of Needs you as opened, for the actor who asked (this browser's alone).
  const [dismissed, dismiss] = useDismissedNeeds(data?.actor)
  // The stall minutes are counted on the server's clock, from the moment this summary was taken, so a
  // browser whose clock is off shows the same minutes as the ticket page. 0 before the summary arrives.
  const now = onServerClock(Date.now(), useServerOffset(data?.generatedAt))
  if (isLoading)
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className={cn('h-40', i === 0 && 'lg:col-span-full')} />
        ))}
      </div>
    )
  if (error || !data) return <Empty>{tr('overview.loadError', { error: errorMessage(error) })}</Empty>
  if (!data.projects.length) return <GettingStarted />
  // Only the entries the human has not opened yet, and counts to match.
  const projects = data.projects.map((p) => undismissed(p, dismissed))
  if (projectId) return <ProjectBlock p={projects[0]!} now={now} dismiss={dismiss} />
  return (
    <div className="space-y-10">
      {/* The top bar's Getting started entry folds into the Pages menu on a phone, which leads here. */}
      <div className="empty:hidden md:hidden">
        <GettingStarted dismissable />
      </div>
      {projects.map((p) => (
        <section key={p.project.id} className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              <Tip content={tr('overview.projectOverview', { name: p.project.name })}>
                <Link to="/projects/$id" params={{ id: String(p.project.id) }} className="hover:underline">
                  {p.project.name}
                </Link>
              </Tip>
            </h2>
            <span className="text-xs text-muted-foreground">{headline(p)}</span>
          </div>
          <ProjectBlock p={p} now={now} dismiss={dismiss} />
        </section>
      ))}
    </div>
  )
}

/** What every Overview card is given: the project, the clock, and how to remember an opened entry. */
type CardProps = { p: ProjectSummary; now: number; dismiss: (key: string) => void }

/** The block's counts in one line, beside the project's name on Home. */
const headline = (p: ProjectSummary) =>
  [
    p.needsYou.total ? shared.t('overview.headline.waiting', { count: p.needsYou.total }) : null,
    shared.t('overview.headline.inProgress', { count: p.inProgress.length }),
    shared.t('overview.headline.doneToday', { count: p.doneToday.tickets.length }),
  ]
    .filter(Boolean)
    .join(' · ')

/** Each card of the block; which show and in what order is the project's layout. */
const CARDS: Record<AreaId<'overview'>, (props: CardProps) => ReactNode> = {
  'overview.needsYou': NeedsYou,
  'overview.agents': Agents,
  'overview.inProgress': InProgress,
  'overview.doneToday': DoneToday,
  'overview.lostContact': LostContact,
  'overview.carryingOver': CarryingOver,
  'overview.notes': Notes,
}

function ProjectBlock({ p, now, dismiss }: CardProps) {
  if (!p.project.overview.length)
    return (
      <Empty>
        <Trans
          i18nKey="overview.allHidden"
          components={{
            goto: (
              <Link
                to="/settings"
                search={projectTabSearch(p.project.id)}
                hash="layout"
                className="underline"
              />
            ),
          }}
        />
      </Empty>
    )
  return (
    // On a desktop the first row is Needs you alone, the second Lost contact, In progress and Done today
    // in that order, and Carrying over closes the block full width. A phone keeps the layout's order,
    // stacked, so the order classes start at `lg`.
    <div className="grid gap-4 lg:grid-cols-3">
      {p.project.overview.map((card) => {
        const Shown = CARDS[card]
        return <Shown key={card} p={p} now={now} dismiss={dismiss} />
      })}
    </div>
  )
}

// --- building blocks ---

function Section({
  icon: Icon,
  title,
  count,
  rows,
  extra,
  className = '',
  scroll = false,
  children,
}: {
  icon: typeof Inbox
  title: string
  count?: number
  /** How many entries it renders, when the server sends fewer than `count`: what View all reveals. */
  rows?: number
  /** After the count: what among them needs attention. */
  extra?: ReactNode
  className?: string
  /** A fixed height (a cap on a phone) with the content scrolling under the header. */
  scroll?: boolean
  children: ReactNode
}) {
  // On a phone the scroll cards show their first three entries and a way to see the rest.
  const { t: tr } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const shown = Math.min(count ?? 0, rows ?? count ?? 0)
  const more = scroll && shown > 3
  return (
    <Card size="sm" className={cn(scroll && 'lg:max-h-[28rem] lg:h-[28rem]', className)}>
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
        className={cn(
          'space-y-3',
          scroll && 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-2',
          more && !expanded && 'max-md:[&>ul>*:nth-child(n+4)]:hidden',
        )}
      >
        {children}
      </CardContent>
      {more && (
        <div className="px-(--card-spacing) md:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? tr('overview.showFewer') : tr('overview.viewAll', { count: shown })}
          </Button>
        </div>
      )}
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

function TicketLink({
  p,
  id,
  title,
  hash,
  onClick,
}: {
  p: ProjectSummary
  id: number
  title: string
  hash?: string
  onClick?: () => void
}) {
  return (
    <Link
      to="/projects/$id/features/$ticketId"
      params={{ id: String(p.project.id), ticketId: String(id) }}
      hash={hash}
      className="hover:underline"
      onClick={onClick}
    >
      <span className="text-muted-foreground">#{id}</span> {title}
    </Link>
  )
}

/** Who holds it: one of the project's agents with its picture, anyone else as the board shows them. */
function Who({ p, name }: { p: ProjectSummary; name: string }) {
  const { t: tr } = useTranslation()
  if (!name) return <span>{tr('overview.unassigned')}</span>
  const agent = p.agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
  if (!agent) return <Actor name={name} />
  return (
    <Tip content={tr('overview.projectAgent', { name: agent.name })}>
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
  if (d.toDateString() === now.toDateString()) return shared.t('workStatus.since', { time: clock(iso) })
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 6)
    return shared.t('overview.sinceDate', {
      date: `${d.toLocaleDateString(currentLocale(), { weekday: 'short' })} ${d.getDate()}`,
    })
  return shared.t('overview.sinceDate', {
    date: d.toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' }),
  })
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

/** A stalled ticket's details, from the Needs you list that names it: its minutes counted on `now`. */
function stalledOf(p: ProjectSummary, id: number, now: number): Stalled | null {
  const s = p.needsYou.stalled.find((x) => x.ticketId === id)
  return s ? stallFor(s, now) : null
}

/** When an agent was last heard from, relative, and what it said: one line under the now line. */
function HeardLine({ timeline }: { timeline: WorkTimelineLike }) {
  const { t: tr } = useTranslation()
  const h = lastHeard(timeline)
  if (!h)
    return (
      <p data-testid="last-heard" className="text-xs text-muted-foreground">
        {tr('workStatus.nobodyHeard')}
      </p>
    )
  return (
    <p data-testid="last-heard" className="flex min-w-0 gap-x-1 text-xs text-muted-foreground tabular-nums">
      <span className="shrink-0">{tr('workStatus.lastHeard', { time: ago(h.at) })}</span>
      {h.agent && (
        <span className="min-w-0 truncate">{`· ${h.agent}${h.summary ? `: ${h.summary}` : ''}`}</span>
      )}
    </p>
  )
}

// --- the sections ---

/** Right after Needs you: the order class is the same, and cards of one order keep the layout's order. */
function Agents({ p }: CardProps) {
  return <AgentsAtWork p={p} className="lg:order-1 lg:col-span-full" />
}

/** A day in milliseconds: how a waiting ticket's wait is counted in days. */
const WAITING_DAY_MS = 86_400_000

function NeedsYou({ p, now, dismiss }: CardProps) {
  const { t: tr } = useTranslation()
  const {
    decisions,
    humanWaits,
    prs,
    threads,
    reviews,
    waitingLong,
    blockedTasks,
    instructionChanges,
    stalled,
    total,
  } = p.needsYou
  const pid = String(p.project.id)
  const settle = useSettleInstructions(pid)
  return (
    <Section
      icon={Inbox}
      title={tr('overview.needsYou.title')}
      count={total}
      scroll
      className="lg:order-1 lg:col-span-full"
    >
      {!total ? (
        <Quiet>{tr('overview.needsYou.empty')}</Quiet>
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
                  onClick={() => dismiss(needKeys.decision(d))}
                >
                  {tr('overview.needsYou.decide', { question: d.question })}
                </Link>
              }
              meta={
                <>
                  <span className="truncate">
                    {d.prTicket ? d.ticketTitle : `#${d.ticketId} ${d.ticketTitle}`}
                  </span>
                  <span>
                    {tr('overview.needsYou.asked', {
                      options: tr('overview.option', { count: d.options }),
                      author: d.author,
                      ago: ago(d.createdAt),
                    })}
                  </span>
                </>
              }
            />
          ))}
          {humanWaits.map((w) => (
            <Row
              key={`w${w.waitId}`}
              icon={<Hourglass className="text-amber-600 dark:text-amber-400" />}
              title={
                <Link
                  to="/projects/$id/features/$ticketId"
                  params={{ id: pid, ticketId: String(w.ticketId) }}
                  className="hover:underline"
                  onClick={() => dismiss(needKeys.humanWait(w))}
                >
                  {tr('overview.needsYou.waitingOnYou', { since: since(w.since), agent: w.agent })}
                  {w.note ? `: ${w.note}` : ''}
                </Link>
              }
              meta={
                <>
                  <span className="truncate">
                    #{w.ticketId} {w.ticketTitle}
                  </span>
                  {w.parent && <span className="truncate">{tr('overview.laneOf', { id: w.parent.id })}</span>}
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
                  onClick={() => dismiss(needKeys.pr(pr))}
                >
                  {tr('overview.needsYou.reviewPr', { number: pr.number, title: pr.title })}
                </Link>
              }
              meta={
                <>
                  {pr.repo && <span className="rounded bg-muted px-1">{pr.repo}</span>}
                  {pr.isDraft && <span>{tr('overview.draft')}</span>}
                  <span>{tr('overview.needsYou.prBy', { author: pr.author, ago: ago(pr.updatedAt) })}</span>
                </>
              }
              side={
                <Tip content={tr('overview.openOnGithub')}>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={tr('overview.openOnGithub')}
                    onClick={() => dismiss(needKeys.pr(pr))}
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
                    onClick={() => dismiss(needKeys.thread(th))}
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
                    onClick={() => dismiss(needKeys.thread(th))}
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
                    {th.waiting > 1 ? tr('overview.needsYou.newReplies', { count: th.waiting }) : ''}
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
                    {tr('overview.needsYou.blocked')}
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
                      onClick={() => dismiss(needKeys.blockedTask(task))}
                    />
                  </span>
                  {task.parent && (
                    <span className="truncate">{tr('overview.laneOf', { id: task.parent.id })}</span>
                  )}
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
                    to="/projects/$id/instructions"
                    params={{ id: pid }}
                    hash="instructions-history"
                    className="hover:underline"
                    onClick={() => dismiss(needKeys.instructionChange(c))}
                  >
                    {tr('overview.needsYou.instructionsChanged')}
                  </Link>{' '}
                  <Trans
                    i18nKey="overview.needsYou.changedBy"
                    components={{ actor: <Actor name={c.changedBy} /> }}
                  />
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
                      {tr('overview.needsYou.reviewed')}
                    </Button>
                    <Tip
                      content={
                        c.revertable
                          ? tr('overview.needsYou.revertTip')
                          : tr('overview.needsYou.revertBlockedTip')
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
                          {tr('overview.needsYou.revert')}
                        </Button>
                      </span>
                    </Tip>
                  </span>
                </>
              }
            />
          ))}
          {stalled.map((s) => {
            const timeline = timelineFromActivity(s.activity, stallFor(s, now))
            return (
              <Row
                key={`s${s.ticketId}`}
                icon={<AlertTriangle className="text-amber-600 dark:text-amber-400" />}
                title={
                  <Link
                    to="/projects/$id/features/$ticketId"
                    params={{ id: pid, ticketId: String(s.ticketId) }}
                    className="hover:underline"
                    onClick={() => dismiss(needKeys.stalled(s))}
                  >
                    <WorkLine
                      timeline={timeline}
                      now={now}
                      stage={stallStage(p.stages, s.status)}
                      variant="inline"
                      className="inline"
                    />
                    {`: #${s.ticketId} ${s.title}`}
                  </Link>
                }
                meta={
                  <>
                    <StageBadge p={p} status={s.status} />
                    {s.parent && (
                      <span className="truncate">{tr('overview.laneOf', { id: s.parent.id })}</span>
                    )}
                    {s.lastAgent && (
                      <span className="min-w-0 wrap-anywhere">
                        {tr('overview.needsYou.last')}{' '}
                        {s.lastFrom === 'assignee' ? (
                          // No event named anyone: the assignee, which nobody signed in recorded, so no badge.
                          <span data-testid="last-assignee" className="font-medium">
                            {s.lastAgent}
                          </span>
                        ) : (
                          <ClaimedActor name={s.lastAgent} by={s.lastBy} />
                        )}
                      </span>
                    )}
                  </>
                }
              />
            )
          })}
          {reviews.map((t) => (
            <Row
              key={`r${t.id}`}
              icon={<Eye />}
              title={
                <TicketLink
                  p={p}
                  id={t.id}
                  title={t.title}
                  hash="tasks"
                  onClick={() => dismiss(needKeys.review(t))}
                />
              }
              meta={
                <>
                  <StageBadge p={p} status={t.status} />
                  {t.parent && <span className="truncate">{tr('overview.laneOf', { id: t.parent.id })}</span>}
                  {t.assignee && <Who p={p} name={t.assignee} />}
                  {t.prNumber && <span>{tr('overview.pr', { number: t.prNumber })}</span>}
                  <WorkLine
                    timeline={{
                      ...timelineFromActivity(null, null),
                      stage: t.stage,
                      waitingOnHuman: t.waitingOnHuman,
                    }}
                    now={now}
                    variant="inline"
                  />
                </>
              }
            />
          ))}
          {waitingLong.map((w) => (
            <Row
              key={`wl${w.ticketId}`}
              icon={<Hourglass className="text-amber-600 dark:text-amber-400" />}
              title={
                <TicketLink
                  p={p}
                  id={w.ticketId}
                  title={w.title}
                  hash="tasks"
                  onClick={() => dismiss(needKeys.waitingLong(w))}
                />
              }
              meta={
                <>
                  <StageBadge p={p} status={w.status} />
                  {w.parent && <span className="truncate">{tr('overview.laneOf', { id: w.parent.id })}</span>}
                  {w.assignee && <Who p={p} name={w.assignee} />}
                  <span>
                    {tr('overview.needsYou.waitingDays', { count: Math.floor(w.waitedMs / WAITING_DAY_MS) })}
                  </span>
                  {w.lastSummary && <span className="min-w-0 truncate">{w.lastSummary}</span>}
                </>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  )
}

/**
 * Lost contact: the tickets whose agent's lease expired with its span still open, so the agent is
 * likely gone. Its own card, outside Needs you (that is the human's turn), longest silent first: the
 * server sorts them by their last signal, oldest first.
 */
function LostContact({ p, now }: CardProps) {
  const { t: tr } = useTranslation()
  const rows = p.lostContact
  return (
    <Section
      icon={AlertTriangle}
      title={tr('overview.lost.title')}
      count={rows.length}
      scroll
      className="lg:order-2"
    >
      {!rows.length ? (
        <Quiet>{tr('overview.lost.empty')}</Quiet>
      ) : (
        <Rows>
          {rows.map((l) => {
            const heard = l.lastWordAt ?? l.lastSignalAt
            return (
              <Row
                key={l.ticketId}
                icon={<AlertTriangle className="text-rose-600 dark:text-rose-400" />}
                title={<TicketLink p={p} id={l.ticketId} title={l.title} />}
                side={<StageBadge p={p} status={l.status} />}
                meta={
                  <>
                    {l.parent && (
                      <span className="truncate">{tr('overview.laneOf', { id: l.parent.id })}</span>
                    )}
                    <span className="min-w-0 wrap-anywhere">
                      {l.agent} · {l.phase} · {since(l.since)}
                    </span>
                    <Tip content={tr('overview.lost.lastHeardTip', { when: stamp(heard) })}>
                      <span className="tabular-nums">
                        {tr('overview.lost.lastHeard', {
                          duration: workDuration(now - Date.parse(heard), tr),
                        })}
                      </span>
                    </Tip>
                  </>
                }
              />
            )
          })}
        </Rows>
      )}
    </Section>
  )
}

/** The Overview's in-progress rows: each ticket's now line, the agent's last word and how long on it. */
export function InProgress({ p, now }: { p: ProjectSummary; now: number }) {
  const { t: tr } = useTranslation()
  const items = p.inProgress
  return (
    <Section
      icon={Play}
      title={tr('overview.inProgress.title')}
      count={items.length}
      scroll
      className="lg:order-3"
    >
      {!items.length ? (
        <Quiet>{tr('overview.inProgress.empty')}</Quiet>
      ) : (
        <Rows>
          {items.map((t) => {
            const timeline = timelineFromActivity(t.activity, t.stalled ? stalledOf(p, t.id, now) : null)
            return (
              <Row
                key={t.id}
                title={<TicketLink p={p} id={t.id} title={t.title} />}
                side={<>{t.kind === 'blocked' && <StageBadge p={p} status={t.status} />}</>}
                meta={
                  <div className="w-full min-w-0">
                    <WorkLine timeline={timeline} now={now} stage={stallStage(p.stages, t.status)} detail />
                    <HeardLine timeline={timeline} />
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Who p={p} name={t.assignee} />
                      <Tip content={new Date(t.since).toLocaleString(currentLocale())}>
                        <span>{since(t.since)}</span>
                      </Tip>
                      {t.lanes > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3" /> {tr('overview.lane', { count: t.lanes })}
                        </span>
                      )}
                      {t.decisions > 0 && <DecisionBadge n={t.decisions} />}
                      {t.blockedNext && <BlockedTasksBadge n={t.blockedTasks} />}
                      {t.preview && (
                        <Tip content={tr('overview.previewOf', { workspace: t.preview.workspace })}>
                          <a
                            href={t.preview.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-foreground hover:underline"
                          >
                            <ExternalLink className="size-3" /> {tr('overview.preview')}
                          </a>
                        </Tip>
                      )}
                    </div>
                    {t.rollup.total > 0 && <Progress rollup={t.rollup} className="mt-1.5" />}
                    <LastPost post={t.lastPost} />
                  </div>
                }
              />
            )
          })}
        </Rows>
      )}
    </Section>
  )
}

function DoneToday({ p }: { p: ProjectSummary }) {
  const { t: tr } = useTranslation()
  const { tickets, prs, activity } = p.doneToday
  return (
    <Section
      icon={CheckCircle2}
      title={tr('overview.doneToday.title')}
      count={tickets.length + prs.length}
      scroll
      className="lg:order-4"
    >
      {!tickets.length && !prs.length ? (
        <Quiet>{tr('overview.doneToday.empty')}</Quiet>
      ) : (
        <Rows>
          {tickets.map((t) => (
            <Row
              key={`t${t.id}`}
              icon={<CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
              meta={
                <>
                  {t.parent && <span className="truncate">{tr('overview.laneOf', { id: t.parent.id })}</span>}
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
                  {tr('overview.prTitle', { number: pr.number, title: pr.title })}
                </a>
              }
              meta={
                <>
                  {pr.repo && <span className="rounded bg-muted px-1">{pr.repo}</span>}
                  <Tip content={tr('overview.doneToday.closedTip')}>
                    <span>{tr('overview.doneToday.closed', { time: clock(pr.closedAt) })}</span>
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
        {tr('overview.doneToday.activity', { count: activity })} <ArrowRight className="size-3" />
      </Link>
    </Section>
  )
}

function CarryingOver({ p, now }: CardProps) {
  const { t: tr } = useTranslation()
  // The summary carries every ticket from before today; Overview lists the Blocked and In review ones.
  const shown = carryingOverStages(p.stages)
  const items = p.carryingOver.filter((t) => shown.has(t.status))
  return (
    <Section
      icon={Clock}
      title={tr('overview.carryingOver.title')}
      count={items.length}
      className="lg:order-5 lg:col-span-full"
      scroll
    >
      {!items.length ? (
        <Quiet>{tr('overview.carryingOver.emptyShown')}</Quiet>
      ) : (
        <Rows>
          {items.map((t) => {
            const timeline = timelineFromActivity(t.activity, t.stalled ? stalledOf(p, t.id, now) : null)
            return (
              <Row
                key={t.id}
                title={<TicketLink p={p} id={t.id} title={t.title} />}
                side={<StageBadge p={p} status={t.status} />}
                meta={
                  <div className="w-full min-w-0">
                    <WorkLine timeline={timeline} now={now} stage={stallStage(p.stages, t.status)} detail />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Who p={p} name={t.assignee} />
                      <Tip
                        content={tr('overview.carryingOver.startedTip', {
                          when: new Date(t.since).toLocaleString(currentLocale()),
                        })}
                      >
                        <span>
                          {t.days ? tr('overview.carryingOver.days', { count: t.days }) : since(t.since)}
                        </span>
                      </Tip>
                    </div>
                    <LastPost post={t.lastPost} />
                  </div>
                }
              />
            )
          })}
        </Rows>
      )}
    </Section>
  )
}
