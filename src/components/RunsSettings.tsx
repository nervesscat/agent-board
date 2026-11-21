import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, FolderGit2, Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { TrashIcon } from '#/components/TrashIcon'
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
  const { t } = useTranslation()
  const { data: p } = useProject(projectId)
  if (!p) return null
  return (
    <section id="runs" aria-label={t('runsSettings.title')} className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{t('runsSettings.title')}</h2>
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="runsSettings.description" components={{ strong: <strong /> }} />
        </p>
      </div>
      {p.repos.length === 0 && <p className="text-sm text-muted-foreground">{t('runsSettings.noRepos')}</p>}
      {p.repos.map((r) => (
        <RepoRuns key={r.id} repo={r} />
      ))}
    </section>
  )
}

function RepoRuns({ repo }: { repo: Repo }) {
  const { t } = useTranslation()
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
      toast.success(t('runsSettings.removed'))
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
    <div
      className="space-y-2 rounded-lg border p-3"
      role="group"
      aria-label={t('runsSettings.groupLabel', { name: repo.name })}
    >
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
          <Plus /> {t('runsSettings.add')}
        </Button>
      </h3>
      {runs?.length === 0 && editing !== 'new' && (
        <p className="text-xs text-muted-foreground">{t('runsSettings.none')}</p>
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
                    {r.type === 'preview' ? t('runsSettings.typePreview') : t('runsSettings.typeJob')}
                  </Badge>
                  {r.type === 'preview' && (
                    <span className="text-xs text-muted-foreground">
                      {t('runsSettings.portHealth', {
                        port: r.port ?? t('runsSettings.portAuto'),
                        path: r.healthPath,
                      })}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {[r.install, r.build, r.start].filter(Boolean).join(' && ')}
                </div>
              </div>
              <Tip content={t('runsSettings.moveUp')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('runsSettings.moveUp')}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp />
                </Button>
              </Tip>
              <Tip content={t('runsSettings.moveDown')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('runsSettings.moveDown')}
                  disabled={i === runs.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
              </Tip>
              <Tip content={t('runsSettings.edit')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('runsSettings.editRun', { name: r.name })}
                  disabled={editing !== null}
                  onClick={() => setEditing(r.id)}
                >
                  <Pencil />
                </Button>
              </Tip>
              <AlertDialog>
                <Tip content={t('runsSettings.delete')}>
                  <AlertDialogTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('runsSettings.deleteRun', { name: r.name })}
                      />
                    }
                  >
                    <TrashIcon />
                  </AlertDialogTrigger>
                </Tip>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('runsSettings.deleteTitle', { name: r.name })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('runsSettings.deleteDescription', { repo: repo.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('runsSettings.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove.mutate(r.id)}>
                      {t('runsSettings.delete')}
                    </AlertDialogAction>
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
  const { t } = useTranslation()
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
      toast.success(t('common.saved'))
      onDone()
    },
    // The board's own refusal, said where the form is.
    onError: (err) => setProblem(errorMessage(err)),
  })
  const id = (field: string) => `run-${run?.id ?? 'new'}-${repoId}-${field}`
  // `slug` names the field's input (its id); `label` is what is shown.
  const field = (slug: string, label: string, value: string, set: (v: string) => void, placeholder = '') => (
    <div className="space-y-1">
      <Label htmlFor={id(slug)} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id(slug)}
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
      aria-label={run ? t('runsSettings.editRun', { name: run.name }) : t('runsSettings.newRun')}
      onSubmit={(e) => {
        e.preventDefault()
        const body = input()
        // Port "auto" or a number; anything else is the port problem the board would answer.
        const bad = preview && body.port !== null && !Number.isInteger(body.port)
        const found = bad
          ? t('runsSettings.portProblem', { from: RUN_PORTS.from, to: RUN_PORTS.to })
          : runConfigProblem(body, others)
        setProblem(found)
        if (!found) save.mutate(body)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Name', t('runsSettings.name'), name, setName, 'Web')}
        <div className="space-y-1">
          <Label htmlFor={id('Type')} className="text-xs text-muted-foreground">
            {t('runsSettings.type')}
          </Label>
          <Select
            value={type}
            onValueChange={(v) => v && setType(v as RunType)}
            items={{ preview: t('runsSettings.typePreviewLong'), job: t('runsSettings.typeJobLong') }}
          >
            <SelectTrigger id={id('Type')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">{t('runsSettings.typePreviewLong')}</SelectItem>
              <SelectItem value="job">{t('runsSettings.typeJobLong')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {field('Install', t('runsSettings.install'), install, setInstall, t('runsSettings.installPlaceholder'))}
      {field('Build', t('runsSettings.build'), build, setBuild, t('runsSettings.buildPlaceholder'))}
      {field(
        'Start',
        t('runsSettings.start'),
        start,
        setStart,
        preview ? t('runsSettings.startPreviewPlaceholder') : 'node worker.js',
      )}
      {preview && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field('Port', t('runsSettings.port'), port, setPort, t('runsSettings.portAuto'))}
          {field('Health path', t('runsSettings.healthPath'), healthPath, setHealthPath, '/')}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">
          {preview ? t('runsSettings.envPreview') : t('runsSettings.env')}
        </div>
        {env.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              aria-label={t('runsSettings.varName', { n: i + 1 })}
              value={e.key}
              onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)))}
              // i18n-ignore: an environment variable name
              placeholder="NAME"
              className="w-40 font-mono text-xs"
            />
            <Input
              aria-label={t('runsSettings.varValue', { n: i + 1 })}
              value={e.value}
              onChange={(ev) => setEnv(env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)))}
              placeholder={t('runsSettings.valuePlaceholder')}
              className="flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('runsSettings.removeVar', { n: i + 1 })}
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
          <Plus /> {t('runsSettings.addVar')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Switch id={id('copy')} checked={copyData} onCheckedChange={(v) => setCopyData(v)} />
        <Label htmlFor={id('copy')} className="text-xs">
          {t('runsSettings.copyData')}
        </Label>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('runsSettings.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? t('runsSettings.saving') : t('runsSettings.save')}
        </Button>
      </div>
    </form>
  )
}
