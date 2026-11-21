import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Circle, Plus, RefreshCw, Rocket, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { NewProject } from '#/components/ProjectSwitcher'
import { Button } from '#/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { type AgentTokenRow, errorMessage, get, type HostTools, type Me, post } from '#/lib/api'
import {
  missingTools,
  recallOnboarding,
  type Remembered,
  rememberOnboarding,
  type Step,
  steps as stepsOf,
} from '#/lib/onboarding'
import { useProjects } from '#/lib/project'
import { useHydrated } from '#/lib/useHydrated'
import { cn } from 'cn'

/**
 * The facts behind Getting started, from the queries other pages use (same keys, so a project, repo,
 * token or ticket made anywhere ticks its step), and what this browser remembers for the user. A
 * source that fails is a step not done, never a checklist left loading.
 */
function useOnboarding() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/me'), staleTime: Infinity })
  const human = me.data ? !me.data.agent : false
  const tools = useQuery({
    queryKey: ['host-tools'],
    queryFn: () => get<HostTools>('/api/host-tools'),
    staleTime: 60_000,
  })
  const projects = useProjects()
  const tokens = useQuery({
    queryKey: ['agent-tokens'],
    queryFn: () => get<AgentTokenRow[]>('/api/agent-tokens'),
    // Only the human may list them; an agent's browser never shows the checklist.
    enabled: human,
  })
  const settled = <T,>(q: { data: T | undefined; isError: boolean }) => (q.isError ? null : q.data)
  // Who is asking decides whether the tokens can be read at all: until /api/me answers they are
  // loading, and when it fails (or an agent is asking) they count as failed, not loading for good.
  const tokensFact = human ? settled(tokens) : me.isPending ? undefined : null
  const steps = stepsOf({ tools: settled(tools), projects: settled(projects), tokens: tokensFact })
  const done = steps.filter((s) => s.done).length
  const user = me.data?.actor ?? ''

  // Read after mount: the server's render has no storage (src/lib/remembered.ts). Kept with the user
  // it was read for, so the entry waits for it instead of showing for one frame before it is read.
  const [recalled, setRecalled] = useState<{ user: string; value: Remembered | null } | null>(null)
  useEffect(() => {
    if (user) setRecalled({ user, value: recallOnboarding(user) })
  }, [user])
  const read = recalled !== null && recalled.user === user
  const remembered = read ? recalled.value : null
  const remember = (value: Remembered) => {
    setRecalled({ user, value })
    if (user) rememberOnboarding(user, value)
  }
  // Once every step holds, it is done for good: a fact that stops holding later does not bring it back.
  const complete = done === steps.length
  useEffect(() => {
    if (complete && read && remembered !== 'done') remember('done')
  }, [complete, read, remembered])

  return {
    human,
    steps,
    done,
    remembered,
    remember,
    agent: Boolean(me.data?.agent),
    pending: steps.some((s) => s.pending) || me.isPending || (Boolean(user) && !read),
    tools: settled(tools),
    projects: projects.data ?? [],
    errors: { tools: tools.error, project: projects.error, agent: tokens.error, ticket: projects.error },
  }
}

type Onboarding = ReturnType<typeof useOnboarding>

/** Whether the entry shows: the board has answered, and the steps are neither done once nor dismissed. */
const entryShown = (o: Onboarding) => o.human && !o.pending && !o.remembered && o.done < o.steps.length

/**
 * The checklist as a card. On Home without projects it stands in for an empty page; with
 * `dismissable` (Home on a phone, where the top bar has no room for the entry) it shows only while the
 * entry would, with a Dismiss of its own.
 */
