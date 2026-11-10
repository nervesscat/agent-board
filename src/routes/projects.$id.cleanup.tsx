import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Copy, FolderGit2, GitBranch, Layers, Paperclip, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Empty } from '#/components/Empty'
import { ReachBadge } from '#/components/ReachBadge'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#/components/ui/table'
import { Tip } from '#/components/ui/tooltip'
import {
  del,
  errorMessage,
  get,
  post,
  type CleanupReport,
  type DeleteItem,
  type DeleteKind,
  type DeleteResult,
} from '#/lib/api'
import { fileSize, shortSha } from '#/lib/format'
import { useStages } from '#/lib/project'
import { stageOf } from '#/lib/stages'

export const Route = createFileRoute('/projects/$id/cleanup')({ component: Cleanup })

type Leftover = CleanupReport['tickets'][number]
type Branch = Leftover['branches'][number]
type Row = { ticket: Leftover; branch: Branch | null }
type Target = { ticket: Leftover; branch: Branch }
/** What the confirmation dialog asks about: one action on the branches listed, nothing else. */
type Pending = { kind: DeleteKind; targets: Target[] }

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
    key: 'kept',
    title: 'Kept',
    hint: "In use by a ticket in work or an open PR, a base, the repo's base branch, the main checkout's branch or origin's default branch: never deleted from here.",
  },
  {
    key: 'other',
    title: 'Nothing to compare',
    hint: 'Workspaces still registered without a branch, or a branch with no base to check against.',
  },
] as const

