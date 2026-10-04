import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  GitPullRequest,
  Hourglass,
  Inbox,
  Layers,
  ListTodo,
  MessageSquare,
  Play,
  Scale,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Actor } from '#/components/Actor'
import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
import { DecisionBadge, Progress } from '#/components/TicketBoard'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import { errorMessage, get, type CarryOver, type ProjectSummary, type Summary as Payload } from '#/lib/api'
import { ago, clock } from '#/lib/format'
import { stageBadge, stageOf } from '#/lib/stages'

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
  if (!data.projects.length)
    return (
      <Empty>
        No projects yet. Start on the{' '}
        <Link to="/repositories" className="underline">
          Repositories page
        </Link>
        : add a checkout and the project it belongs to.
      </Empty>
    )
  if (projectId) return <ProjectBlock p={data.projects[0]!} />
  return (
    <div className="space-y-10">
      {data.projects.map((p) => (
        <section key={p.project.id} className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">
              <Link
                to="/projects/$id"
                params={{ id: String(p.project.id) }}
                className="hover:underline"
                title={`${p.project.name}: overview`}
              >
                {p.project.name}
              </Link>
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

function ProjectBlock({ p }: { p: ProjectSummary }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <NeedsYou p={p} />
      <InProgress p={p} />
      <DoneToday p={p} />
      <Next p={p} />
      <CarryingOver p={p} />
    </div>
  )
}

// --- building blocks ---

function Section({
  icon: Icon,
  title,
  count,
  className = '',
  children,
}: {
  icon: typeof Inbox
  title: string
  count?: number
  className?: string
  children: ReactNode
}) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" /> {title}
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
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

function TicketLink({ p, id, title }: { p: ProjectSummary; id: number; title: string }) {
  return (
    <Link
      to="/projects/$id/features/$ticketId"
      params={{ id: String(p.project.id), ticketId: String(id) }}
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
    <span
      className="inline-flex items-center gap-1 font-medium"
      title={`${agent.name} (one of the project's agents)`}
    >
      <AgentAvatar agent={agent} />
      {agent.name}
    </span>
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

function Stale() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] leading-none font-medium text-amber-700 dark:text-amber-400"
      title="No progress post in over 24 hours"
    >
      <Hourglass className="size-3" /> stale
    </span>
  )
}

// --- the sections ---

function NeedsYou({ p }: { p: ProjectSummary }) {
  const { decisions, prs, threads, reviews, total } = p.needsYou
  const pid = String(p.project.id)
  return (
    <Section icon={Inbox} title="Needs you" count={total}>
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
                  className="hover:underline"
                >
                  Decide: {d.question}
                </Link>
              }
              meta={
                <>
                  <span className="truncate">
                    #{d.ticketId} {d.ticketTitle}
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
                <Link to="/projects/$id/prs" params={{ id: pid }} className="hover:underline">
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
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  title="Open on GitHub"
                >
                  <ExternalLink className="size-3.5" />
                </a>
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
                    className="hover:underline"
                  >
                    {th.parentType === 'ticket' ? `#${th.ticketId} ${th.title}` : th.title}
                  </Link>
                ) : (
                  <Link
                    to="/projects/$id/prs"
                    params={{ id: pid }}
                    search={th.parentType === 'review' ? { result: th.parentId } : {}}
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
          {reviews.map((t) => (
            <Row
              key={`r${t.id}`}
              icon={<Eye />}
              title={<TicketLink p={p} id={t.id} title={t.title} />}
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
    <Section icon={Play} title="In progress" count={items.length}>
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
                  {t.stale && <Stale />}
                </>
              }
              meta={
                <div className="w-full min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Who p={p} name={t.assignee} />
                    <span title={new Date(t.since).toLocaleString()}>{since(t.since)}</span>
                    {t.lanes > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Layers className="size-3" /> {plural(t.lanes, 'lane')}
                      </span>
                    )}
                    {t.decisions > 0 && <DecisionBadge n={t.decisions} />}
                    {t.preview && (
                      <a
                        href={t.preview.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-foreground hover:underline"
                        title={`Preview of ${t.preview.workspace}`}
                      >
                        <ExternalLink className="size-3" /> Preview
                      </a>
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
                  <span title="Merged or closed: it left the review queue">closed {clock(pr.closedAt)}</span>
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
  return (
    <Section icon={Clock} title="Carrying over" count={items.length} className="lg:col-span-2">
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
                    <span title={new Date(t.since).toLocaleString()}>
                      {t.days ? `${plural(t.days, 'day')} in progress` : since(t.since)}
                    </span>
                  </div>
                  <Resume t={t} />
                </div>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  )
}

/** Its handoff note when the ticket has one (and a warning when nobody left one), else its last progress post. */
function Resume({ t }: { t: CarryOver }) {
  const r = t.resume
  return (
    <>
      {r?.noHandoff && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3" /> no handoff: the last session left no resume note
        </p>
      )}
      {r?.note ? (
        <p className="mt-1 line-clamp-2 border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
          {r.note}
          {r.by && (
            <span className="whitespace-nowrap">
              {' '}
              — {r.by}
              {r.at ? `, ${ago(r.at)}` : ''}
            </span>
          )}
        </p>
      ) : (
        <LastPost post={t.lastPost} />
      )}
    </>
  )
}
