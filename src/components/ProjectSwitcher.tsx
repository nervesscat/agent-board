import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { Check, ChevronsUpDown, FolderGit2, Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover'
import { Tip } from '#/components/ui/tooltip'
import { del, errorMessage, patch, post, type Project, type ProjectRow } from '#/lib/api'
import { useProjects } from '#/lib/project'

// The project's Overview is its own address (no module segment); the rest keep their segment.
const MODULES = ['overview', 'prs', 'features', 'daily', 'settings'] as const

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The project everything below the top bar is about. Switching keeps you on the same module. */
export function ProjectSwitcher() {
  const { data: projects } = useProjects()
  const { id } = useParams({ strict: false }) as { id?: string }
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const current = projects?.find((p) => String(p.id) === id)
  const module = MODULES.find((m) => (pathname.split('/')[3] || 'overview') === m) ?? 'overview'
  const go = (projectId: number | string) =>
    navigate({
      to: module === 'overview' ? '/projects/$id' : `/projects/$id/${module}`,
      params: { id: String(projectId) },
    })
  const item =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground'

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              style={{ minWidth: 0 }}
              className="min-w-0 shrink justify-between font-normal sm:w-44"
            />
          }
          aria-label="Project"
        >
          <span className={current ? 'min-w-0 truncate' : 'min-w-0 truncate text-muted-foreground'}>
            {current?.name ?? 'Select a project'}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-0 p-1">
          {projects?.length ? (
            <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Projects</div>
          ) : null}
          {projects?.map((p) => (
            <button
              key={p.id}
              type="button"
              className={item}
              onClick={() => {
                setOpen(false)
                go(p.id)
              }}
            >
              <Check className={`size-4 shrink-0 ${p.id === current?.id ? '' : 'invisible'}`} />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {plural(p.repos.length, 'repo')}
              </span>
            </button>
          ))}
          {projects?.length ? <div className="-mx-1 my-1 h-px bg-border" /> : null}
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false)
              setCreating(true)
            }}
          >
            <Plus className="size-4 shrink-0" /> New project…
          </button>
          {projects?.length ? (
            <button
              type="button"
              className={item}
              onClick={() => {
                setOpen(false)
                setManaging(true)
              }}
            >
              <Settings2 className="size-4 shrink-0" /> Manage projects…
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
      <NewProject open={creating} onOpenChange={setCreating} onCreated={(p) => go(p.id)} />
      <ManageProjects
        open={managing}
        onOpenChange={setManaging}
        projects={projects ?? []}
        onDeleted={(p) => p.id === current?.id && navigate({ to: '/' })}
      />
    </>
  )
}

export function NewProject({
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
              A project groups repositories. Add its repos from its Repositories page.
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

/** Rename and delete projects in one place. Repos are added and moved on each project's Repositories page. */
function ManageProjects({
  open,
  onOpenChange,
  projects,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectRow[]
  onDeleted: (p: ProjectRow) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
          <DialogDescription>
            Rename or delete a project. Add, move or remove its repos on its Repositories page.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-md border">
          {projects.map((p) => (
            <ProjectRowEditor key={p.id} p={p} onDeleted={() => onDeleted(p)} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

function ProjectRowEditor({ p, onDeleted }: { p: ProjectRow; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(p.name)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['projects'] })
    qc.invalidateQueries({ queryKey: ['project', String(p.id)] })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const rename = useMutation({
    mutationFn: () => patch(`/api/projects/${p.id}`, { name }),
    onSuccess: () => {
      refresh()
      toast.success(`Renamed to ${name}`)
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: () => del(`/api/projects/${p.id}`),
    onSuccess: () => {
      refresh()
      qc.invalidateQueries({ queryKey: ['repos'] })
      onDeleted()
    },
    onError,
  })
  const goes = [
    plural(p.repos.length, 'repo'),
    plural(p.counts.tickets, 'ticket'),
    plural(p.counts.openPrs, 'open PR'),
  ].join(', ')

  return (
    <li className="space-y-1.5 p-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && name !== p.name) rename.mutate()
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8"
          aria-label={`Name of ${p.name}`}
          required
        />
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || name === p.name}>
          Rename
        </Button>
        <AlertDialog>
          <Tip content={`Delete ${p.name}`}>
            <AlertDialogTrigger
              render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} />}
            >
              <TrashIcon />
            </AlertDialogTrigger>
          </Tip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Goes with it: {goes}, and its reviews and daily log. The checkouts on disk are untouched. To
                keep a repo, move it to another project first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </form>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {p.repos.length ? (
          p.repos.map((r) => (
            <Tip key={r.id} content={r.repoPath}>
              <span className="inline-flex items-center gap-1 font-mono">
                <FolderGit2 className="size-3" /> {r.name}
              </span>
            </Tip>
          ))
        ) : (
          <span>no repos</span>
        )}
        <span className="ml-auto">
          {plural(p.counts.tickets, 'ticket')} · {plural(p.counts.openPrs, 'open PR')}
        </span>
      </div>
    </li>
  )
}
