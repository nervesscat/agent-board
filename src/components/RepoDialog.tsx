import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { BranchSelect } from '#/components/BranchSelect'
import { FolderPicker } from '#/components/FolderPicker'
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
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { del, errorMessage, patch, post, type Repo } from '#/lib/api'
import { useProjects } from '#/lib/project'

const NEW = '__new__'

/** Add a repo (repo undefined) or edit one: its project, name, checkout and base branch. */
export function RepoDialog({
  open,
  onOpenChange,
  repo,
  defaultProjectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo?: Repo
  defaultProjectId?: number
}) {
  const qc = useQueryClient()
  const { data: projects } = useProjects()
  const [projectId, setProjectId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => {
    if (!open) return
    setProjectId(String(repo?.projectId ?? defaultProjectId ?? projects?.[0]?.id ?? NEW))
    setProjectName('')
    setName(repo?.name ?? '')
    setRepoPath(repo?.repoPath ?? '')
    setBaseBranch(repo?.baseBranch ?? 'main')
    // Only when the dialog opens: the project list arriving later must not reset what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])
  const isNew = projectId === NEW || !projects?.length
  const done = () => {
    qc.invalidateQueries({ queryKey: ['repos'] })
    qc.invalidateQueries({ queryKey: ['projects'] })
    qc.invalidateQueries({ queryKey: ['project'] })
    onOpenChange(false)
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const save = useMutation({
    mutationFn: () => {
      const target = isNew ? { projectName } : { projectId: Number(projectId) }
      if (!repo) return post<Repo>('/api/repos', { ...target, name, repoPath, baseBranch })
      // Moving to a new project: create it first, then move the repo into it.
      const project = isNew ? post<{ id: number }>('/api/projects', { name: projectName }) : null
      return (project ?? Promise.resolve({ id: Number(projectId) })).then((p) =>
        patch<Repo>(`/api/repos/${repo.id}`, { projectId: p.id, name, repoPath, baseBranch }),
      )
    },
    onSuccess: done,
    onError,
  })
  const remove = useMutation({ mutationFn: () => del(`/api/repos/${repo!.id}`), onSuccess: done, onError })
  const projectItems = Object.fromEntries([
    ...(projects ?? []).map((p) => [String(p.id), p.name]),
    [NEW, 'New project…'],
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{repo ? `Edit ${repo.name}` : 'New repository'}</DialogTitle>
            <DialogDescription>
              A local git checkout. The board reads it with git and gh; it never writes to it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="project">Project</Label>
            {projects?.length ? (
              <Select value={projectId} onValueChange={(v) => setProjectId(v as string)} items={projectItems}>
                <SelectTrigger id="project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW}>New project…</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {isNew && (
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name"
                required
              />
            )}
            {repo && !isNew && Number(projectId) !== repo.projectId && (
              <p className="text-xs text-muted-foreground">
                Its PRs, tickets and review results move with it.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="path">Repository path</Label>
            <div className="flex gap-2">
              <Input
                id="path"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/home/you/code/… or C:\code\…"
                required
                className="font-mono"
              />
              <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
                <FolderOpen data-icon="inline-start" /> Browse…
              </Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="from GitHub or the folder"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="base">Base branch</Label>
              <BranchSelect
                id="base"
                value={baseBranch}
                onChange={setBaseBranch}
                repoId={repo && repoPath === repo.repoPath ? repo.id : undefined}
                repoPath={repoPath}
              />
            </div>
          </div>
          <DialogFooter className="items-center">
            {repo && (
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button type="button" variant="ghost" className="mr-auto text-destructive" />}
                >
                  Remove repo
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove {repo.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its PR queue entries go with it. Tickets and review results stay in the project, but its
                      PR tickets go with it. The checkout on disk is untouched.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove.mutate()}>Remove</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : repo ? 'Save' : 'Add repository'}
            </Button>
          </DialogFooter>
        </form>
        <FolderPicker
          open={browsing}
          onOpenChange={setBrowsing}
          // Start next to the current checkout, so picking a sibling repo is one click.
          start={repoPath ? repoPath.replace(/[\\/]+[^\\/]*[\\/]*$/, '') || undefined : undefined}
          onPick={setRepoPath}
        />
      </DialogContent>
    </Dialog>
  )
}
