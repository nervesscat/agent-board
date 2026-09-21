import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, GitBranch, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { Actor } from '#/components/Actor'
import { Attachments } from '#/components/Attachments'
import { Empty } from '#/components/Empty'
import { Markdown } from '#/components/Markdown'
import { Thread } from '#/components/Thread'
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
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { TICKET_STATUSES } from '#/lib/constants'
import {
  del,
  errorMessage,
  get,
  patch,
  post,
  upload,
  type TicketFull,
  type TicketGit,
  type UpdateRow,
} from '#/lib/api'
import { STATUS_LABEL, ago, shortSha, stamp } from '#/lib/format'

export const Route = createFileRoute('/projects/$id/features/$ticketId')({ component: TicketPage })

function TicketPage() {
  const { id, ticketId } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const key = ['ticket', ticketId]
  const { data: t, error } = useQuery({
    queryKey: key,
    queryFn: () => get<TicketFull>(`/api/tickets/${ticketId}`),
    refetchInterval: 10_000,
  })
  const { data: git } = useQuery({
    queryKey: ['ticket-git', ticketId],
    queryFn: () => get<TicketGit>(`/api/tickets/${ticketId}/git`),
    refetchInterval: 30_000,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['tickets', id] })
    qc.invalidateQueries({ queryKey: ['ticket-git', ticketId] })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const update = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch(`/api/tickets/${ticketId}`, p),
    onSuccess: invalidate,
    onError,
  })
  const remove = useMutation({
    mutationFn: () => del(`/api/tickets/${ticketId}`),
    onSuccess: () => {
      invalidate()
      navigate({ to: '/projects/$id/features', params: { id } })
    },
    onError,
  })
  const [editing, setEditing] = useState(false)

  if (error) return <p className="text-sm text-destructive">{errorMessage(error)}</p>
  if (!t) return null

  return (
    <div className="space-y-6">
      <Link
        to="/projects/$id/features"
        params={{ id }}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Ongoing features
      </Link>

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="text-muted-foreground">#{t.id}</span> {t.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              opened by <Actor name={t.createdBy} /> {ago(t.createdAt)}
            </span>
            <span>updated {ago(t.updatedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={t.status}
            onChange={(e) => update.mutate({ status: e.target.value })}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
            <Pencil data-icon="inline-start" /> Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" />}>
              <Trash2 />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this ticket?</AlertDialogTitle>
                <AlertDialogDescription>
                  Tasks, updates, attachments and the thread go with it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {editing ? (
        <EditTicket
          t={t}
          onSave={(p) => update.mutate(p, { onSuccess: () => setEditing(false) })}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-6">
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 text-sm font-medium">Instructions</h2>
              {t.body ? (
                <Markdown>{t.body}</Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">No instructions yet.</p>
              )}
            </section>
            <Tasks t={t} onChange={invalidate} />
            <Updates t={t} onChange={invalidate} />
            <section>
              <h2 className="mb-3 text-sm font-medium">Thread</h2>
              <Thread parentType="ticket" parentId={t.id} />
            </section>
          </div>
          <aside className="space-y-4">
            <GitPanel t={t} git={git} onChange={invalidate} />
          </aside>
        </div>
      )}
    </div>
  )
}

function EditTicket({
  t,
  onSave,
  onCancel,
}: {
  t: TicketFull
  onSave: (p: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(t.title)
  const [body, setBody] = useState(t.body)
  const [assignee, setAssignee] = useState(t.assignee)
  const [branch, setBranch] = useState(t.branch)
  const [baseBranch, setBaseBranch] = useState(t.baseBranch)
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ title, body, assignee, branch, baseBranch })
      }}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        placeholder="Instructions (markdown)"
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="assignee (claude, codex…)"
        />
        <Input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch"
          className="font-mono"
        />
        <Input
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          placeholder="base branch"
          className="font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  )
}

