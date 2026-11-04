import { createFileRoute } from '@tanstack/react-router'
import { FolderGit2, Plus } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'

import { Empty } from '#/components/Empty'
import { RepoDialog } from '#/components/RepoDialog'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import type { Repo } from '#/lib/api'
import { useProject } from '#/lib/project'

export const Route = createFileRoute('/projects/$id/repositories')({ component: Repositories })

/** Subscribing to nothing: the value never changes, only what the first render sees differs. */
const noSubscribe = () => () => {}

/**
 * False on the server and in the first render in the browser, which must match the server's HTML. The
 * projects may already be cached by then (the project layout asks for it while this page waits for its chunk),
 * and a list drawn from that cache would not match the skeleton the server sent.
 */
function useHydrated() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            The checkouts of this project the board reads. Its PR queue, features, reviews and daily log span
            all of them. Edit one to move it to another project.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
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