export function GettingStarted({ dismissable = false }: { dismissable?: boolean }) {
  const { t } = useTranslation()
  const o = useOnboarding()
  const create = useCreateProject()
  if (dismissable && !entryShown(o)) return create.dialog
  // The steps are the human's to take; an agent's view keeps the plain empty state.
  if (o.agent) return <Empty>{t('gettingStarted.agentEmpty')}</Empty>
  return (
    <Card id="getting-started" aria-labelledby="getting-started-title">
      <CardHeader>
        <CardTitle id="getting-started-title" className="text-base">
          {t('gettingStarted.title', { done: o.done, total: o.steps.length })}
        </CardTitle>
        <CardDescription>{t('gettingStarted.intro')}</CardDescription>
        {dismissable ? (
          <CardAction>
            <DismissButton onClick={() => o.remember('dismissed')} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <Checklist o={o} onNewProject={create.start} />
        {create.dialog}
      </CardContent>
    </Card>
  )
}

/**
 * In the top bar until every step is done (once) or the user dismisses it: "Getting started · 2 of 4",
 * opening the checklist. Hidden while the board has not answered, so it does not flash in and out.
 */
export function GettingStartedEntry() {
  const { t } = useTranslation()
  const o = useOnboarding()
  const [open, setOpen] = useState(false)
  const create = useCreateProject(() => setOpen(false))
  // Read after mount: the steps' queries can answer before React has hydrated the top bar, and the
  // entry drawn from them would not match the server's HTML (which had none).
  const hydrated = useHydrated()
  if (!hydrated || !entryShown(o)) return create.dialog
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tip content={t('gettingStarted.entryTip')}>
          <PopoverTrigger
            render={<Button variant="outline" size="sm" className="hidden shrink-0 md:inline-flex" />}
            aria-label={t('gettingStarted.entryAria', { done: o.done, total: o.steps.length })}
          >
            <Rocket data-icon="inline-start" />
            <span className="hidden lg:inline">{t('gettingStarted.entryShort')}</span> {o.done}/
            {o.steps.length}
          </PopoverTrigger>
        </Tip>
        <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                {t('gettingStarted.title', { done: o.done, total: o.steps.length })}
              </p>
              <p className="text-xs text-muted-foreground">{t('gettingStarted.popoverIntro')}</p>
            </div>
            <DismissButton
              onClick={() => {
                setOpen(false)
                o.remember('dismissed')
              }}
            />
          </div>
          <Checklist o={o} onGo={() => setOpen(false)} onNewProject={create.start} />
        </PopoverContent>
      </Popover>
      {create.dialog}
    </>
  )
}

function DismissButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Tip content={t('gettingStarted.dismissTip')}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('gettingStarted.dismissAria')}
        onClick={onClick}
      >
        <X />
      </Button>
    </Tip>
  )
}

/** The entry on screens too narrow for it in the top bar: an item of the Pages menu, to Home's card. */
export function GettingStartedMenuItem({ className, onGo }: { className: string; onGo: () => void }) {
  const { t } = useTranslation()
  const o = useOnboarding()
  if (!entryShown(o)) return null
  return (
    <Link to="/" hash="getting-started" onClick={onGo} className={className}>
      {t('gettingStarted.menuItem', { done: o.done, total: o.steps.length })}
    </Link>
  )
}

