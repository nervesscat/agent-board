import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { FolderGit2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { InstructionsHistory, instructionChangesKey } from '#/components/InstructionsHistory'
import { LayoutEditor } from '#/components/LayoutEditor'
import { ListInput } from '#/components/ListInput'
import { Markdown } from '#/components/Markdown'
import { RichEditor } from '#/components/RichEditor'
import { RunsSettings } from '#/components/RunsSettings'
import { StagesEditor } from '#/components/StagesEditor'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Tip } from '#/components/ui/tooltip'
import { errorMessage, patch } from '#/lib/api'
import { STALL_MINUTES } from '#/lib/constants'
import { useProject } from '#/lib/project'
import { useAnchor, useReveal } from '#/lib/reveal'
import { DEFAULT_TAG_SUGGESTIONS, cleanSuggestions } from '#/lib/tags'
import { addTasks } from '#/lib/tasks'

export const Route = createFileRoute('/projects/$id/settings')({ component: Settings })

function Settings() {
  const { id } = Route.useParams()
  const { data: p } = useProject(id)
  // A link into a section (#layout, #instructions-history) lands on it on an in-app navigation too.
  useReveal(useAnchor(), { page: id, ready: p !== undefined })
  if (!p) return null
  return (
    <div className="space-y-10">
      <div className="max-w-3xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Instructions</h1>
          <p className="text-sm text-muted-foreground">
            What every agent reads (via <code className="rounded bg-muted px-1">get_project</code>) before
            working here: conventions, how to run things, what never to do. They apply to all its repos. You
            and an orchestrator agent change them; every change is kept below.
          </p>
        </div>
        {/* A new editor per project: an edit never follows the page to another one. */}
        <Instructions key={id} projectId={id} saved={p.instructions} />
        <div className="space-y-1 text-right text-sm">
          <ul className="space-y-0.5">
            {p.repos.map((r) => (
              <Tip key={r.id} content={r.repoPath}>
                <li className="flex items-center justify-end gap-1.5 text-muted-foreground">
                  <FolderGit2 className="size-3.5 shrink-0" />
                  <span className="font-mono text-xs">{r.githubRepo ?? r.repoPath}</span>
                </li>
              </Tip>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Repos:{' '}
            <Link to="/projects/$id/repositories" params={{ id }} className="underline hover:text-foreground">
              Repositories page
            </Link>
            . Rename or delete the project: project menu → Manage projects.
          </p>
        </div>
        <InstructionsHistory key={`history-${id}`} projectId={id} />
      </div>
      <DefaultPhases key={id} projectId={id} saved={p.defaultPhases} />
      <TagSuggestions key={`tags-${id}`} projectId={id} saved={p.tagSuggestions} />
      <StallMinutes key={`stall-${id}`} projectId={id} saved={p.stallMinutes} />
      <StagesEditor projectId={id} />
      <RunsSettings projectId={id} />
      <LayoutEditor key={`layout-${id}`} projectId={id} saved={p.layout} />
    </div>
  )
}

const always = () => true

/**
 * The top-level phases every new ticket of the project starts with, in order: the list in effect
 * (the built-in one until it is changed). Emptying it seeds nothing; the built-in list can be had back.
 * Agents read it in `get_project` and change the phases per ticket.
 */
function DefaultPhases({ projectId, saved }: { projectId: string; saved: string[] }) {
  const qc = useQueryClient()
  const [items, setItems] = useState(saved)
  const [text, setText] = useState('')
  // What Save would store: the list with what is typed and not yet added.
  const phases = addTasks(items, text)
  const dirty = phases.join('\n') !== saved.join('\n')
  const save = useMutation({
    mutationFn: (defaultPhases: string[] | null) =>
      patch<{ defaultPhases: string[] }>(`/api/projects/${projectId}`, { defaultPhases }),
    onSuccess: async (row) => {
      setItems(row.defaultPhases)
      setText('')
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section aria-label="Default phases" className="max-w-3xl space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Default phases</h2>
        <p className="text-sm text-muted-foreground">
          The top-level tasks every new ticket starts with, in order. The tasks given when it is created go
          under the first; a lane starts without them. Agents tick each as they finish it, and remove or
          reword the ones that do not fit. Leave it empty to start tickets with no tasks.
        </p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(phases)
        }}
      >
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">No phases: new tickets start with no tasks.</p>
        )}
        <Label htmlFor="default-phases-new" className="sr-only">
          New phase
        </Label>
        <ListInput
          id="default-phases-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label="Default phases"
          placeholder="Add a phase"
          addLabel="Add phase"
          reorderable
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? 'Unsaved changes.' : 'No changes.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Use the built-in list
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * The tags offered as chips under every ticket's tags field, before the ones the
 * project's tickets carry. Emptying it offers none of its own; the defaults can be had back.
 */
function TagSuggestions({ projectId, saved }: { projectId: string; saved: string[] }) {
  const qc = useQueryClient()
  const [items, setItems] = useState(saved)
  const [text, setText] = useState('')
  // What Save would store: the list with what is typed and not yet added, trimmed, repeats left out.
  const tags = cleanSuggestions(addTasks(items, text))
  const dirty = tags.join('\n') !== saved.join('\n')
  const save = useMutation({
    mutationFn: (tagSuggestions: string[]) =>
      patch<{ tagSuggestions: string[] }>(`/api/projects/${projectId}`, { tagSuggestions }),
    onSuccess: async (row) => {
      setItems(row.tagSuggestions)
      setText('')
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section aria-label="Tag suggestions" className="max-w-3xl space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Tag suggestions</h2>
        <p className="text-sm text-muted-foreground">
          The tags offered as chips under a ticket&apos;s tags, followed by the tags its tickets already
          carry. Agents read them in <code className="rounded bg-muted px-1">get_project</code> and reuse
          them. Leave it empty to offer only the tags in use.
        </p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(tags)
        }}
      >
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions: only the tags in use are offered.</p>
        )}
        <Label htmlFor="tag-suggestions-new" className="sr-only">
          New tag
        </Label>
        <ListInput
          id="tag-suggestions-new"
          value={items}
          onChange={setItems}
          text={text}
          onTextChange={setText}
          label="Tag suggestions"
          placeholder="Add a tag"
          addLabel="Add tag"
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {dirty ? 'Unsaved changes.' : 'No changes.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate([...DEFAULT_TAG_SUGGESTIONS])}
          >
            Use the defaults
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * How long a ticket in an active stage may go without an event on its work timeline (a heartbeat, a
 * span, a wait, a push…) before it reads as stalled, on its card, on the Roadmap and in Needs you.
 */
function StallMinutes({ projectId, saved }: { projectId: string; saved: number }) {
  const qc = useQueryClient()
  const [text, setText] = useState(String(saved))
  const minutes = Number(text)
  const valid = Number.isInteger(minutes) && minutes >= STALL_MINUTES.min && minutes <= STALL_MINUTES.max
  const dirty = valid && minutes !== saved
  const save = useMutation({
    mutationFn: (stallMinutes: number) =>
      patch<{ stallMinutes: number }>(`/api/projects/${projectId}`, { stallMinutes }),
    onSuccess: async (row) => {
      setText(String(row.stallMinutes))
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <section aria-label="Stalled tickets" className="max-w-3xl space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Stalled tickets</h2>
        <p className="text-sm text-muted-foreground">
          A ticket in an active stage reads as stalled once its agents have recorded nothing on its work
          timeline (a heartbeat, a span, a wait, a hand-off) and the board has seen nothing of it (a push, its
          PR, its preview) for this long. Agents keep it off by sending a heartbeat every few minutes.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && !save.isPending) save.mutate(minutes)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="stall-minutes">Stalled after (minutes)</Label>
          <Input
            id="stall-minutes"
            type="number"
            inputMode="numeric"
            min={STALL_MINUTES.min}
            max={STALL_MINUTES.max}
            step={1}
            className="w-32"
            value={text}
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {valid
            ? dirty
              ? 'Unsaved changes.'
              : 'No changes.'
            : `A whole number from ${STALL_MINUTES.min} to ${STALL_MINUTES.max}.`}
        </span>
      </form>
    </section>
  )
}

/**
 * The project's instructions, edited in place like a ticket's: they read as rendered markdown, and
 * the editor stores markdown, which is what agents get. Unsaved changes are not lost by accident:
 * Cancel, Esc, leaving the page or closing the tab ask first.
 */
function Instructions({ projectId, saved }: { projectId: string; saved: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(saved)
  const [asking, setAsking] = useState(false)
  const dirty = editing && body !== saved
  const blocker = useBlocker({
    shouldBlockFn: always,
    disabled: !dirty,
    enableBeforeUnload: true,
    withResolver: true,
  })
  const save = useMutation({
    mutationFn: (instructions: string) => patch(`/api/projects/${projectId}`, { instructions }),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: instructionChangesKey(projectId) })
      // Back to reading once the saved text is the one shown.
      await qc.invalidateQueries({ queryKey: ['project', projectId] })
      setEditing(false)
      toast.success('Saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const open = () => {
    setBody(saved)
    setEditing(true)
  }
  const submit = () => {
    if (save.isPending) return
    if (body === saved) setEditing(false)
    else save.mutate(body)
  }
  const cancel = () => {
    if (dirty) setAsking(true)
    else setEditing(false)
  }
  const stay = () => {
    setAsking(false)
    blocker.reset?.()
  }
  const discard = () => {
    setAsking(false)
    setEditing(false)
    blocker.proceed?.()
  }
  return (
    <section aria-label="Project instructions" className="space-y-2">
      <div className="flex items-center gap-3">
        <Label>Project instructions</Label>
        {!editing && (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={open}>
            <Pencil data-icon="inline-start" /> edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <RichEditor
            value={body}
            onChange={setBody}
            onSubmit={submit}
            onCancel={cancel}
            autoFocus
            minHeight="min-h-64"
            label="Project instructions"
            placeholder="How to run the repos, the conventions to follow, what never to do."
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {dirty ? 'Unsaved changes. Ctrl/⌘+Enter saves.' : 'No changes.'}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : saved ? (
        // Clicking the text edits it; a link inside still opens.
        <Tip content="Click to edit">
          <div
            role="button"
            tabIndex={0}
            className="cursor-text rounded-md border p-4 hover:bg-muted/30"
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('a, img')) open()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') open()
            }}
          >
            <Markdown>{saved}</Markdown>
          </div>
        </Tip>
      ) : (
        <button
          type="button"
          onClick={open}
          className="w-full rounded-md border border-dashed p-4 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          No instructions yet. Click to write them.
        </button>
      )}
      <AlertDialog
        open={asking || blocker.status === 'blocked'}
        onOpenChange={(isOpen) => {
          if (!isOpen) stay()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The project instructions have unsaved changes. Agents keep reading the saved ones.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
