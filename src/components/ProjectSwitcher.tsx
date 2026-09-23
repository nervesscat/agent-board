import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { errorMessage, post, type Project } from '#/lib/api'
import { useProjects } from '#/lib/project'

const NEW = '__new__'
const MODULES = ['prs', 'features', 'reviews', 'daily', 'settings'] as const

/** The project everything below the top bar is about. Switching keeps you on the same module. */
export function ProjectSwitcher() {
  const { data: projects } = useProjects()
  const { id } = useParams({ strict: false }) as { id?: string }
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const module = MODULES.find((m) => pathname.split('/')[3] === m) ?? 'prs'
  const go = (projectId: number | string) =>
    navigate({ to: `/projects/$id/${module}`, params: { id: String(projectId) } })

  const items = Object.fromEntries([
    ...(projects ?? []).map((p) => [String(p.id), p.name]),
    [NEW, 'New project…'],
  ])
  return (
    <>
      <Select
        value={id ?? null}
        onValueChange={(v) => (v === NEW ? setCreating(true) : v && go(v as string))}
        items={items}
      >
        <SelectTrigger size="sm" className="min-w-40" aria-label="Project">
          <SelectValue placeholder="Select a project" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {projects?.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name}
              <span className="text-xs text-muted-foreground">
                {p.repos.length} repo{p.repos.length === 1 ? '' : 's'}
              </span>
            </SelectItem>
          ))}
          {projects?.length ? <SelectSeparator /> : null}
          <SelectItem value={NEW}>New project…</SelectItem>
        </SelectContent>
      </Select>
      <NewProject open={creating} onOpenChange={setCreating} onCreated={(p) => go(p.id)} />
    </>
  )
}

function NewProject({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (p: Project) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => post<Project>('/api/projects', { name }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      onOpenChange(false)
      setName('')
      onCreated(p)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project groups repositories. Add its repos from the Repositories page.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            autoFocus
          />
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