function Tasks({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const [text, setText] = useState('')
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: () => post(`/api/tickets/${t.id}/tasks`, { tasks: [text] }),
    onSuccess: () => {
      setText('')
      onChange()
    },
    onError,
  })
  const toggle = useMutation({
    mutationFn: (v: { id: number; done: boolean }) => patch(`/api/tasks/${v.id}`, { done: v.done }),
    onSuccess: onChange,
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/tasks/${id}`),
    onSuccess: onChange,
    onError,
  })
  const pct = t.progress.total ? Math.round((100 * t.progress.done) / t.progress.total) : 0
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Tasks</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t.progress.done}/{t.progress.total} · {pct}%
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="space-y-1.5">
        {t.tasks.map((task) => (
          <li key={task.id} className="group flex items-center gap-2 text-sm">
            <Checkbox
              checked={task.done}
              onCheckedChange={(v) => toggle.mutate({ id: task.id, done: Boolean(v) })}
            />
            <span className={task.done ? 'text-muted-foreground line-through' : ''}>{task.text}</span>
            <button
              type="button"
              className="ml-auto opacity-0 group-hover:opacity-100"
              onClick={() => remove.mutate(task.id)}
              title="remove"
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) add.mutate()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task"
          className="h-8"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
          <Plus data-icon="inline-start" /> Add
        </Button>
      </form>
    </section>
  )
}

function Updates({ t, onChange }: { t: TicketFull; onChange: () => void }) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = await Promise.all(files.map((f) => upload(f).then((a) => a.id)))
      return post(`/api/tickets/${t.id}/updates`, { body, attachmentIds })
    },
    onSuccess: () => {
      setBody('')
      setFiles([])
      onChange()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section>
      <h2 className="mb-3 text-sm font-medium">Updates</h2>
      <form
        className="mb-4 space-y-2 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) send.mutate()
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="Post progress (markdown). Agents post here too, with screenshots and recordings."
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,.md,.txt,.log,.pdf"
            onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
            <Paperclip data-icon="inline-start" /> attach
          </Button>
          {files.map((f, i) => (
            <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {f.name}
            </span>
          ))}
          <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || send.isPending}>
            {send.isPending ? 'Posting…' : 'Post update'}
          </Button>
        </div>
      </form>
      {t.updates.length === 0 ? (
        <Empty>No updates yet.</Empty>
      ) : (
        <div className="space-y-3">
          {t.updates.map((u) => (
            <UpdateCard key={u.id} u={u} />
          ))}
        </div>
      )}
    </section>
  )
}

function UpdateCard({ u }: { u: UpdateRow }) {
  const [thread, setThread] = useState(false)
  return (
    <article className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Actor name={u.author} className="text-foreground" />
        <span title={stamp(u.createdAt)}>{ago(u.createdAt)}</span>
        <button type="button" className="ml-auto hover:text-foreground" onClick={() => setThread((v) => !v)}>
          {thread ? 'hide thread' : 'thread'}
        </button>
      </div>
      <Markdown className="mt-2">{u.body}</Markdown>
      <Attachments items={u.attachments} />
      {thread && (
        <div className="mt-3 border-t pt-3">
          <Thread parentType="update" parentId={u.id} compact />
        </div>
      )}
    </article>
  )
}

function GitPanel({ t, git, onChange }: { t: TicketFull; git?: TicketGit; onChange: () => void }) {
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: () => post(`/api/tickets/${t.id}/workspaces`, { name, branch }),
    onSuccess: () => {
      setName('')
      setBranch('')
      onChange()
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/workspaces/${id}`),
    onSuccess: onChange,
    onError,
  })
  const Info = ({ info }: { info: TicketGit['info'] }) =>
    info.exists ? (
      <div className="text-xs text-muted-foreground">
        <span className="font-mono">{shortSha(info.sha!)}</span> {info.subject}
        <div>
          {info.ahead != null && (
            <>
              +{info.ahead} / −{info.behind} vs base ·{' '}
            </>
          )}
          {ago(info.authoredAt)}
        </div>
      </div>
    ) : (
      <div className="text-xs text-muted-foreground">branch not in the checkout yet</div>
    )
  return (
    <>
      <section className="rounded-lg border p-3">
        <h2 className="mb-2 text-sm font-medium">Branch</h2>
        {t.branch ? (
          <>
            <div className="inline-flex items-center gap-1 font-mono text-sm">
              <GitBranch className="size-3.5" /> {t.branch}
            </div>
            <div className="text-xs text-muted-foreground">base {t.baseBranch}</div>
            {git && <Info info={git.info} />}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No branch yet. Edit the ticket or let the agent set it.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs">
          {t.assignee ? (
            <>
              <span className="text-muted-foreground">assignee</span> <Actor name={t.assignee} />
            </>
          ) : (
            <span className="text-muted-foreground">unassigned</span>
          )}
        </div>
      </section>
      <section className="rounded-lg border p-3">
        <h2 className="mb-2 text-sm font-medium">Workspaces</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Worktrees, sub-branches and subagent sandboxes opened for this ticket.
        </p>
        <ul className="space-y-2">
          {(git?.workspaces ?? t.workspaces.map((w) => ({ ...w, info: null, worktree: null }))).map((w) => (
            <li key={w.id} className="group text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{w.name}</span>
                {w.agent && <Badge variant="secondary">{w.agent}</Badge>}
                <button
                  type="button"
                  className="ml-auto opacity-0 group-hover:opacity-100"
                  onClick={() => remove.mutate(w.id)}
                  title="remove"
                >
                  <X className="size-3.5 text-muted-foreground" />
                </button>
              </div>
              {w.branch && <div className="font-mono text-xs">{w.branch}</div>}
              {w.info && <Info info={w.info} />}
              {w.worktree && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={w.worktree.path}>
                  {w.worktree.path}
                </div>
              )}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className="h-7 text-xs"
          />
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch"
            className="h-7 font-mono text-xs"
          />
          <Button type="submit" size="xs" variant="outline" disabled={!name.trim()}>
            <Plus data-icon="inline-start" /> Add workspace
          </Button>
        </form>
      </section>
    </>
  )
}
