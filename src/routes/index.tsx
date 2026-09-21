import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { FolderGit2, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { BranchSelect } from '#/components/BranchSelect'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
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
import { errorMessage, get, post, type Project } from '#/lib/api'

export const Route = createFileRoute('/')({ component: Projects })

function Projects() {
  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<Project[]>('/api/projects'),
  })
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Pick a project to see its PR queue, ongoing features, reviews and daily log.
          </p>
        </div>
        <NewProject />
      </div>
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <Link key={p.id} to="/projects/$id/prs" params={{ id: String(p.id) }} className="group">
              <Card className="h-full transition-colors group-hover:border-foreground/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FolderGit2 className="size-4 text-muted-foreground" /> {p.name}
                  </CardTitle>
                  <CardDescription className="truncate font-mono text-xs">
                    {p.githubRepo ?? p.repoPath}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">base {p.baseBranch}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Empty>No projects yet. Add one: a name and the path of a local git checkout.</Empty>
      )}
    </div>
  )
}

function NewProject() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const create = useMutation({
    mutationFn: () => post<Project>('/api/projects', { name, repoPath, baseBranch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      setOpen(false)
      setName('')
      setRepoPath('')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus data-icon="inline-start" /> New project
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              The board reads the checkout with git and gh; it never writes to it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="path">Repository path</Label>
            <Input
              id="path"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="F:\Programming\…"
              required
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="base">Base branch</Label>
            <BranchSelect id="base" value={baseBranch} onChange={setBaseBranch} repoPath={repoPath} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
