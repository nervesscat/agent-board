import { createFileRoute } from '@tanstack/react-router'
import { FolderGit2, Plus } from 'lucide-react'
import { useState } from 'react'

import { Empty } from '#/components/Empty'
import { RepoDialog } from '#/components/RepoDialog'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import type { Repo } from '#/lib/api'
import { useProject } from '#/lib/project'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/projects/$id/repositories')({ component: Repositories })

function Repositories() {
  const { id } = Route.useParams()
  const { data: project, isLoading } = useProject(id)
  const hydrated = useHydrated()
  const [editing, setEditing] = useState<Repo | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  // Only this project's repos; one moved to another project (edit dialog) leaves the list.
  const repos = project?.repos ?? []
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-muted-foreground">Checkouts this project reads.</p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" /> New repository
        </Button>
      </div>
      {!hydrated || isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : repos.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setEditing(r)
                setEditOpen(true)
              }}
              className="group min-w-0 text-left"
            >
              <Card className="h-full transition-colors group-hover:border-foreground/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FolderGit2 className="size-4 text-muted-foreground" /> {r.name}
                  </CardTitle>
                  <CardDescription className="truncate font-mono text-xs">
                    {r.githubRepo ?? r.repoPath}
                  </CardDescription>
                </CardHeader>
                <CardContent className="truncate text-xs text-muted-foreground">
                  base {r.baseBranch} · <span className="font-mono">{r.repoPath}</span>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      ) : (
        <Empty>No repositories in this project yet. Add one: the path of a local git checkout.</Empty>
      )}
      <RepoDialog open={adding} onOpenChange={setAdding} defaultProjectId={Number(id)} />
      {/* The repo stays set while the dialog animates closed, so its title does not flip. */}
      {editing && <RepoDialog open={editOpen} onOpenChange={setEditOpen} repo={editing} />}
    </div>
  )
}