function Checklist({ o, onGo, onNewProject }: { o: Onboarding } & Actions) {
  const { t } = useTranslation()
  return (
    <ol aria-label={t('gettingStarted.stepsAria')} className="space-y-4">
      {o.steps.map((s, i) => (
        <li
          key={s.id}
          className="flex gap-3"
          aria-label={t('gettingStarted.stepAria', {
            title: t(`gettingStarted.titles.${s.id}`),
            state: state(s, t),
          })}
        >
          {s.done ? (
            <CheckCircle2
              className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          ) : (
            <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium">
              {i + 1}. {t(`gettingStarted.titles.${s.id}`)}{' '}
              <span
                className={cn(
                  'ml-1 text-xs font-normal',
                  s.done ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
                )}
              >
                {state(s, t)}
              </span>
            </p>
            <StepBody step={s} o={o} onGo={onGo} onNewProject={onNewProject} />
          </div>
        </li>
      ))}
    </ol>
  )
}

const state = (s: Step, t: TFunction) =>
  s.done
    ? t('gettingStarted.state.done')
    : s.pending
      ? t('gettingStarted.state.checking')
      : t('gettingStarted.state.notDone')

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{children}</p>
}

function Failed({ step, o }: { step: Step; o: Onboarding }) {
  const { t } = useTranslation()
  if (!step.failed) return null
  return (
    <p className="text-sm text-rose-700 dark:text-rose-400 [overflow-wrap:anywhere]">
      {t('gettingStarted.couldNotCheck', { error: errorMessage(o.errors[step.id]) })}
    </p>
  )
}

interface Actions {
  /** After a link is followed: the popover closes. */
  onGo?: () => void
  onNewProject: () => void
}

function StepBody({ step, o, onGo, onNewProject }: { step: Step; o: Onboarding } & Actions) {
  const { t } = useTranslation()
  const first = o.projects[0]
  const withRepo = o.projects.find((p) => p.repos.length > 0)
  switch (step.id) {
    case 'tools':
      return (
        <>
          <Hint>
            <Trans i18nKey="gettingStarted.tools.hint" components={{ code: <code /> }} />
          </Hint>
          <Failed step={step} o={o} />
          {missingTools(o.tools).map((tool) => (
            <Hint key={tool.name}>
              <Trans
                i18nKey="gettingStarted.tools.missing"
                values={{ problem: tool.problem, fix: tool.fix }}
                components={{ problem: <span className="font-medium text-foreground" /> }}
              />
            </Hint>
          ))}
          {step.done ? null : <CheckAgain />}
        </>
      )
    case 'project':
      return (
        <>
          <Hint>{t('gettingStarted.project.hint')}</Hint>
          <Failed step={step} o={o} />
          {step.done ? null : first ? (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link to="/projects/$id/repositories" params={{ id: String(first.id) }} onClick={onGo} />
              }
            >
              {t('gettingStarted.project.addRepo', { name: first.name })}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onNewProject}>
              <Plus data-icon="inline-start" /> {t('gettingStarted.project.new')}
            </Button>
          )}
        </>
      )
    case 'agent':
      return (
        <>
          <Hint>{t('gettingStarted.agent.hint')}</Hint>
          <Failed step={step} o={o} />
          {step.done ? null : (
            <Button variant="outline" size="sm" render={<Link to="/agents" onClick={onGo} />}>
              {t('gettingStarted.titles.agent')}
            </Button>
          )}
        </>
      )
    case 'ticket':
      return (
        <>
          <Hint>
            <Trans i18nKey="gettingStarted.ticket.hint" components={{ code: <code /> }} />
          </Hint>
          <Failed step={step} o={o} />
          {step.done ? null : (withRepo ?? first) ? (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  to="/projects/$id/features"
                  params={{ id: String((withRepo ?? first)!.id) }}
                  onClick={onGo}
                />
              }
            >
              {t('gettingStarted.ticket.write')}
            </Button>
          ) : (
            <Hint>{t('gettingStarted.ticket.createFirst')}</Hint>
          )}
        </>
      )
  }
}

function CheckAgain() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const check = useMutation({
    mutationFn: () => post<HostTools>('/api/host-tools/check'),
    onSuccess: (r) => qc.setQueryData(['host-tools'], r),
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={check.isPending}
      onClick={() => check.mutate()}
    >
      <RefreshCw data-icon="inline-start" className={check.isPending ? 'animate-spin' : ''} />{' '}
      {t('gettingStarted.checkAgain')}
    </Button>
  )
}

/**
 * The first project, made from the checklist: a new board has no project page to start from yet. Its
 * dialog is outside the top bar's popover, which closes as the dialog takes the focus.
 */
function useCreateProject(onGo?: () => void) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const dialog = (
    <NewProject
      open={open}
      onOpenChange={setOpen}
      onCreated={(p) => void navigate({ to: '/projects/$id/repositories', params: { id: String(p.id) } })}
    />
  )
  return {
    dialog,
    start: () => {
      onGo?.()
      setOpen(true)
    },
  }
}
