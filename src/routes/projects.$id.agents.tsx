import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ImagePlus, Lock, Pencil, Plus, Sparkles, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
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
import { Tip } from '#/components/ui/tooltip'
import { GenerateCommands } from '#/components/AgentTokens'
import { ReviewSkills, useShell } from '#/components/ReviewSkills'
import { RichEditor } from '#/components/RichEditor'
import { SHELLS } from '#/lib/agents'
import { del, errorMessage, get, patch, post, type ProjectAgent, type TicketRow, upload } from '#/lib/api'
import { DEFAULT_AGENT_NAMES } from '#/lib/constants'
import { useProject } from '#/lib/project'
import { ticketsKey, ticketsQuery } from '#/lib/tickets'
import type { NewAgentToken } from '#/server/tokens'

// ?shell= is the shell the review skills' install line is for (see useShell).
export const Route = createFileRoute('/projects/$id/agents')({
  component: Agents,
  validateSearch: z.object({ shell: z.enum(SHELLS).optional().catch(undefined) }),
})

function Agents() {
  const { id } = Route.useParams()
  const { data: project } = useProject(id)
  // Every ticket, lanes included: an agent can hold a lane as much as a top-level ticket.
  const { data: tickets = [] } = useQuery(ticketsQuery(id, 'all'))
  const [adding, setAdding] = useState(false)
  if (!project) return null
  const reservedFor = (a: ProjectAgent) =>
    tickets.filter((t) => t.assignee.toLowerCase() === a.name.toLowerCase())
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            The roles agents work as. Assign a ticket to reserve it for one.
          </p>
        </div>
        {!adding && (
          <Button className="w-full shrink-0 sm:w-auto" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" /> New agent
          </Button>
        )}
      </div>
      <DefaultAgents projectId={id} agents={project.agents} />
      {adding && <AgentForm projectId={id} onDone={() => setAdding(false)} />}
      {project.agents.length === 0 && !adding ? (
        <Empty>No agents yet. Every ticket is shared by the connected agents.</Empty>
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

/** The build and review cycle as agents, one click away, and the skills that run it. */
function DefaultAgents({ projectId, agents }: { projectId: string; agents: ProjectAgent[] }) {
  const qc = useQueryClient()
  const { data: setup } = useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => get<{ boardUrl: string }>('/api/agent-setup'),
  })
  const [shell, pickShell] = useShell()
  // The token "Generate commands" made for the install lines: shown once, never stored here.
  const [made, setMade] = useState<NewAgentToken | null>(null)
  const have = new Set(agents.map((a) => a.name.toLowerCase()))
  const missing = DEFAULT_AGENT_NAMES.filter((n) => !have.has(n))
  const add = useMutation({
    mutationFn: () =>
      post<{ added: string[]; kept: string[] }>(`/api/projects/${projectId}/agents/defaults`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(`Added ${r.added.join(', ')}`)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Default agents">
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-1">
          <h2 className="text-sm font-medium">Default agents</h2>
          <p className="text-xs text-muted-foreground">
            The build and review cycle: <strong>spec</strong> writes the acceptance criteria,{' '}
            <strong>builder</strong> writes the code, <strong>runner</strong> reviews it, and the
            review&apos;s phases (<strong>env</strong>, <strong>verify</strong>, <strong>hunt</strong>,{' '}
            <strong>refute</strong>, <strong>merge</strong>) try to break it; findings go back to the builder.
            Each comes with its instructions and the notes the orchestrator delegates by. Edit any of them
            after.
          </p>
        </div>
        {missing.length > 0 ? (
          <Button
            className="shrink-0"
            variant="outline"
            disabled={add.isPending}
            onClick={() => add.mutate()}
          >
            <Sparkles data-icon="inline-start" />
            {missing.length === DEFAULT_AGENT_NAMES.length
              ? 'Add the default agents'
              : `Add ${missing.join(', ')}`}
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">All added</span>
        )}
      </div>
      {setup && <GenerateCommands defaultName="claude" token={made} onToken={setMade} />}
      {setup && (
        <ReviewSkills
          boardUrl={setup.boardUrl}
          token={made?.token}
          shell={shell}
          onShellChange={pickShell}
          projectId={projectId}
        />
      )}
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
  reserved: TicketRow[]
}) {
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
          {reserved.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              {reserved.map((t) => (
                <Link
                  key={t.id}
                  to="/projects/$id/features/$ticketId"
                  params={{ id: projectId, ticketId: String(t.id) }}
                  className="hover:text-foreground hover:underline"
                >
                  #{t.id} {t.title}
                </Link>
              ))}
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">no tickets reserved for it</div>
          )}
        </div>
        <Tip content="Edit">
          <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
        </Tip>
        <AlertDialog>
          <Tip content={`Remove ${agent.name}`}>
            <AlertDialogTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={`Remove ${agent.name}`} />}
            >
              <TrashIcon />
            </AlertDialogTrigger>
          </Tip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {reserved.length
                  ? `Its ${reserved.length} reserved ticket${reserved.length === 1 ? '' : 's'} become shared and unassigned. `
                  : ''}
                What it already posted keeps its name.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <AgentText title="Instructions" hint="what the agent works by" text={agent.instructions} />
      <AgentText
        title="When to delegate"
        hint="what the orchestrator decides by"
        text={agent.delegation}
        empty="No delegation notes yet: the orchestrator will not know when to call it."
      />
    </li>
  )
}

