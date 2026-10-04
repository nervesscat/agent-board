import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Copy, FolderGit2, GitBranch, Layers, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { ReachBadge } from '#/components/ReachBadge'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#/components/ui/table'
import { errorMessage, get, type CleanupReport } from '#/lib/api'
import { shortSha } from '#/lib/format'
import { useStages } from '#/lib/project'
import { stageOf } from '#/lib/stages'

export const Route = createFileRoute('/projects/$id/cleanup')({ component: Cleanup })

type Leftover = CleanupReport['tickets'][number]
type Row = { ticket: Leftover; branch: Leftover['branches'][number] | null }

const GROUPS = [
  {
    key: 'safe',
    title: 'Safe to delete',
    hint: 'Every commit, or the same patches, are in the base.',
  },
  {
    key: 'edited',
    title: 'Edited but present',
    hint: 'The commits changed on the way in, but merging the branch would add nothing.',
  },
  {
    key: 'unique',
    title: 'Still has unique work',
    hint: 'The branch has changes its bases lack. Keep it, or check where the work went.',
  },
  {
    key: 'other',
    title: 'Nothing to compare',
    hint: 'Workspaces still registered without a branch, or a branch with no base to check against.',
  },
] as const

const groupOf = (r: Row): (typeof GROUPS)[number]['key'] => {
  const state = r.branch?.reach?.state
  if (state === 'merged' || state === 'rebased') return 'safe'
  if (state === 'edited' || state === 'unique') return state
  return 'other'
}

const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    (err) => toast.error(errorMessage(err)),
  )

function Cleanup() {
  const { id } = Route.useParams()
  const stages = useStages(id)
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['cleanup', id],
    queryFn: () => get<CleanupReport>(`/api/projects/${id}/cleanup`),
  })
  const rows = (data?.tickets ?? []).flatMap<Row>((ticket) =>
    ticket.branches.length
      ? ticket.branches.map((branch) => ({ ticket, branch }))
      : [{ ticket, branch: null }],
  )
  const remote = rows.filter((r) => r.branch?.remote)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cleanup</h1>
          <p className="text-sm text-muted-foreground">
            Done and cancelled tickets that still have worktrees, branches, registered workspaces or a running
            preview, each branch checked against where its work should have landed: a lane's parent branch,
            then the parent's base. Read-only; agents delete with{' '}
            <span className="font-mono">/board cleanup</span> after you approve.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : !rows.length && !data?.untracked.length ? (
        <Empty>Nothing left behind. Every closed ticket is cleaned up.</Empty>
      ) : (
        <>
          {GROUPS.map((g) => {
            const items = rows.filter((r) => groupOf(r) === g.key)
            if (!items.length) return null
            return (
              <section key={g.key} className="space-y-1.5">
                <h2 className="text-sm font-medium">
                  {g.title} <span className="text-muted-foreground">· {items.length}</span>
                </h2>
                <p className="text-xs text-muted-foreground">{g.hint}</p>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ticket</TableHead>
                        <TableHead>Branch</TableHead>
                        <TableHead>Reach</TableHead>
                        <TableHead>Worktree</TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead className="w-8" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map(({ ticket: t, branch: b }) => (
                        <TableRow key={`${t.id}:${b?.name ?? ''}`}>
                          <TableCell className="max-w-72">
                            <Link
                              to="/projects/$id/features/$ticketId"
                              params={{ id, ticketId: String(t.id) }}
                              className="flex items-center gap-1 truncate font-medium hover:underline"
                            >
                              {t.parentId && <Layers className="size-3 shrink-0 text-muted-foreground" />}
                              <span className="truncate">{t.title}</span>
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              #{t.id} · {stages.length ? stageOf(stages, t.status).name : t.status}
                              {t.workspaces.length > 0 &&
                                ` · ${t.workspaces.length} workspace${t.workspaces.length > 1 ? 's' : ''} registered`}
                            </div>
                            {t.previews.map((p) => (
                              <div key={p.workspaceId} className="text-xs text-amber-700 dark:text-amber-400">
                                preview {p.status === 'running' ? `running on :${p.port}` : p.status}: stop it
                                on the ticket
                              </div>
                            ))}
                          </TableCell>
                          <TableCell>
                            {b ? (
                              <>
                                <div className="inline-flex items-center gap-1 font-mono text-xs">
                                  <GitBranch className="size-3" /> {b.name}
                                </div>
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {b.local ? shortSha(b.local) : 'not local'}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t.workspaces.map((w) => w.name).join(', ')}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {b?.reach ? (
                              <ReachBadge reach={b.reach} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-64">
                            {b?.worktrees.map((w) => (
                              <div
                                key={w.path}
                                className="flex items-center gap-1 truncate font-mono text-[11px]"
                                title={w.path}
                              >
                                <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                                <span className="truncate">{w.main ? 'main checkout' : w.path}</span>
                              </div>
                            ))}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {b?.remote ? shortSha(b.remote) : ''}
                          </TableCell>
                          <TableCell>
                            {b?.restore && (
                              <button
                                type="button"
                                title={`Copy the restore command: ${b.restore}`}
                                onClick={() => copy(b.restore!)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )
          })}
          {remote.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-medium">
                Branches left on origin <span className="text-muted-foreground">· {remote.length}</span>
              </h2>
              <p className="text-xs text-muted-foreground">
                The board never writes to git, so these are yours to delete. As of the last fetch.
              </p>
              <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
                <pre className="flex-1 overflow-x-auto font-mono text-xs">
                  {`git push origin --delete ${remote.map((r) => r.branch!.name).join(' ')}`}
                </pre>
                <button
                  type="button"
                  title="Copy"
                  onClick={() =>
                    copy(`git push origin --delete ${remote.map((r) => r.branch!.name).join(' ')}`)
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Check the reach first: a branch with unique work may still be needed.
              </p>
            </section>
          )}
          {!!data?.untracked.length && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-medium">
                Untracked worktrees <span className="text-muted-foreground">· {data.untracked.length}</span>
              </h2>
              <p className="text-xs text-muted-foreground">
                Worktrees no ticket or workspace accounts for. Register them on their ticket, or remove them.
              </p>
              <ul className="space-y-1 rounded-lg border p-3">
                {data.untracked.map((w) => (
                  <li key={w.path} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                    <span className="text-muted-foreground">{w.repo}</span>
                    <span className="truncate" title={w.path}>
                      {w.path}
                    </span>
                    <span className="text-muted-foreground">
                      {w.branch ?? (w.head ? `detached ${shortSha(w.head)}` : '')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
