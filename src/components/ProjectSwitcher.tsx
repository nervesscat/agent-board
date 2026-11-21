import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Check, ChevronsUpDown, FolderGit2, Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { KindPicker } from '#/components/KindPicker'
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
import { type Kind, DEFAULT_KINDS } from '#/lib/kinds'
import { useProjects } from '#/lib/project'
import { projectTabSearch, validateSettingsSearch } from '#/lib/settingsTabs'
import { useHydrated } from '#/lib/useHydrated'

// The project's Overview is its own address (no module segment); the rest keep their segment.
const MODULES = ['overview', 'prs', 'features', 'daily', 'settings'] as const

/** The project everything below the top bar is about. Switching keeps you on the same module. */
export function ProjectSwitcher() {
  const { t } = useTranslation()
  const { data: projects } = useProjects()
  const params = useParams({ strict: false }) as { id?: string }
  const { pathname } = useLocation()
  // On the Settings page's project tab the project is the address's.
  const search = validateSettingsSearch(useSearch({ strict: false }) as Record<string, unknown>)
  const onProjectTab = pathname === '/settings' && search.tab === 'project' && search.project !== undefined
  const id = params.id ?? (onProjectTab ? String(search.project) : undefined)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  // Read after mount: /api/projects can answer before React has hydrated this page, and a name drawn
  // from it would not match the server's "Select a project".
  const hydrated = useHydrated()
  const current = hydrated ? projects?.find((p) => String(p.id) === id) : undefined
  const module = onProjectTab
    ? 'settings'
    : (MODULES.find((m) => (pathname.split('/')[3] || 'overview') === m) ?? 'overview')
  const go = (projectId: number | string) =>
    module === 'settings'
      ? navigate({ to: '/settings', search: projectTabSearch(projectId) })
      : navigate({
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
          aria-label={t('projectSwitcher.project')}
        >
          <span className={current ? 'min-w-0 truncate' : 'min-w-0 truncate text-muted-foreground'}>
            {current?.name ?? t('projectSwitcher.select')}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-0 p-1">
          {projects?.length ? (
            <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
              {t('projectSwitcher.projects')}
            </div>
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
                {t('projectSwitcher.repos', { count: p.repos.length })}
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
            <Plus className="size-4 shrink-0" /> {t('projectSwitcher.newProject')}
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
              <Settings2 className="size-4 shrink-0" /> {t('projectSwitcher.manage')}
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
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [kinds, setKinds] = useState<Kind[]>([...DEFAULT_KINDS])
  const create = useMutation({
    mutationFn: () => post<Project>('/api/projects', { name, kinds }),
    onSuccess: async (p) => {
      // The list holds the new project before anything navigates to it: a page that checks the address's
      // project against the list (Settings) would take it for a project that is gone.
      await qc.invalidateQueries({ queryKey: ['projects'] })
      onOpenChange(false)
      setName('')
      setKinds([...DEFAULT_KINDS])
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
            <DialogTitle>{t('projectSwitcher.newTitle')}</DialogTitle>
            <DialogDescription>{t('projectSwitcher.newDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('projectSwitcher.name')}
            required
            autoFocus
          />
          <KindPicker value={kinds} onChange={setKinds} />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {t('projectSwitcher.create')}
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
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('projectSwitcher.projects')}</DialogTitle>
          <DialogDescription>{t('projectSwitcher.manageDescription')}</DialogDescription>
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
  const { t } = useTranslation()
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
      toast.success(t('projectSwitcher.renamed', { name }))
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
  const repos = t('projectSwitcher.repos', { count: p.repos.length })
  const tickets = t('projectSwitcher.tickets', { count: p.counts.tickets })
  const openPrs = t('projectSwitcher.openPrs', { count: p.counts.openPrs })

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
          aria-label={t('projectSwitcher.nameOf', { name: p.name })}
          required
        />
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || name === p.name}>
          {t('projectSwitcher.rename')}
        </Button>
        <AlertDialog>
          <Tip content={t('projectSwitcher.deleteName', { name: p.name })}>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('projectSwitcher.deleteName', { name: p.name })}
                />
              }
            >
              <TrashIcon />
            </AlertDialogTrigger>
          </Tip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('projectSwitcher.deleteTitle', { name: p.name })}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('projectSwitcher.deleteText', { repos, tickets, openPrs })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('projectSwitcher.keep')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>
                {t('projectSwitcher.delete')}
              </AlertDialogAction>
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
          <span>{t('projectSwitcher.noRepos')}</span>
        )}
        <span className="ml-auto">{t('projectSwitcher.counts', { tickets, openPrs })}</span>
      </div>
    </li>
  )
}
