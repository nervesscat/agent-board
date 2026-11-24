import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ImagePlus, Lock, Pencil, Plus, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
import { DelayedLoading, SkeletonCard } from '#/components/Loading'
import { Markdown } from '#/components/Markdown'
import { TrashIcon } from '#/components/TrashIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { Tip } from '#/components/ui/tooltip'
import { RichEditor } from '#/components/RichEditor'
import { del, errorMessage, get, patch, post, type ProjectAgent, type TicketRow, upload } from '#/lib/api'
import { DEFAULT_AGENT_NAMES, FILES_AGENT_NAMES } from '#/lib/constants'
import { hasGitSide } from '#/lib/kinds'
import { useProject } from '#/lib/project'
import { ticketsKey, ticketsQuery } from '#/lib/tickets'

export const Route = createFileRoute('/projects/$id/agents')({
  component: Agents,
})

function Agents() {
  const { t: tr } = useTranslation()
  const { id } = Route.useParams()
  const { data: project, error: projectError } = useProject(id)
  // Every ticket, lanes included: an agent can hold a lane as much as a top-level ticket.
  const { data: tickets } = useQuery(ticketsQuery(id, 'all'))
  const [adding, setAdding] = useState(false)
  // What a new agent's report template starts as: the common part every template carries.
  const { data: commonTemplate } = useQuery({
    queryKey: ['run-report-template'],
    queryFn: () => get<{ template: string }>('/api/run-reports/template'),
    enabled: adding,
  })
  // Unknown until the tickets are read: no "reserved" count is shown before then.
  const reservedFor = (a: ProjectAgent) =>
    tickets?.filter((t) => t.assignee.toLowerCase() === a.name.toLowerCase())
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{tr('projectAgents.title')}</h1>
          <p className="text-sm text-muted-foreground">{tr('projectAgents.text')}</p>
        </div>
        {!adding && (
          <Button className="w-full shrink-0 sm:w-auto" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" /> {tr('projectAgents.new')}
          </Button>
        )}
      </div>
      {project && <DefaultAgents projectId={id} agents={project.agents} kinds={project.kinds} />}
      {adding && (
        <AgentForm
          projectId={id}
          defaultTemplate={commonTemplate?.template}
          onDone={() => setAdding(false)}
        />
      )}
      {!project ? (
        !projectError && (
          <DelayedLoading label={tr('loading.agents')} className="space-y-3">
            <SkeletonCard lines={4} />
            <SkeletonCard lines={4} />
          </DelayedLoading>
        )
      ) : project.agents.length === 0 && !adding ? (
        <Empty>{tr('projectAgents.empty')}</Empty>
      ) : (
        <ul className="space-y-3">
          {project.agents.map((a) => (
            <AgentCard key={a.id} projectId={id} agent={a} reserved={reservedFor(a)} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** The build and review cycle as agents, one click away, and where the skills that run it install. */
function DefaultAgents({
  projectId,
  agents,
  kinds,
}: {
  projectId: string
  agents: ProjectAgent[]
  kinds: readonly string[]
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const have = new Set(agents.map((a) => a.name.toLowerCase()))
  // A project with no software kind has its maker, not the review cycle.
  const software = hasGitSide(kinds)
  const names: readonly string[] = software ? DEFAULT_AGENT_NAMES : FILES_AGENT_NAMES
  const missing = names.filter((n) => !have.has(n))
  const add = useMutation({
    mutationFn: () =>
      post<{ added: string[]; kept: string[] }>(`/api/projects/${projectId}/agents/defaults`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(t('projectAgents.added', { names: r.added.join(', ') }))
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={t('projectAgents.defaults.title')}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-48 flex-1 space-y-1">
          <h2 className="text-sm font-medium">{t('projectAgents.defaults.title')}</h2>
          {!software ? (
            <p className="text-xs text-muted-foreground">
              <Trans
                i18nKey="projectAgents.defaults.files"
                values={{ path: `/api/mcp?project=${projectId}` }}
                components={{ code: <code className="font-mono" /> }}
              />
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              <Trans i18nKey="projectAgents.defaults.software" components={{ strong: <strong /> }} />
            </p>
          )}
        </div>
        {missing.length > 0 ? (
          <Button
            className="shrink-0"
            variant="outline"
            disabled={add.isPending}
            onClick={() => add.mutate()}
          >
            <Sparkles data-icon="inline-start" />
            {missing.length === names.length
              ? t('projectAgents.defaults.addAll')
              : t('projectAgents.defaults.addNames', { names: missing.join(', ') })}
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('projectAgents.defaults.allAdded')}
          </span>
        )}
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">
        <Trans
          i18nKey="projectAgents.defaults.skills"
          components={{ goto: <Link to="/agents" className="underline hover:text-foreground" /> }}
        />
      </p>
    </section>
  )
}

function AgentCard({
  projectId,
  agent,
  reserved,
}: {
  projectId: string
  agent: ProjectAgent
  /** Undefined until the tickets are read. */
  reserved: TicketRow[] | undefined
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const remove = useMutation({
    mutationFn: () => del(`/api/agents/${agent.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (editing) return <AgentForm projectId={projectId} agent={agent} onDone={() => setEditing(false)} />
  return (
    <li className="rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} className="size-10 text-base" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{agent.name}</span>
            <code className="rounded bg-muted px-1 text-xs text-muted-foreground">@{agent.name}</code>
          </div>
          {reserved === undefined ? (
            <div className="mt-1 h-4" />
          ) : reserved.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              {reserved.map((tk) => (
                <Link
                  key={tk.id}
                  to="/projects/$id/features/$ticketId"
                  params={{ id: projectId, ticketId: String(tk.id) }}
                  className="hover:text-foreground hover:underline"
                >
                  #{tk.id} {tk.title}
                </Link>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">{t('projectAgents.noReserved')}</div>
          )}
        </div>
        <Tip content={t('runsSettings.edit')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('runsSettings.edit')}
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        </Tip>
        <AlertDialog>
          <Tip content={t('projectAgents.remove', { name: agent.name })}>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('projectAgents.remove', { name: agent.name })}
                />
              }
            >
              <TrashIcon />
            </AlertDialogTrigger>
          </Tip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('projectAgents.removeTitle', { name: agent.name })}</AlertDialogTitle>
              <AlertDialogDescription>
                {reserved?.length ? `${t('projectAgents.removeReserved', { count: reserved.length })} ` : ''}
                {t('projectAgents.removeKept')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('projectAgents.keep')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>
                {t('projectAgents.removeAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <AgentText
        title={t('projectAgents.instructions')}
        hint={t('projectAgents.instructionsHint')}
        text={agent.instructions}
      />
      <AgentText
        title={t('projectAgents.delegate')}
        hint={t('projectAgents.delegateHint')}
        text={agent.delegation}
        empty={t('projectAgents.delegateEmpty')}
      />
      <AgentText
        title={t('projectAgents.report')}
        hint={t('projectAgents.reportHint')}
        text={agent.reportTemplate}
      />
    </li>
  )
}

/** One of the agent's texts; a long one starts folded, so a page of agents stays readable. */
function AgentText({
  title,
  hint,
  text,
  empty,
}: {
  title: string
  hint: string
  text: string
  empty?: string
}) {
  const { t } = useTranslation()
  const heading = (
    <>
      {title} <span className="font-normal">· {hint}</span>
    </>
  )
  if (!text)
    return (
      <div className="mt-3 border-t pt-3">
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">{heading}</h3>
        <p className="text-sm text-muted-foreground">{empty ?? t('projectAgents.nothingYet')}</p>
      </div>
    )
  return (
    <details className="group mt-3 border-t pt-3" open={text.length <= 1200}>
      <summary className="mb-1 cursor-pointer text-xs font-medium text-muted-foreground select-none">
        {heading}
        <span className="font-normal group-open:hidden">
          {' '}
          · {t('projectAgents.lines', { count: text.split('\n').length })}
        </span>
      </summary>
      <Markdown>{text}</Markdown>
    </details>
  )
}

/** New agent, or editing one: picture, name, its instructions and when to delegate to it. */
function AgentForm({
  projectId,
  agent,
  defaultTemplate,
  onDone,
}: {
  projectId: string
  agent?: ProjectAgent
  /** The common part a new agent's report template starts as, once it is read. */
  defaultTemplate?: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(agent?.name ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [delegation, setDelegation] = useState(agent?.delegation ?? '')
  const [reportTemplate, setReportTemplate] = useState(agent?.reportTemplate ?? defaultTemplate ?? '')
  // The common part comes from the board a moment after the form opens; it fills the field if it is
  // still untouched.
  useEffect(() => {
    if (!agent && defaultTemplate) setReportTemplate((current) => current || defaultTemplate)
  }, [agent, defaultTemplate])
  const [avatar, setAvatar] = useState<{ id: number; url: string } | null>(
    agent?.avatarId ? { id: agent.avatarId, url: agent.avatarUrl! } : null,
  )
  const file = useRef<HTMLInputElement>(null)
  const pick = useMutation({
    mutationFn: (f: File) => upload(f),
    onSuccess: (a) => setAvatar({ id: a.id, url: a.url }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        instructions,
        delegation,
        reportTemplate,
        avatarId: avatar?.id ?? null,
      }
      return agent ? patch(`/api/agents/${agent.id}`, body) : post(`/api/projects/${projectId}/agents`, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
      onDone()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="flex items-end gap-4">
        <div className="space-y-2">
          <Label>{t('projectAgents.picture')}</Label>
          <div className="relative">
            <Tip content={t('projectAgents.choosePicture')}>
              <button
                type="button"
                onClick={() => file.current?.click()}
                className="flex size-16 items-center justify-center overflow-hidden rounded-full border bg-muted text-muted-foreground hover:text-foreground"
                aria-label={t('projectAgents.choosePicture')}
              >
                {avatar ? (
                  <img src={avatar.url} alt="" className="size-full object-cover" />
                ) : name ? (
                  <AgentAvatar agent={{ name, avatarUrl: null }} className="size-full text-2xl" />
                ) : (
                  <ImagePlus className="size-5" />
                )}
              </button>
            </Tip>
            {avatar && (
              <Tip content={t('projectAgents.removePicture')}>
                <button
                  type="button"
                  onClick={() => setAvatar(null)}
                  className="absolute -top-1 -right-1 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={t('projectAgents.removePicture')}
                >
                  <X className="size-3" />
                </button>
              </Tip>
            )}
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) pick.mutate(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <Label htmlFor="agent-name">{t('runsSettings.name')}</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('projectAgents.namePlaceholder')}
            required
            autoFocus
            maxLength={40}
            pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
            title={t('projectAgents.nameRule')}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>{t('projectAgents.instructions')}</Label>
        <p className="text-xs text-muted-foreground">{t('projectAgents.instructionsText')}</p>
        <RichEditor
          value={instructions}
          onChange={setInstructions}
          minHeight="min-h-40"
          label={t('projectAgents.instructions')}
          placeholder={t('projectAgents.instructionsPlaceholder')}
        />
      </div>
      <div className="space-y-2">
        <Label>{t('projectAgents.delegate')}</Label>
        <p className="text-xs text-muted-foreground">{t('projectAgents.delegateText')}</p>
        <RichEditor
          value={delegation}
          onChange={setDelegation}
          minHeight="min-h-28"
          label={t('projectAgents.delegate')}
          placeholder={t('projectAgents.delegatePlaceholder')}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-report-template">{t('projectAgents.templateLabel')}</Label>
        <p className="text-xs text-muted-foreground">{t('projectAgents.templateText')}</p>
        <Textarea
          id="agent-report-template"
          value={reportTemplate}
          onChange={(e) => setReportTemplate(e.target.value)}
          className="min-h-40 font-mono text-xs"
          placeholder={t('projectAgents.templatePlaceholder')}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('runsSettings.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending || pick.isPending || !name.trim()}>
          {agent ? t('connect.save') : t('projectAgents.add')}
        </Button>
      </div>
    </form>
  )
}