const groupOf = (r: Row): (typeof GROUPS)[number]['key'] => {
  if (r.branch?.protected) return 'kept'
  const state = r.branch?.reach?.state
  if (state === 'merged' || state === 'rebased') return 'safe'
  if (state === 'edited' || state === 'unique') return state
  return 'other'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Each action's words: on a row, for every eligible row at once, and in the dialog. */
const ACTIONS: Record<
  DeleteKind,
  { row: string; all: string; title: (n: number) => string; confirm: (n: number) => string; what: string }
> = {
  local: {
    row: 'Delete branch',
    all: 'Delete every eligible local branch',
    title: (n) => `Delete ${plural(n, 'local branch', 'local branches')}?`,
    confirm: (n) => `Delete ${plural(n, 'local branch', 'local branches')}`,
    what: 'Each branch goes from the checkout. Origin keeps its copy.',
  },
  remote: {
    row: 'Delete on origin',
    all: 'Delete every eligible branch on origin',
    title: (n) => `Delete ${plural(n, 'branch', 'branches')} on origin?`,
    confirm: (n) => `Delete ${plural(n, 'branch', 'branches')} on origin`,
    what: 'Each branch goes from origin, for everyone who works with it. Local branches stay.',
  },
  worktrees: {
    row: 'Remove worktree + branch',
    all: 'Remove every eligible worktree with its branch',
    title: (n) => `Remove the worktrees of ${plural(n, 'branch', 'branches')}, and the branches?`,
    confirm: (n) => `Remove worktrees and delete ${plural(n, 'branch', 'branches')}`,
    what: 'Each worktree folder goes (ignored files such as node_modules with it), then the local branch. A link in it goes as a link: a folder it leads to out of the worktree stays. Origin keeps its copy.',
  },
}

const itemOf = (kind: DeleteKind, { ticket, branch }: Target): DeleteItem => ({
  ticketId: ticket.id,
  branch: branch.name,
  kind,
  sha: kind === 'remote' ? branch.remote : branch.local,
  ...(kind === 'worktrees' ? { worktrees: branch.worktrees.filter((w) => !w.main).map((w) => w.path) } : {}),
})

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
  const targets = rows.filter((r): r is Target => !!r.branch)
  const eligible = (kind: DeleteKind) => targets.filter((t) => t.branch.can[kind].ok)
  const remote = targets.filter((r) => r.branch.remote)
  const uploads = data?.uploads
  const [confirmSweep, setConfirmSweep] = useState(false)
  const sweep = useMutation({
    mutationFn: () => del<{ deleted: number; bytes: number; failed: number }>('/api/uploads/unattached'),
    onSuccess: (r) => {
      if (r.failed)
        toast.error(
          `Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'}; ${r.failed} could not be deleted and stay for the next run`,
        )
      else toast.success(`Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'} (${fileSize(r.bytes)})`)
      void refetch()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const [pending, setPending] = useState<Pending | null>(null)
  const [results, setResults] = useState<DeleteResult[] | null>(null)
  const ask = (kind: DeleteKind, chosen: Target[]) => {
    if (chosen.length) setPending({ kind, targets: chosen })
  }
  const remove = useMutation({
    mutationFn: (items: DeleteItem[]) =>
      post<DeleteResult[]>(`/api/projects/${id}/cleanup/delete`, { items }),
    onSuccess: (r) => {
      setResults(r)
      const done = r.filter((x) => x.outcome === 'deleted').length
      const kept = r.filter((x) => !x.ok).length
      if (kept) toast.error(`${done} deleted; ${kept} kept: see why below`)
      else toast.success(`${plural(done, 'item')} deleted`)
      void refetch()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const actionsOff = data?.deleteOff ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cleanup</h1>
          <p className="text-sm text-muted-foreground">
            Finished work to clean up, checked against its base.
          </p>
        </div>
        <Button
          className="w-full sm:w-auto"
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw data-icon="inline-start" className={isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Agents may delete local branches that landed ( <span className="font-mono">cleanup_delete</span> );
        removing worktrees and deleting branches on origin stay yours, from this page.
      </p>
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {actionsOff && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm">Deleting is off: {actionsOff}.</p>
      )}
      {data?.repos
        .filter((r) => r.error)
        .map((r) => (
          <p key={r.id} className="text-sm text-destructive">
            {r.name}: {r.error}. Its branches and worktrees are unknown, so nothing in it can be deleted.
          </p>
        ))}
      {results && <Results results={results} onClose={() => setResults(null)} />}
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : !rows.length && !data?.untracked.length ? (
        <Empty>Nothing left behind. Every closed ticket is cleaned up.</Empty>
      ) : (
        <>
          {!actionsOff && (eligible('local').length > 0 || eligible('worktrees').length > 0) && (
            <div className="flex flex-wrap gap-2">
              {(['worktrees', 'local'] as const).map(
                (kind) =>
                  eligible(kind).length > 0 && (
                    <Button
                      key={kind}
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => ask(kind, eligible(kind))}
                    >
                      <Trash2 data-icon="inline-start" /> {ACTIONS[kind].all} ({eligible(kind).length})
                    </Button>
                  ),
              )}
            </div>
          )}
          {GROUPS.map((g) => {
            const items = rows.filter((r) => groupOf(r) === g.key)
            if (!items.length) return null
            return (
              <section key={g.key} className="space-y-1.5">
                <h2 className="text-sm font-medium">
                  {g.title} <span className="text-muted-foreground">· {items.length}</span>
                </h2>
                <p className="text-xs text-muted-foreground">{g.hint}</p>
                <div className="space-y-2 md:hidden">
                  {items.map(({ ticket: t, branch: b }) => (
                    <Card key={`${t.id}:${b?.name ?? ''}`} size="sm">
                      <CardHeader>
                        <CardTitle className="flex items-start gap-1.5 text-sm">
                          {t.parentId && <Layers className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
                          <Link
                            to="/projects/$id/features/$ticketId"
                            params={{ id, ticketId: String(t.id) }}
                            className="min-w-0 hover:underline"
                          >
                            {t.title}
                          </Link>
                        </CardTitle>
                        <CardDescription>
                          #{t.id} · {stages.length ? stageOf(stages, t.status).name : t.status}
                          {t.workspaces.length > 0 &&
                            ` · ${t.workspaces.length} workspace${t.workspaces.length > 1 ? 's' : ''} registered`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs">
                        {t.previews.map((p) => (
                          <div key={p.workspaceId} className="text-amber-700 dark:text-amber-400">
                            preview {p.status === 'running' ? `running on :${p.port}` : p.status}: stop it on
                            the ticket
                          </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                          {b ? (
                            <>
                              <span className="inline-flex items-center gap-1 font-mono">
                                <GitBranch className="size-3" /> {b.name}
                              </span>
                              <span className="font-mono text-muted-foreground">
                                {b.local ? shortSha(b.local) : 'not local'}
                              </span>
                              {b.reach && <ReachBadge reach={b.reach} />}
                            </>
                          ) : (
                            <span className="text-muted-foreground">
                              {t.workspaces.map((w) => w.name).join(', ')}
                            </span>
                          )}
                        </div>
                        {b?.worktrees.map((w) => (
                          <Tip
                            key={w.path}
                            content={w.protected ? `${w.path}: kept, ${w.protected}` : w.path}
                          >
                            <div className="flex items-center gap-1 truncate font-mono text-[11px]">
                              <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                              <span className="truncate">{w.main ? 'main checkout' : w.path}</span>
                            </div>
                          </Tip>
                        ))}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                          <span className="font-mono text-muted-foreground">
                            {b?.remote ? `origin ${shortSha(b.remote)}` : ''}
                          </span>
                          <div className="flex flex-wrap items-center gap-1">
                            {b?.restore && (
                              <Tip content={`Copy the restore command: ${b.restore}`}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Copy the restore command: ${b.restore}`}
                                  onClick={() => copy(b.restore!)}
                                >
                                  <Copy />
                                </Button>
                              </Tip>
                            )}
                            {b && !actionsOff && (
                              <RowActions
                                branch={b}
                                busy={remove.isPending}
                                onAsk={(kind) => ask(kind, [{ ticket: t, branch: b }])}
                              />
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-lg border md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ticket</TableHead>
                        <TableHead>Branch</TableHead>
                        <TableHead>Reach</TableHead>
                        <TableHead>Worktree</TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead className="w-8" />
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map(({ ticket: t, branch: b }) => (
                        <TableRow key={`${t.id}:${b?.name ?? ''}`} data-branch={b?.name}>
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
                              <Tip
                                key={w.path}
                                content={w.protected ? `${w.path}: kept, ${w.protected}` : w.path}
                              >
                                <div className="flex items-center gap-1 truncate font-mono text-[11px]">
                                  <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{w.main ? 'main checkout' : w.path}</span>
                                </div>
                              </Tip>
                            ))}
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {b?.remote ? shortSha(b.remote) : ''}
                          </TableCell>
                          <TableCell>
                            {b?.restore && (
                              <Tip content={`Copy the restore command: ${b.restore}`}>
                                <button
                                  type="button"
                                  aria-label={`Copy the restore command: ${b.restore}`}
                                  onClick={() => copy(b.restore!)}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <Copy className="size-3.5" />
                                </button>
                              </Tip>
                            )}
                          </TableCell>
                          <TableCell className="max-w-64">
                            {b && !actionsOff && (
                              <RowActions
                                branch={b}
                                busy={remove.isPending}
                                onAsk={(kind) => ask(kind, [{ ticket: t, branch: b }])}
                              />
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  Branches left on origin <span className="text-muted-foreground">· {remote.length}</span>
                </h2>
                {!actionsOff && eligible('remote').length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => ask('remote', eligible('remote'))}
                  >
                    <Trash2 data-icon="inline-start" /> {ACTIONS.remote.all} ({eligible('remote').length})
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                As of the last fetch; the board fetches origin again before it deletes one. Each is judged by
                its own commits against origin's copies of the bases, or by a merged PR whose head is that
                very commit.
              </p>
              <div className="space-y-2 md:hidden">
                {remote.map(({ ticket: t, branch: b }) => (
                  <Card key={`${t.id}:${b.name}`} size="sm">
                    <CardHeader>
                      <CardTitle className="text-sm">
                        <span className="text-muted-foreground">#{t.id}</span> {t.title}
                      </CardTitle>
                      <CardDescription className="font-mono">
                        {b.name} · {shortSha(b.remote!)}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-xs">
                      <div>
                        {b.mergedPr ? (
                          <span>PR #{b.mergedPr.number} merged at this commit</span>
                        ) : b.remoteReach ? (
                          <ReachBadge reach={b.remoteReach} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                        {b.restoreRemote ? (
                          <Tip content={`Copy the restore command: ${b.restoreRemote}`}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Copy the restore command: ${b.restoreRemote}`}
                              onClick={() => copy(b.restoreRemote!)}
                            >
                              <Copy />
                            </Button>
                          </Tip>
                        ) : (
                          <span />
                        )}
                        {!actionsOff &&
                          (b.can.remote.ok ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={remove.isPending}
                              onClick={() => ask('remote', [{ ticket: t, branch: b }])}
                            >
                              {ACTIONS.remote.row}
                            </Button>
                          ) : (
                            <Kept reason={b.can.remote.reason} />
                          ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-lg border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket</TableHead>
                      <TableHead>Branch on origin</TableHead>
                      <TableHead>Reach</TableHead>
                      <TableHead className="w-8" />
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {remote.map(({ ticket: t, branch: b }) => (
                      <TableRow key={`${t.id}:${b.name}`} data-origin-branch={b.name}>
                        <TableCell className="max-w-72 truncate text-xs">
                          #{t.id} {t.title}
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{b.name}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {shortSha(b.remote!)}
                          </div>
                        </TableCell>
                        <TableCell>
                          {b.mergedPr ? (
                            <span className="text-xs">PR #{b.mergedPr.number} merged at this commit</span>
                          ) : b.remoteReach ? (
                            <ReachBadge reach={b.remoteReach} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {b.restoreRemote && (
                            <Tip content={`Copy the restore command: ${b.restoreRemote}`}>
                              <button
                                type="button"
                                aria-label={`Copy the restore command: ${b.restoreRemote}`}
                                onClick={() => copy(b.restoreRemote!)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            </Tip>
                          )}
                        </TableCell>
                        <TableCell className="max-w-64">
                          {!actionsOff &&
                            (b.can.remote.ok ? (
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={remove.isPending}
                                onClick={() => ask('remote', [{ ticket: t, branch: b }])}
                              >
                                {ACTIONS.remote.row}
                              </Button>
                            ) : (
                              <Kept reason={b.can.remote.reason} />
                            ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
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
                    <Tip content={w.path}>
                      <span className="truncate">{w.path}</span>
                    </Tip>
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
      <ConfirmDelete
        pending={pending}
        onClose={() => setPending(null)}
        onConfirm={(p) => {
          setPending(null)
          remove.mutate(p.targets.map((t) => itemOf(p.kind, t)))
        }}
      />
      {!!uploads?.count && (
        <section className="space-y-1.5">
          <h2 className="text-sm font-medium">
            Unattached uploads{' '}
            <span className="text-muted-foreground">
              · {uploads.count} · {fileSize(uploads.bytes)}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Files uploaded more than a day ago that nothing on the board uses: a New ticket window closed
            without creating, a file removed from a post before sending. The board deletes them every hour;
            files younger than a day are left alone{uploads.recent ? ` (${uploads.recent} now)` : ''}.
          </p>
          <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <Paperclip className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              {uploads.count} file{uploads.count === 1 ? '' : 's'}, {fileSize(uploads.bytes)}
            </span>
            <AlertDialog open={confirmSweep} onOpenChange={setConfirmSweep}>
              <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={sweep.isPending} />}>
                Delete now
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete the unattached uploads?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {uploads.count} file{uploads.count === 1 ? '' : 's'} ({fileSize(uploads.bytes)}) that no
                    post, reply, ticket or agent picture uses, uploaded more than a day ago. This cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setConfirmSweep(false)
                      sweep.mutate()
                    }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </section>
      )}
    </div>
  )
}

/** Why something stays: no control, only the reason. */
function Kept({ reason }: { reason: string | null }) {
  return <div className="text-[11px] text-muted-foreground">Kept: {reason}</div>
}

/**
 * What a row may do: remove its worktrees with the branch, or delete the branch alone; when neither,
 * why it stays.
 */
function RowActions({
  branch: b,
  busy,
  onAsk,
}: {
  branch: Branch
  busy: boolean
  onAsk: (kind: DeleteKind) => void
}) {
  const hasTrees = b.worktrees.some((w) => !w.main)
  const kinds = (['worktrees', 'local'] as const).filter((k) => b.can[k].ok)
  if (!kinds.length) {
    if (!b.local && !hasTrees) return null
    return <Kept reason={b.protected ?? (hasTrees ? b.can.worktrees.reason : b.can.local.reason)} />
  }
  return (
    <div className="flex flex-wrap gap-1">
      {kinds.map((k) => (
        <Button key={k} variant="outline" size="xs" disabled={busy} onClick={() => onAsk(k)}>
          {ACTIONS[k].row}
        </Button>
      ))}
    </div>
  )
}

/** Every item exactly as it will go; nothing is sent until the action's own button is pressed. */
function ConfirmDelete({
  pending,
  onClose,
  onConfirm,
}: {
  pending: Pending | null
  onClose: () => void
  onConfirm: (p: Pending) => void
}) {
  const kind = pending?.kind ?? 'local'
  const all = pending?.targets ?? []
  // A branch edited on the way in differs from its base: listed apart, with the commits that differ.
  const edited = all.filter(
    (t) => (kind === 'remote' ? t.branch.remoteReach : t.branch.reach)?.state === 'edited',
  )
  const plain = all.filter((t) => !edited.includes(t))
  const item = (t: Target) => {
    const b = t.branch
    const sha = kind === 'remote' ? b.remote : b.local
    const reach = kind === 'remote' ? b.remoteReach : b.reach
    const trees = b.worktrees.filter((w) => !w.main)
    return (
      <li key={`${t.ticket.id}:${b.name}`} className="space-y-0.5 rounded-md border p-2">
        <div className="truncate font-medium">
          #{t.ticket.id} {t.ticket.title}
          {t.ticket.repo && (
            <span className="font-normal text-muted-foreground"> · {t.ticket.repo.name}</span>
          )}
        </div>
        <div className="font-mono">
          {b.name} @ {sha ? shortSha(sha) : 'no local branch'}{' '}
          <span className="text-muted-foreground">{kind === 'remote' ? 'on origin' : 'local'}</span>
        </div>
        {kind === 'remote' && b.mergedPr && (
          <div className="text-muted-foreground">PR #{b.mergedPr.number} was merged at this commit</div>
        )}
        {reach?.state === 'edited' && (
          <ul className="text-muted-foreground">
            {reach.unique.map((c) => (
              <li key={c.sha} className="font-mono">
                {shortSha(c.sha)} {c.subject}
              </li>
            ))}
          </ul>
        )}
        {kind === 'worktrees' &&
          trees.map((w) => (
            <div key={w.path} className="flex items-center gap-1 font-mono">
              <FolderGit2 className="size-3 shrink-0 text-muted-foreground" /> worktree {w.path}
              {w.previews.map((p) => (
                <span key={p.workspaceId} className="font-sans text-amber-700 dark:text-amber-400">
                  {' '}
                  · stops its preview ({p.status === 'running' ? `running on :${p.port}` : p.status})
                </span>
              ))}
              {w.linkedPreviews.map((l) => (
                <span key={`link-${l.workspaceId}`} className="font-sans text-amber-700 dark:text-amber-400">
                  {' '}
                  · stops the server on :{l.port} if it runs from this worktree
                </span>
              ))}
            </div>
          ))}
      </li>
    )
  }
  return (
    <AlertDialog open={!!pending} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{ACTIONS[kind].title(all.length)}</AlertDialogTitle>
          <AlertDialogDescription>
            {ACTIONS[kind].what} Each is checked again just before it goes, and kept if anything changed;
            nothing is forced. The restore commands are shown afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto text-xs">
          {plain.length > 0 && (
            <ul aria-label="To delete" className="space-y-1.5">
              {plain.map(item)}
            </ul>
          )}
          {edited.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium">
                Edited on the way in: these commits differ from the base, but merging would add nothing
              </p>
              <ul aria-label="To delete, edited" className="space-y-1.5">
                {edited.map(item)}
              </ul>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => pending && onConfirm(pending)}>
            {ACTIONS[kind].confirm(all.length)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const OUTCOME: Record<DeleteResult['outcome'], { label: string; className: string; dot: string }> = {
  deleted: {
    label: 'Deleted',
    className: 'text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-600 dark:bg-emerald-400',
  },
  refused: {
    label: 'Kept',
    className: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-600 dark:bg-amber-400',
  },
  failed: { label: 'Failed', className: 'text-destructive', dot: 'bg-destructive' },
  gone: { label: 'Already gone', className: 'text-muted-foreground', dot: 'bg-muted-foreground/60' },
}

/** What went first, then what stayed and why, then what could not be done, then what was gone already. */
const OUTCOME_ORDER: DeleteResult['outcome'][] = ['deleted', 'refused', 'failed', 'gone']

const kindLabel = (kind: DeleteKind) =>
  kind === 'remote' ? 'on origin' : kind === 'worktrees' ? 'with its worktrees' : 'local'

/** The next step for the reasons this page can name; null when the reason already says it. */
function advice(reason: string): string | null {
  if (/has changes or untracked files: /.test(reason))
    return 'Commit or stash them in the worktree, then refresh.'
  if (reason.endsWith(' is gone: git worktree prune drops it')) return 'Run git worktree prune, then refresh.'
  if (/ moved since: now at /.test(reason)) return 'Refresh, then confirm again on the new commit.'
  if (reason.startsWith('checked out in ')) return 'Check out another branch there first.'
  return null
}

/** Ticket ids as they read best: a run of three or more as a range, the rest in full. */
function idsText(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    const run = sorted.slice(i, j + 1)
    parts.push(run.length >= 3 ? `#${run[0]}–#${run.at(-1)}` : run.map((id) => `#${id}`).join(', '))
    i = j + 1
  }
  return parts.join(', ')
}

/** One line's worth of a group: a branch and a kind read once, with every item that stayed for it. */
type Bucket = { branch: string; kind: DeleteKind; items: DeleteResult[] }

function bucketsOf(items: DeleteResult[]): Bucket[] {
  const buckets = new Map<string, Bucket>()
  for (const r of items) {
    const key = `${r.branch}\u0000${r.kind}`
    const found = buckets.get(key)
    if (found) found.items.push(r)
    else buckets.set(key, { branch: r.branch, kind: r.kind, items: [r] })
  }
  return [...buckets.values()]
}

/** The items that stayed for the very same reason, so it reads once for all of them. */
function groupsOf(items: DeleteResult[]) {
  const groups = new Map<string, DeleteResult[]>()
  for (const r of items) {
    const key = r.reason ?? ''
    const found = groups.get(key)
    if (found) found.push(r)
    else groups.set(key, [r])
  }
  return [...groups].map(([key, list]) => {
    const buckets = bucketsOf(list)
    // A message that opens with its own branch says it again below: the branch line keeps the fact.
    const only = buckets.length === 1 ? buckets[0] : null
    const branch = only?.branch ?? ''
    const prefix = branch
      ? [`${branch}: `, `${branch} `, `origin's ${branch}: `, `origin's ${branch} `].find(
          (p) => key.length > p.length && key.startsWith(p),
        )
      : undefined
    return {
      key,
      reason: prefix ? key.slice(prefix.length) : key,
      // The patterns read the message whole: the branch and its space are part of what they look for.
      advice: advice(key),
      buckets,
    }
  })
}

/** What an item took with it, each fact once: the paths removed, the links, and how to put them back. */
function Facts({ items }: { items: DeleteResult[] }) {
  const removed = [...new Set(items.flatMap((r) => r.removed))]
  const unlinked = [
    ...new Map(items.flatMap((r) => r.unlinked).map((l) => [`${l.path}\u0000${l.target}`, l])).values(),
  ]
  const restore = [...new Set(items.flatMap((r) => r.restore))]
  if (!removed.length && !unlinked.length && !restore.length) return null
  return (
    <div className="space-y-1">
      {removed.map((p) => (
        <p key={p} className="break-all font-mono text-[11px] text-muted-foreground">
          removed {p}
        </p>
      ))}
      {unlinked.map((l) => (
        <p key={`${l.path}:${l.target}`} className="break-all font-mono text-[11px] text-muted-foreground">
          removed the link {l.path} to {l.target}, which stays
        </p>
      ))}
      {restore.map((cmd) => (
        <div key={cmd} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1">
          <code className="flex-1 overflow-x-auto font-mono">{cmd}</code>
          <Tip content={`Copy: ${cmd}`}>
            <button
              type="button"
              aria-label={`Copy: ${cmd}`}
              onClick={() => copy(cmd)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </button>
          </Tip>
        </div>
      ))}
    </div>
  )
}

/** The items that stayed, each reason once, and under it the branches, tickets and what it took with it. */
function Groups({ outcome, items }: { outcome: DeleteResult['outcome']; items: DeleteResult[] }) {
  return (
    <ul className="space-y-2">
      {groupsOf(items).map((g) => (
        <li key={g.key} className="space-y-1">
          <div className="space-y-0.5">
            <p className="break-words text-muted-foreground">{g.reason || 'No reason given'}</p>
            {g.advice && <p className="break-words text-muted-foreground/80">→ {g.advice}</p>}
          </div>
          <ul className="space-y-1 pl-2">
            {g.buckets.map((b) => (
              <li key={`${b.branch}:${b.kind}`} data-outcome={outcome} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{b.branch}</span>
                  <span className="text-muted-foreground">{kindLabel(b.kind)}</span>
                  <span className="text-muted-foreground">{idsText(b.items.map((r) => r.ticketId))}</span>
                </div>
                <Facts items={b.items} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/** The items that went, each with what it took and the commands that put it back. */
function Deleted({ items }: { items: DeleteResult[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((r, i) => (
        <li key={`${r.ticketId}:${r.branch}:${r.kind}:${i}`} data-outcome={r.outcome} className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono">{r.branch}</span>
            <span className="text-muted-foreground">
              {kindLabel(r.kind)} · #{r.ticketId}
            </span>
          </div>
          <Facts items={[r]} />
        </li>
      ))}
    </ul>
  )
}

/** What the last deletion did, each item once, with what was kept and why, and what puts back what went. */
function Results({ results, onClose }: { results: DeleteResult[]; onClose: () => void }) {
  const sections = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    items: results.filter((r) => r.outcome === outcome),
  })).filter((s) => s.items.length)
  return (
    <section className="space-y-1.5" aria-label="Deletion results">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          Last deletion <span className="text-muted-foreground">· {results.length}</span>
        </h2>
        <Tip content="Dismiss">
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onClose}>
            <X />
          </Button>
        </Tip>
      </div>
      <div className="divide-y rounded-lg border px-3 text-xs">
        {sections.map(({ outcome, items }) => (
          <section key={outcome} aria-label={OUTCOME[outcome].label} className="space-y-1.5 py-3">
            <h3 className={`flex items-center gap-1.5 font-medium ${OUTCOME[outcome].className}`}>
              <span className={`size-1.5 shrink-0 rounded-full ${OUTCOME[outcome].dot}`} aria-hidden />
              {OUTCOME[outcome].label}{' '}
              <span className="font-normal text-muted-foreground">· {items.length}</span>
            </h3>
            {outcome === 'deleted' ? <Deleted items={items} /> : <Groups outcome={outcome} items={items} />}
          </section>
        ))}
      </div>
    </section>
  )
}
