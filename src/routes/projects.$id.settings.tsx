import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
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
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { del, errorMessage, patch } from '#/lib/api'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/settings')({ component: Settings })

function Settings() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: p } = useProject(id)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  useEffect(() => {
    if (!p) return
    setName(p.name)
    setInstructions(p.instructions)
  }, [p])
  const save = useMutation({
    mutationFn: () => patch(`/api/projects/${id}`, { name, instructions }),
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
          working here: conventions, how to run things, what never to do. They apply to all its repos.
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="n">Name</Label>
          <Input id="n" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>Repositories</Label>
          <ul className="space-y-1 text-sm">
            {p.repos.map((r) => (
              <li key={r.id} className="flex items-center gap-1.5 truncate" title={r.repoPath}>
                <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" /> {r.name}
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {r.githubRepo ?? r.repoPath}
                </span>
              </li>
            ))}
          </ul>
          <Link to="/" className="text-xs text-muted-foreground underline hover:text-foreground">
            Add, move or remove repos on the Repositories page
          </Link>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
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
                Its repos, and every ticket, PR note, review and activity line of this project go with it. The
                checkouts on disk are untouched.
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
