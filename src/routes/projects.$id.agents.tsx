import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ImagePlus, Lock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { AgentAvatar } from '#/components/AgentAvatar'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
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
import { del, errorMessage, get, patch, post, type ProjectAgent, type TicketRow, upload } from '#/lib/api'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/agents')({ component: Agents })

function Agents() {
  const { id } = Route.useParams()
  const { data: project } = useProject(id)
  const { data: tickets = [] } = useQuery({
    queryKey: ['tickets', id],
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets`),
  })
  const [adding, setAdding] = useState(false)
  if (!project) return null
  const reservedFor = (a: ProjectAgent) =>
    tickets.filter((t) => t.assignee.toLowerCase() === a.name.toLowerCase())
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            The specialists this project's work can go to. Assign a ticket to one and it is reserved for it: a
            connected agent (claude, codex…) works it as that agent, briefed with its instructions, and posts
            under its name. Mention <code className="rounded bg-muted px-1">@name</code> in a thread to ask
            one. Tickets left to a connected agent or to nobody are shared by all of them.
          </p>
        </div>
        {!adding && (
          <Button className="shrink-0" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" /> New agent
          </Button>
        )}
      </div>
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
      qc.invalidateQueries({ queryKey: ['tickets', projectId] })
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
        <Button variant="ghost" size="icon-sm" title="Edit" onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger
            render={<Button variant="ghost" size="icon-sm" title={`Remove ${agent.name}`} />}
          >
            <Trash2 className="text-destructive" />
          </AlertDialogTrigger>
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
      {agent.instructions ? (
        <Markdown className="mt-3 border-t pt-3">{agent.instructions}</Markdown>
      ) : (
        <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">No instructions yet.</p>
      )}
    </li>
  )
}

/** New agent, or editing one: picture, name, instructions. */
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
      const body = { name, instructions, avatarId: avatar?.id ?? null }
      return agent ? patch(`/api/agents/${agent.id}`, body) : post(`/api/projects/${projectId}/agents`, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['tickets', projectId] })
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
            <button
              type="button"
              onClick={() => file.current?.click()}
              className="flex size-16 items-center justify-center overflow-hidden rounded-full border bg-muted text-muted-foreground hover:text-foreground"
              title="Choose a picture"
            >
              {avatar ? (
                <img src={avatar.url} alt="" className="size-full object-cover" />
              ) : name ? (
                <AgentAvatar agent={{ name, avatarUrl: null }} className="size-full text-2xl" />
              ) : (
                <ImagePlus className="size-5" />
              )}
            </button>
            {avatar && (
              <button
                type="button"
                onClick={() => setAvatar(null)}
                className="absolute -top-1 -right-1 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                title="Remove the picture"
              >
                <X className="size-3" />
              </button>
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
        <Label htmlFor="agent-ins">Instructions (markdown)</Label>
        <Textarea
          id="agent-ins"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={10}
          className="font-mono text-xs"
          placeholder="Who it is, what it is good at, how it works, what it never does. A connected agent briefs a subagent with this."
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
