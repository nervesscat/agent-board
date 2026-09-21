import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

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
import { BranchSelect } from '#/components/BranchSelect'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { del, errorMessage, get, patch, type Project } from '#/lib/api'

export const Route = createFileRoute('/projects/$id/settings')({ component: Settings })

function Settings() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: p } = useQuery({
    queryKey: ['project', id],
    queryFn: () => get<Project>(`/api/projects/${id}`),
  })
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [instructions, setInstructions] = useState('')
  useEffect(() => {
    if (!p) return
    setName(p.name)
    setRepoPath(p.repoPath)
    setBaseBranch(p.baseBranch)
    setInstructions(p.instructions)
  }, [p])
  const save = useMutation({
    mutationFn: () => patch(`/api/projects/${id}`, { name, repoPath, baseBranch, instructions }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: () => del(`/api/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate({ to: '/' })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!p) return null
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Instructions</h1>
        <p className="text-sm text-muted-foreground">
          What every agent reads (via <code className="rounded bg-muted px-1">get_project</code>) before
          working here: conventions, how to run things, what never to do.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="ins">Project instructions (markdown)</Label>
        <Textarea
          id="ins"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={14}
          className="font-mono text-xs"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="n">Name</Label>
          <Input id="n" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="r">Repository path</Label>
          <Input
            id="r"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="font-mono"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="b">Base branch</Label>
          <BranchSelect id="b" value={baseBranch} onChange={setBaseBranch} projectId={id} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        <span className="text-xs text-muted-foreground">
          GitHub: {p.githubRepo ?? 'not detected (gh repo view failed)'}
        </span>
        <AlertDialog>
          <AlertDialogTrigger
            render={<Button type="button" variant="ghost" className="ml-auto text-destructive" />}
          >
            Delete project
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Every ticket, PR note, review and activity line of this project goes with it. The checkout on
                disk is untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </form>
  )
}
