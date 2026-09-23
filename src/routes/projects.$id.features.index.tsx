import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { BranchSelect } from '#/components/BranchSelect'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import { Textarea } from '#/components/ui/textarea'
import { TICKET_STATUSES, type TicketStatus } from '#/lib/constants'
import { errorMessage, get, patch, post, type Ticket, type TicketRow } from '#/lib/api'
import { STATUS_LABEL, ago } from '#/lib/format'
import { repoLabel, useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/features/')({ component: Features })

function Features() {
  const { id } = Route.useParams()
  const { data: project } = useProject(id)
  const qc = useQueryClient()
  const key = ['tickets', id]
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets`),
    refetchInterval: 10_000,
  })
  // Drag a card onto another column to change its status. The card moves at once; a failed save
  // puts it back.
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<TicketStatus | null>(null)
  const move = useMutation({
    mutationFn: (v: { ticketId: number; status: TicketStatus }) =>
      patch(`/api/tickets/${v.ticketId}`, { status: v.status }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const before = qc.getQueryData<TicketRow[]>(key)
      qc.setQueryData<TicketRow[]>(key, (rows) =>
        rows?.map((t) => (t.id === v.ticketId ? { ...t, status: v.status } : t)),
      )
      return { before }
    },
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.before)
      toast.error(errorMessage(err))
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['ticket', String(v.ticketId)] })
    },
  })
  const drop = (status: TicketStatus) => {
    const t = data?.find((x) => x.id === dragging)
    if (t && t.status !== status) move.mutate({ ticketId: t.id, status })
    setDragging(null)
    setOver(null)
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ongoing features</h1>
          <p className="text-sm text-muted-foreground">
            Tickets agents pick up. Each one carries its todo list, branch, workspaces, updates and a thread.
            Drag a card to another column to change its status.
          </p>
        </div>
        <NewTicket projectId={id} />
      </div>
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-3 md:grid-cols-5">
          {TICKET_STATUSES.map((status) => {
            const items = data?.filter((t) => t.status === status) ?? []
            return (
              <div
                key={status}
                onDragOver={(e) => {
                  if (dragging === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (over !== status) setOver(status)
                }}
                onDragLeave={(e) => {
                  // Leaving for a card inside the same column is not leaving the column.
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(status)
                }}
                className={`rounded-lg bg-muted/40 p-2 transition-colors ${
                  over === status && data?.find((x) => x.id === dragging)?.status !== status
                    ? 'bg-primary/10 ring-2 ring-primary/40'
                    : ''
                }`}
              >
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {STATUS_LABEL[status]} <span className="tabular-nums">{items.length}</span>
                </div>
                <div className="min-h-16 space-y-2">
                  {items.map((t) => (
                    <Link
                      key={t.id}
                      to="/projects/$id/features/$ticketId"
                      params={{ id, ticketId: String(t.id) }}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', `#${t.id} ${t.title}`)
                        setDragging(t.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      className={`block cursor-grab rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30 active:cursor-grabbing ${
                        dragging === t.id ? 'opacity-40' : ''
                      }`}
                    >
                      <div className="font-medium leading-snug">
                        <span className="text-muted-foreground">#{t.id}</span> {t.title}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {repoLabel(project, t.repoId) && (
                          <span className="rounded bg-muted px-1">{repoLabel(project, t.repoId)}</span>
                        )}
                        {t.assignee && <Actor name={t.assignee} />}
                        {t.branch && (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <GitBranch className="size-3" /> {t.branch}
                          </span>
                        )}
                        <span className="ml-auto">{ago(t.updatedAt)}</span>
                      </div>
                      {t.progress.total > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-primary"
                              style={{ width: `${(100 * t.progress.done) / t.progress.total}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {t.progress.done}/{t.progress.total}
                          </span>
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function NewTicket({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tasks, setTasks] = useState('')
  const [branch, setBranch] = useState('')
  const { data: project } = useProject(projectId)
  const [picked, setPicked] = useState('')
  const repos = project?.repos ?? []
  const repoId = picked || String(repos[0]?.id ?? '')
  const create = useMutation({
    mutationFn: () =>
      post<Ticket>(`/api/projects/${projectId}/tickets`, {
        title,
        body,
        branch,
        repoId: repoId ? Number(repoId) : undefined,
        tasks: tasks
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets', projectId] })
      setOpen(false)
      setTitle('')
      setBody('')
      setTasks('')
      setBranch('')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus data-icon="inline-start" /> New ticket
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New ticket</DialogTitle>
            <DialogDescription>
              Write it the way you would brief a colleague: agents read this before they start.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="t">Title</Label>
            <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b">Instructions (markdown)</Label>
            <Textarea id="b" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tasks">Initial tasks, one per line</Label>
            <Textarea id="tasks" value={tasks} onChange={(e) => setTasks(e.target.value)} rows={3} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {repos.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="repo">Repository</Label>
                <Select
                  value={repoId}
                  onValueChange={(v) => {
                    setPicked(v as string)
                    setBranch('')
                  }}
                  items={Object.fromEntries(repos.map((r) => [String(r.id), r.name]))}
                >
                  <SelectTrigger id="repo" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="br">Branch (optional)</Label>
              <BranchSelect id="br" value={branch} onChange={setBranch} repoId={repoId} optional />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
