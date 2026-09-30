import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { FolderGit2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { StagesEditor } from '#/components/StagesEditor'
import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { errorMessage, patch } from '#/lib/api'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/settings')({ component: Settings })

function Settings() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const { data: p } = useProject(id)
  const [instructions, setInstructions] = useState('')
  useEffect(() => {
    if (p) setInstructions(p.instructions)
  }, [p])
  const save = useMutation({
    mutationFn: () => patch(`/api/projects/${id}`, { instructions }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!p) return null
  return (
    <div className="space-y-10">
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
        <div className="flex items-start gap-4">
          <Button type="submit" disabled={save.isPending || instructions === p.instructions}>
            Save
          </Button>
          <div className="ml-auto space-y-1 text-right text-sm">
            <ul className="space-y-0.5">
              {p.repos.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-end gap-1.5 text-muted-foreground"
                  title={r.repoPath}
                >
                  <FolderGit2 className="size-3.5 shrink-0" />
                  <span className="font-mono text-xs">{r.githubRepo ?? r.repoPath}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Repos:{' '}
              <Link to="/" className="underline hover:text-foreground">
                Repositories page
              </Link>
              . Rename or delete the project: project menu → Manage projects.
            </p>
          </div>
        </div>
      </form>
      <StagesEditor projectId={id} />
    </div>
  )
}
