import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
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
import { Skeleton } from '#/components/ui/skeleton'
import { Textarea } from '#/components/ui/textarea'
import { TICKET_STATUSES } from '#/lib/constants'
import { errorMessage, get, post, type Ticket, type TicketRow } from '#/lib/api'
import { STATUS_LABEL, ago } from '#/lib/format'

export const Route = createFileRoute('/projects/$id/features/')({ component: Features })

function Features() {
  const { id } = Route.useParams()
  const { data, isLoading } = useQuery({
    queryKey: ['tickets', id],
    queryFn: () => get<TicketRow[]>(`/api/projects/${id}/tickets`),
    refetchInterval: 10_000,
  })
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ongoing features</h1>
          <p className="text-sm text-muted-foreground">
            Tickets agents pick up. Each one carries its todo list, branch, workspaces, updates and a thread.
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
              <div key={status} className="rounded-lg bg-muted/40 p-2">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {STATUS_LABEL[status]} <span className="tabular-nums">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map((t) => (
                    <Link
                      key={t.id}
                      to="/projects/$id/features/$ticketId"
                      params={{ id, ticketId: String(t.id) }}
                      className="block rounded-md border bg-card p-2.5 text-sm transition-colors hover:border-foreground/30"
                    >
                      <div className="font-medium leading-snug">
                        <span className="text-muted-foreground">#{t.id}</span> {t.title}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
  const create = useMutation({
    mutationFn: () =>
      post<Ticket>(`/api/projects/${projectId}/tickets`, {
        title,
        body,
        branch,
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
          <div className="space-y-2">
            <Label htmlFor="br">Branch (optional)</Label>
            <Input
              id="br"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="font-mono"
              placeholder="feat/…"
            />
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
