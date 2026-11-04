import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, FolderGit2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
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
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { Tip } from '#/components/ui/tooltip'
import { del, errorMessage, get, patch, post, put, type Repo, type RunConfig } from '#/lib/api'
import { useProject } from '#/lib/project'
import { RUN_PORTS, type RunConfigInput, type RunType, runConfigProblem } from '#/lib/runs'

/**
 * The project's runs, per repo: what the board starts from a ticket's worktree of each repo. A preview
 * answers on a port (the board checks its health path, and the ticket gets its link); a job is a
 * background worker with no link. Agents start and stop them by name, and add, change and delete them
 * too (each change in the project's activity); what runs is always what is saved here. Its own section of
 * the project's settings.
 */
export function RunsSettings({ projectId }: { projectId: string }) {
  const { data: p } = useProject(projectId)
  if (!p) return null
  return (
    <section aria-label="Runs" className="max-w-3xl space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
        <p className="text-sm text-muted-foreground">
          What the board starts from a ticket's worktree of each repo, from the ticket's Runs card or when an
          agent asks: a <strong>preview</strong> answers on a port and gets a link to open, a{' '}
          <strong>job</strong> is a background worker with no link. Each runs its install (only when the
          lockfile changed), its build, then its start command, in the worktree. Agents start and stop them,
          and can add, change and delete them too: each change shows in the project's activity under the
          agent's name.
        </p>
      </div>
      {p.repos.length === 0 && <p className="text-sm text-muted-foreground">The project has no repos yet.</p>}
      {p.repos.map((r) => (
        <RepoRuns key={r.id} repo={r} />
      ))}
    </section>
  )
}

