import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Pin, PinOff, Plus, StickyNote, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { TrashIcon } from '#/components/TrashIcon'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { Tip } from '#/components/ui/tooltip'
import { del, errorMessage, get, patch, post, type ProjectNote, type ProjectSummary } from '#/lib/api'

/**
 * The project's notes: the short facts the human and every agent must not rediscover (a command, a
 * path, a rule, a reminder). The card shows a few, pinned first, and edits them in place; the manage
 * dialog holds the whole list. Both read and write the project's notes route, so an agent's note shows
 * here and a note added here reaches `get_project`.
 */

const LABEL_MAX = 60
const BODY_MAX = 500
/** How many notes the card shows before sending the rest to the manage dialog. */
const SHOWN = 4

export const notesKey = (projectId: number | string) => ['notes', String(projectId)]

/** A note's position below zero is the pin: it sits above the unpinned notes. */
const pinned = (note: ProjectNote) => note.position < 0

export function Notes({ p }: { p: ProjectSummary }) {
  const projectId = p.project.id
  const key = notesKey(projectId)
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)
  const { data, error, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => get<ProjectNote[]>(`/api/projects/${projectId}/notes`),
    refetchInterval: 30_000,
  })
  const notes = data ?? []
  const changed = () => void qc.invalidateQueries({ queryKey: key })
  const add = useMutation({
    mutationFn: (input: { label: string; body: string }) =>
      post<ProjectNote>(`/api/projects/${projectId}/notes`, input),
    onSuccess: () => {
      setAdding(false)
      changed()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const change = useMutation({
    mutationFn: ({ noteId, ...input }: { noteId: number; label?: string; body?: string; pinned?: boolean }) =>
      patch<ProjectNote>(`/api/projects/${projectId}/notes/${noteId}`, input),
    onSuccess: changed,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: (noteId: number) => del<{ ok: true }>(`/api/projects/${projectId}/notes/${noteId}`),
    onSuccess: changed,
    onError: (err) => toast.error(errorMessage(err)),
  })

  const shown = notes.slice(0, SHOWN)
  const row = (note: ProjectNote) => (
    <NoteRow
      key={note.id}
      note={note}
      saving={change.isPending || remove.isPending}
      onSave={(input) => change.mutate({ noteId: note.id, ...input })}
      onPin={() => change.mutate({ noteId: note.id, pinned: !pinned(note) })}
      onDelete={() => remove.mutate(note.id)}
    />
  )

  return (
    <Card size="sm" className="lg:order-6 lg:col-span-full">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <StickyNote className="size-4 text-muted-foreground" /> Notes
          {notes.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {notes.length}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {notes.length > SHOWN && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setManaging(true)}>
                Manage all ({notes.length})
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus /> Add note
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading notes…</p>
        ) : error && !data ? (
          // A first load that failed says so; a later failed refetch keeps the notes already shown.
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : !notes.length && !adding ? (
          <EmptyNotes />
        ) : (
          <ul className="space-y-2">{shown.map(row)}</ul>
        )}
        {adding && (
          <NoteForm
            save="Save note"
            busy={add.isPending}
            onSubmit={(input) => add.mutate(input)}
            onCancel={() => setAdding(false)}
          />
        )}
      </CardContent>
      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Notes ({notes.length})</DialogTitle>
            <DialogDescription>
              One short fact each, pinned first. A note&apos;s author, an orchestrator or the human can change
              it.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <ul className="space-y-2">{notes.map(row)}</ul>
            {adding ? (
              <NoteForm
                save="Save note"
                busy={add.isPending}
                onSubmit={(input) => add.mutate(input)}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add note
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** What a note is for, with two examples, so an empty card still explains the feature. */
function EmptyNotes() {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        A note is one short fact the next session must not rediscover — a command, a path, a rule, a reminder.
        Keep each to one fact, never a document.
      </p>
      <ul className="space-y-1 text-sm">
        <li>
          <span className="font-medium">Release command</span>{' '}
          <span className="text-muted-foreground">pnpm release 0.2.5</span>
        </li>
        <li>
          <span className="font-medium">Preview ports</span>{' '}
          <span className="text-muted-foreground">47101 and up, one per run</span>
        </li>
      </ul>
    </div>
  )
}

function NoteRow({
  note,
  saving,
  onSave,
  onPin,
  onDelete,
}: {
  note: ProjectNote
  saving: boolean
  onSave: (input: { label: string; body: string }) => void
  onPin: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <li>
        <NoteForm
          label={note.label}
          body={note.body}
          save="Save note"
          busy={saving}
          onSubmit={(input) => {
            onSave(input)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  return (
    <li data-note={note.id} className="flex items-start gap-2 rounded-md border p-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {pinned(note) && <Pin className="size-3 shrink-0 text-muted-foreground" />}
          <span className="break-words">{note.label}</span>
        </div>
        <p className="line-clamp-2 break-words whitespace-pre-wrap text-sm text-muted-foreground">
          {note.body}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        <Tip content={pinned(note) ? 'Unpin this note' : 'Pin this note above the others'}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${pinned(note) ? 'Unpin' : 'Pin'} ${note.label}`}
            disabled={saving}
            onClick={onPin}
          >
            {pinned(note) ? <PinOff /> : <Pin />}
          </Button>
        </Tip>
        <Tip content="Edit this note">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit ${note.label}`}
            disabled={saving}
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        </Tip>
        <Tip content="Delete this note">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete ${note.label}`}
            disabled={saving}
            onClick={onDelete}
          >
            <TrashIcon />
          </Button>
        </Tip>
      </div>
    </li>
  )
}

/** A label and a body, plain text, with the two limits always in view. */
function NoteForm({
  label: initialLabel = '',
  body: initialBody = '',
  save,
  busy,
  onSubmit,
  onCancel,
}: {
  label?: string
  body?: string
  save: string
  busy: boolean
  onSubmit: (input: { label: string; body: string }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(initialLabel)
  const [body, setBody] = useState(initialBody)
  const valid = label.trim().length > 0 && body.trim().length > 0
  return (
    <form
      className="space-y-2 rounded-md border p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit({ label, body })
      }}
    >
      <div className="space-y-1">
        <Input
          value={label}
          maxLength={LABEL_MAX}
          aria-label="Note label"
          placeholder="Release command"
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground tabular-nums">
          {label.length}/{LABEL_MAX}
        </p>
      </div>
      <div className="space-y-1">
        <Textarea
          value={body}
          maxLength={BODY_MAX}
          aria-label="Note body"
          placeholder="pnpm release 0.2.5"
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground tabular-nums">
          {body.length}/{BODY_MAX}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button type="submit" size="sm" disabled={!valid || busy}>
          <Check /> {save}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          <X /> Cancel
        </Button>
      </div>
    </form>
  )
}
