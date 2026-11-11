import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
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
import { toastRefusal } from '#/components/Needs'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { Tip } from '#/components/ui/tooltip'
import { del, errorMessage, get, patch, post, put } from '#/lib/api'
import { STAGE_COLORS, STAGE_KINDS, type StageColor, type StageKind } from '#/lib/constants'
import { useProject } from '#/lib/project'
import { STAGE_DOT, STAGE_KIND_LABEL } from '#/lib/stages'
import { ticketsKey } from '#/lib/tickets'
import type { Stage } from '#/db/schema'

type StageRow = Stage & { tickets: number }

const KIND_HINT: Record<StageKind, string> = {
  open: 'waiting to be picked up; claiming moves it to the stage work starts in',
  active: 'being worked on',
  blocked: 'waiting on you',
  review: 'handed off for review',
  done: 'finished; cannot be claimed',
  cancelled: 'dropped; disapproving moves a ticket here, and its tasks leave the progress',
}

const kindItems = Object.fromEntries(STAGE_KINDS.map((k) => [k, STAGE_KIND_LABEL[k]]))

/**
 * The project's stages, which are its board's columns: add, rename, recolour, change the kind,
 * reorder, delete. Every change saves at once.
 */
export function StagesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const key = ['stages', projectId]
  const { data: stages } = useQuery({
    queryKey: key,
    queryFn: () => get<StageRow[]>(`/api/projects/${projectId}/stages`),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ['project', projectId] })
    qc.invalidateQueries({ queryKey: ticketsKey(projectId) })
  }
  const onError = (err: unknown) => toast.error(errorMessage(err))
  const add = useMutation({
    mutationFn: (v: { name: string; kind: StageKind }) => post(`/api/projects/${projectId}/stages`, v),
    onSuccess: refresh,
    onError,
  })
  const change = useMutation({
    mutationFn: (v: { id: number; name?: string; kind?: StageKind; color?: StageColor }) => {
      const { id, ...body } = v
      return patch(`/api/projects/${projectId}/stages/${id}`, body)
    },
    onSuccess: refresh,
    onError,
  })
  const reorder = useMutation({
    mutationFn: (ids: number[]) => put(`/api/projects/${projectId}/stages/order`, { ids }),
    onSuccess: refresh,
    onError,
  })
  const remove = useMutation({
    mutationFn: (v: { id: number; moveTo?: string; force?: boolean }) =>
      del(
        `/api/projects/${projectId}/stages/${v.id}${v.moveTo ? `?moveTo=${encodeURIComponent(v.moveTo)}` : ''}${v.force ? '&force=1' : ''}`,
      ),
    onSuccess: refresh,
    // Into a done stage, tickets whose needs are not merged yet hold it up; the human can move them anyway.
    onError: (err, v) => toastRefusal(err, () => remove.mutate({ ...v, force: true }), 'Move them anyway'),
  })

  const [name, setName] = useState('')
  const [kind, setKind] = useState<StageKind>('active')

  if (!stages) return null
  const move = (i: number, dir: -1 | 1) => {
    const ids = stages.map((s) => s.id)
    ;[ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!]
    reorder.mutate(ids)
  }
  return (
    <section id="stages" aria-label="Stages" className="max-w-3xl scroll-mt-16 space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Stages</h2>
        <p className="text-sm text-muted-foreground">
          The columns of the features board, left to right. The kind is what the board&apos;s rules go by
          (claiming, disapproving, lane progress); agents see each stage&apos;s key, name and kind. Renaming
          keeps the key.
        </p>
      </div>
      <ul className="divide-y rounded-md border">
        {stages.map((s, i) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={i === 0 || reorder.isPending}
                onClick={() => move(i, -1)}
                aria-label={`Move ${s.name} earlier`}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={i === stages.length - 1 || reorder.isPending}
                onClick={() => move(i, 1)}
                aria-label={`Move ${s.name} later`}
              >
                <ArrowDown />
              </Button>
            </div>
            <ColorPick value={s.color} onChange={(color) => change.mutate({ id: s.id, color })} />
            <StageName value={s.name} onSave={(name) => change.mutate({ id: s.id, name })} className="w-44" />
            <Select
              value={s.kind}
              onValueChange={(k) => k && change.mutate({ id: s.id, kind: k as StageKind })}
              items={kindItems}
            >
              <Tip content={KIND_HINT[s.kind]}>
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
              </Tip>
              <SelectContent>
                {STAGE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {STAGE_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1">{s.key}</code>
              <span className="tabular-nums">
                {s.tickets} ticket{s.tickets === 1 ? '' : 's'}
              </span>
              <DeleteStage
                stage={s}
                others={stages.filter((o) => o.id !== s.id)}
                onDelete={(moveTo) => remove.mutate({ id: s.id, moveTo })}
              />
            </span>
          </li>
        ))}
      </ul>
      <WorkStage projectId={projectId} stages={stages} />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          add.mutate({ name: name.trim(), kind }, { onSuccess: () => setName('') })
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New stage, e.g. QA"
          maxLength={40}
          className="h-8 w-56"
        />
        <Select value={kind} onValueChange={(k) => k && setKind(k as StageKind)} items={kindItems}>
          <Tip content={KIND_HINT[kind]}>
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
          </Tip>
          <SelectContent>
            {STAGE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {STAGE_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
          <Plus data-icon="inline-start" /> Add stage
        </Button>
        <span className="text-xs text-muted-foreground">{KIND_HINT[kind]}</span>
      </form>
    </section>
  )
}

/** What the select shows for the project's default: the first active stage, whichever it is now. */
const FIRST_ACTIVE = '__first_active__'

/**
 * Where work starts: the active stage claiming a ticket (and a status given as in_progress or active)
 * puts it in. The first active stage until the human picks one; a pick whose stage is gone or no longer
 * active reads as the default again, as the server takes it.
 */
function WorkStage({ projectId, stages }: { projectId: string; stages: StageRow[] }) {
  const qc = useQueryClient()
  const { data: project } = useProject(projectId)
  const save = useMutation({
    mutationFn: (workStage: string | null) =>
      patch<{ workStage: string | null }>(`/api/projects/${projectId}`, { workStage }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const active = stages.filter((s) => s.kind === 'active')
  if (!project) return null
  const first = active[0]
  const chosen = active.find((s) => s.key === project.workStage)
  const items = {
    [FIRST_ACTIVE]: first ? `First active stage (${first.name})` : 'First active stage (none)',
    ...Object.fromEntries(active.map((s) => [s.key, s.name])),
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="work-stage-label" className="text-sm font-medium">
        Work starts in
      </span>
      <Select
        value={chosen?.key ?? FIRST_ACTIVE}
        onValueChange={(v) => v && save.mutate(v === FIRST_ACTIVE ? null : v)}
        items={items}
        disabled={save.isPending}
      >
        <SelectTrigger size="sm" className="w-64" aria-labelledby="work-stage-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">
        Where claiming a ticket puts it; a status of in progress or active means this stage too.
      </span>
    </div>
  )
}

/** A name that saves when you leave the field or press Enter, and goes back on Escape. */
function StageName({
  value,
  onSave,
  className = '',
}: {
  value: string
  onSave: (name: string) => void
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const name = draft.trim()
    if (!name) setDraft(value)
    else if (name !== value) onSave(name)
  }
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      maxLength={40}
      aria-label="Stage name"
      className={`h-8 ${className}`}
    />
  )
}

const colorItems = Object.fromEntries(STAGE_COLORS.map((c) => [c, c]))

function ColorPick({ value, onChange }: { value: StageColor; onChange: (c: StageColor) => void }) {
  return (
    <Select value={value} onValueChange={(c) => c && onChange(c as StageColor)} items={colorItems}>
      <SelectTrigger size="sm" className="w-28" aria-label="Colour">
        <SelectValue>
          {(c: StageColor) => (
            <span className="inline-flex items-center gap-1.5">
              <span className={`size-3 rounded-full ${STAGE_DOT[c]}`} /> {c}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {STAGE_COLORS.map((c) => (
          <SelectItem key={c} value={c}>
            <span className="inline-flex items-center gap-1.5">
              <span className={`size-3 rounded-full ${STAGE_DOT[c]}`} /> {c}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Delete, asking where its tickets go when it has any. */
function DeleteStage({
  stage,
  others,
  onDelete,
}: {
  stage: StageRow
  others: StageRow[]
  onDelete: (moveTo?: string) => void
}) {
  const [moveTo, setMoveTo] = useState<string>('')
  const items = Object.fromEntries(others.map((o) => [o.key, o.name]))
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!others.length}
            aria-label={`Delete ${stage.name}`}
          />
        }
      >
        <Trash2 />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the stage {stage.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {stage.tickets
              ? `It holds ${stage.tickets} ticket${stage.tickets === 1 ? '' : 's'} (lanes included). Pick the stage they move to.`
              : 'No ticket is in it.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {stage.tickets > 0 && (
          <Select value={moveTo || null} onValueChange={(v) => setMoveTo(v ?? '')} items={items}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder="Move them to…" />
            </SelectTrigger>
            <SelectContent>
              {others.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={stage.tickets > 0 && !moveTo}
            onClick={() => onDelete(stage.tickets ? moveTo : undefined)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