/** One of the agent's texts; a long one starts folded, so a page of agents stays readable. */
function AgentText({
  title,
  hint,
  text,
  empty = 'Nothing yet.',
}: {
  title: string
  hint: string
  text: string
  empty?: string
}) {
  const heading = (
    <>
      {title} <span className="font-normal">· {hint}</span>
    </>
  )
  if (!text)
    return (
      <div className="mt-3 border-t pt-3">
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">{heading}</h3>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    )
  return (
    <details className="group mt-3 border-t pt-3" open={text.length <= 1200}>
      <summary className="mb-1 cursor-pointer text-xs font-medium text-muted-foreground select-none">
        {heading}
        <span className="font-normal group-open:hidden"> · {text.split('\n').length} lines</span>
      </summary>
      <Markdown>{text}</Markdown>
    </details>
  )
}

/** New agent, or editing one: picture, name, its instructions and when to delegate to it. */
function AgentForm({
  projectId,
  agent,
  onDone,
}: {
  projectId: string
  agent?: ProjectAgent
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(agent?.name ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [delegation, setDelegation] = useState(agent?.delegation ?? '')
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
      const body = { name, instructions, delegation, avatarId: avatar?.id ?? null }
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
          <Label>Picture</Label>
          <div className="relative">
            <Tip content="Choose a picture">
              <button
                type="button"
                onClick={() => file.current?.click()}
                className="flex size-16 items-center justify-center overflow-hidden rounded-full border bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Choose a picture"
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
              <Tip content="Remove the picture">
                <button
                  type="button"
                  onClick={() => setAvatar(null)}
                  className="absolute -top-1 -right-1 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Remove the picture"
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
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="reviewer, frontend, qa…"
            required
            autoFocus
            maxLength={40}
            pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
            title="Letters, digits, - and _, so @name works in threads"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Instructions</Label>
        <p className="text-xs text-muted-foreground">
          What the agent works by: who it is, how it works, what it never does. The orchestrator briefs a
          subagent with this.
        </p>
        <RichEditor
          value={instructions}
          onChange={setInstructions}
          minHeight="min-h-40"
          label="Instructions"
          placeholder="You are the Tester. You check every acceptance criterion against the running preview…"
        />
      </div>
      <div className="space-y-2">
        <Label>When to delegate</Label>
        <p className="text-xs text-muted-foreground">
          What the orchestrator decides by: when to hand work to this agent, what to give it, what it returns,
          and what comes next.
        </p>
        <RichEditor
          value={delegation}
          onChange={setDelegation}
          minHeight="min-h-28"
          label="When to delegate"
          placeholder="After the Builder finishes a step, with the preview link and the acceptance criteria. Returns PASS / FAIL per criterion. All pass: the Breaker next; a failure: back to the Builder."
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || pick.isPending || !name.trim()}>
          {agent ? 'Save' : 'Add agent'}
        </Button>
      </div>
    </form>
  )
}