function RepoRuns({ repo }: { repo: Repo }) {
  const qc = useQueryClient()
  const key = ['runs', repo.id]
  const { data: runs } = useQuery({
    queryKey: key,
    queryFn: () => get<RunConfig[]>(`/api/repos/${repo.id}/runs`),
  })
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['ticket-runs'] })
  }
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/runs/${id}`),
    onSuccess: () => {
      refresh()
      toast.success('Removed')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const reorder = useMutation({
    mutationFn: (ids: number[]) => put<RunConfig[]>(`/api/repos/${repo.id}/runs/order`, { ids }),
    onSuccess: (rows) => qc.setQueryData(key, rows),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const move = (i: number, by: -1 | 1) => {
    if (!runs) return
    const ids = runs.map((r) => r.id)
    ;[ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!]
    reorder.mutate(ids)
  }
  return (
    <div className="space-y-2 rounded-lg border p-3" role="group" aria-label={`Runs of ${repo.name}`}>
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <FolderGit2 className="size-3.5 text-muted-foreground" />
        {repo.name}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={editing !== null}
          onClick={() => setEditing('new')}
        >
          <Plus /> Add run
        </Button>
      </h3>
      {runs?.length === 0 && editing !== 'new' && (
        <p className="text-xs text-muted-foreground">No runs: tickets of this repo have nothing to start.</p>
      )}
      <ul className="space-y-2">
        {runs?.map((r, i) =>
          editing === r.id ? (
            <li key={r.id}>
              <RunForm
                repoId={repo.id}
                run={r}
                others={runs.filter((x) => x.id !== r.id)}
                onDone={() => {
                  setEditing(null)
                  refresh()
                }}
              />
            </li>
          ) : (
            <li key={r.id} className="flex items-start gap-2 text-sm" aria-label={r.name}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                    {r.type === 'preview' ? 'Preview' : 'Job'}
                  </Badge>
                  {r.type === 'preview' && (
                    <span className="text-xs text-muted-foreground">
                      port {r.port ?? 'auto'} · health {r.healthPath}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {[r.install, r.build, r.start].filter(Boolean).join(' && ')}
                </div>
              </div>
              <Tip content="Move up">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp />
                </Button>
              </Tip>
              <Tip content="Move down">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move down"
                  disabled={i === runs.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
              </Tip>
              <Tip content="Edit">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${r.name}`}
                  disabled={editing !== null}
                  onClick={() => setEditing(r.id)}
                >
                  <Pencil />
                </Button>
              </Tip>
              <AlertDialog>
                <Tip content="Delete">
                  <AlertDialogTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.name}`} />}
                  >
                    <Trash2 />
                  </AlertDialogTrigger>
                </Tip>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete the run {r.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Wherever it runs now it is stopped, and tickets of {repo.name} no longer offer it.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove.mutate(r.id)}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' && (
        <RunForm
          repoId={repo.id}
          others={runs ?? []}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

type EnvRow = { key: string; value: string }

/** A run's fields; Save checks them as the board does and shows what is wrong without saving. */
function RunForm({
  repoId,
  run,
  others,
  onDone,
}: {
  repoId: number
  run?: RunConfig
  others: RunConfig[]
  onDone: () => void
}) {
  const [name, setName] = useState(run?.name ?? '')
  const [type, setType] = useState<RunType>(run?.type ?? 'preview')
  const [install, setInstall] = useState(run?.install ?? '')
  const [build, setBuild] = useState(run?.build ?? '')
  const [start, setStart] = useState(run?.start ?? '')
  const [env, setEnv] = useState<EnvRow[]>(
    Object.entries(run?.env ?? {}).map(([key, value]) => ({ key, value })),
  )
  const [port, setPort] = useState(run?.port ? String(run.port) : 'auto')
  const [healthPath, setHealthPath] = useState(run?.healthPath || '/')
  const [copyData, setCopyData] = useState(run?.copyData ?? false)
  const [problem, setProblem] = useState<string | null>(null)
  const preview = type === 'preview'
  const input = (): RunConfigInput => ({
    name: name.trim(),
    type,
    install: install.trim(),
    build: build.trim(),
    start: start.trim(),
    env: Object.fromEntries(env.filter((e) => e.key.trim() || e.value).map((e) => [e.key.trim(), e.value])),
    port: !preview || !port.trim() || port.trim().toLowerCase() === 'auto' ? null : Number(port.trim()),
    healthPath: preview ? healthPath.trim() : '',
    copyData,
  })
  const save = useMutation({
    mutationFn: (body: RunConfigInput) =>
      run
        ? patch<RunConfig>(`/api/runs/${run.id}`, body)
        : post<RunConfig>(`/api/repos/${repoId}/runs`, body),
    onSuccess: () => {
      toast.success('Saved')
      onDone()
    },
    // The board's own refusal, said where the form is.
    onError: (err) => setProblem(errorMessage(err)),
  })
  const id = (field: string) => `run-${run?.id ?? 'new'}-${repoId}-${field}`
  const field = (label: string, value: string, set: (v: string) => void, placeholder = '') => (
    <div className="space-y-1">
      <Label htmlFor={id(label)} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id(label)}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
    </div>
  )
  return (
    <form
      noValidate
      className="space-y-3 rounded-md border bg-muted/30 p-3"
      aria-label={run ? `Edit ${run.name}` : 'New run'}
      onSubmit={(e) => {
        e.preventDefault()
        const body = input()
        // Port "auto" or a number; anything else is the port problem the board would answer.
        const bad = preview && body.port !== null && !Number.isInteger(body.port)
        const found = bad
          ? `port: auto, or a port from ${RUN_PORTS.from} to ${RUN_PORTS.to}`
          : runConfigProblem(body, others)
        setProblem(found)
        if (!found) save.mutate(body)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Name', name, setName, 'Web')}
        <div className="space-y-1">
          <Label htmlFor={id('Type')} className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select
            value={type}
            onValueChange={(v) => v && setType(v as RunType)}
            items={{ preview: 'Preview (a port and a link)', job: 'Job (a background worker)' }}
          >
            <SelectTrigger id={id('Type')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">Preview (a port and a link)</SelectItem>
              <SelectItem value="job">Job (a background worker)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {field('Install', install, setInstall, 'pnpm install --frozen-lockfile (empty: none)')}
      {field('Build', build, setBuild, 'pnpm build (empty: none)')}
      {field('Start', start, setStart, preview ? 'node server.js (reads PORT)' : 'node worker.js')}
      {preview && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field('Port', port, setPort, 'auto')}
          {field('Health path', healthPath, setHealthPath, '/')}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">
          Environment, for the start command
          {preview ? ': {port} in a value is its port; PORT and HOST are set' : ''}
        </div>
        {env.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              aria-label={`Variable ${i + 1} name`}
              value={e.key}
              onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)))}
              placeholder="NAME"
              className="w-40 font-mono text-xs"
            />
            <Input
              aria-label={`Variable ${i + 1} value`}
              value={e.value}
              onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)))}
              placeholder="value"
              className="flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove variable ${i + 1}`}
              onClick={() => setEnv(env.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEnv([...env, { key: '', value: '' }])}
        >
          <Plus /> Add variable
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Switch id={id('copy')} checked={copyData} onCheckedChange={(v) => setCopyData(v)} />
        <Label htmlFor={id('copy')} className="text-xs">
          Copy the live board's data into data/preview first (as DATA_DIR)
        </Label>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
